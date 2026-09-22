const db = require('../db');
const { now, genNo } = require('../util');
const { audit, addVersion, notify } = require('../auth');

const INST_STATUS_CN = {
  registered: '已登记', washing: '清洗中', packaged: '已包装',
  sterilized_pending: '待监测', in_stock: '在库可发放',
  in_transit: '在途', at_clinic: '已到诊所', in_use: '使用中',
  frozen_recall: '冻结召回中', returned_rewash: '退回待重处理',
  scrapped: '报废',
};

function getStBatch(id) {
  return db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(id);
}

function setInstrumentStatus(instrumentId, status, patch = {}) {
  const fields = ['current_status=?'];
  const vals = [status];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(instrumentId);
  db.prepare(`UPDATE instruments SET ${fields.join(',')} WHERE id=?`).run(...vals);
}

// 生物监测阳性：立即锁定批次 + 冻结全部器械 + 召回 + 不合格处置单
function lockBatchPositive(stbatchId, user, note) {
  const b = getStBatch(stbatchId);
  if (!b) throw new Error('灭菌批次不存在');
  if (b.status === 'locked' || b.status === 'failed') throw new Error('该批次已被锁定');

  const tx = db.tx(() => {
    addVersion(user, 'sterilization_batch', stbatchId, 'biological_result', b.biological_result, 'positive',
      note || '生物监测结果录入为阳性');
    addVersion(user, 'sterilization_batch', stbatchId, 'status', b.status, 'locked',
      '生物监测阳性，系统自动锁定');

    db.prepare(`UPDATE sterilization_batches
      SET biological_result='positive', bio_result_at=?, status='locked', frozen_at=?, freeze_reason=?
      WHERE id=?`).run(now(), now(), '生物监测阳性', stbatchId);

    // 不合格处置单
    const ncNo = genNo('NC');
    const info = db.prepare(`INSERT INTO nonconformances(nc_no,stbatch_id,reason_type,description,status,created_by,created_at)
      VALUES(?,?,?,?, 'open', ?, ?)`).run(
      ncNo, stbatchId, '生物监测阳性',
      `批次 ${b.batch_no} 生物监测结果为阳性，全部器械冻结召回，待原因分析与重新清洗灭菌。`,
      user.id, now());
    const ncId = Number(info.lastInsertRowid);
    db.prepare('UPDATE sterilization_batches SET nc_id=? WHERE id=?').run(ncId, stbatchId);

    // 召回任务
    const recallNo = genNo('RC');
    const rinfo = db.prepare(`INSERT INTO recalls(recall_no,stbatch_id,reason,triggered_by,status,created_at)
      VALUES(?,?,?,?,'active',?)`).run(recallNo, stbatchId, '生物监测阳性（嗜热脂肪杆菌芽孢培养阳性）', user.id, now());
    const recallId = Number(rinfo.lastInsertRowid);
    db.prepare('UPDATE nonconformances SET recall_id=? WHERE id=?').run(recallId, ncId);

    const items = db.prepare('SELECT instrument_id FROM sterilization_items WHERE stbatch_id=?').all(stbatchId);
    let dispatched = 0;
    let inStock = 0;
    const clinicsNotified = new Set();

    for (const it of items) {
      const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
      // 最近一次发放明细
      const distRow = db.prepare(`
        SELECT d.*, di.id AS di_id
        FROM distribution_items di
        JOIN distributions d ON d.id = di.distribution_id
        WHERE di.instrument_id=? AND d.stbatch_id=?
          AND d.status IN ('in_transit','received','frozen')
        ORDER BY d.id DESC LIMIT 1`).get(it.instrument_id, stbatchId);

      let clinicId = null;
      let snapshot;
      if (distRow) {
        clinicId = distRow.clinic_id;
        snapshot = distRow.status === 'received' ? 'at_clinic' : 'in_transit';
        dispatched++;
        db.prepare("UPDATE distributions SET status='frozen' WHERE id=?").run(distRow.distribution_id == null ? distRow.id : distRow.id);
        // 通知该诊所全部诊所端用户
        const cusers = db.prepare('SELECT id FROM users WHERE role=\'clinic\' AND clinic_id=? AND active=1').all(clinicId);
        for (const cu of cusers) {
          notify(cu.id, clinicId, 'recall',
            `【紧急召回】灭菌批次 ${b.batch_no} 生物监测阳性`,
            `器械 ${inst.udi}（${inst.name}）已被冻结，立即停止使用并等待召回。`,
            'recall', recallId);
        }
        clinicsNotified.add(clinicId);
      } else {
        snapshot = 'in_stock';
        inStock++;
      }

      db.prepare(`INSERT INTO recall_items(recall_id,instrument_id,clinic_id,location_snapshot,notified,notified_at,return_status)
        VALUES(?,?,?,?,?,?, 'pending')`).run(
        recallId, it.instrument_id, clinicId, snapshot,
        distRow ? 1 : 0, distRow ? now() : null);

      addVersion(user, 'instrument', it.instrument_id, 'current_status',
        inst.current_status, 'frozen_recall', '所属灭菌批次生物监测阳性，冻结');
      setInstrumentStatus(it.instrument_id, 'frozen_recall', { current_clinic_id: clinicId });
    }

    audit(user, 'BIO_POSITIVE_LOCK', 'sterilization_batch', stbatchId, {
      batch_no: b.batch_no, total: items.length, dispatched, in_stock: inStock,
      clinics: [...clinicsNotified], recall_id: recallId, nc_id: ncId, note,
    });

    return { recallId, ncId, total: items.length, dispatched, inStock, clinics: [...clinicsNotified] };
  });

  return tx();
}

// 追溯方向一：UDI 反查全部批次/监测/去向/使用
function traceByUdi(udi) {
  const inst = db.prepare('SELECT * FROM instruments WHERE udi=?').get(String(udi).trim());
  if (!inst) return null;

  const lifecycle = db.prepare(`
    SELECT sb.id AS stbatch_id, sb.batch_no, sb.status, sb.sterilizer_no, sb.started_at,
           sb.chemical_result, sb.biological_result, sb.bio_result_at, sb.early_release,
           r.decision AS release_decision, r.reviewed_at AS release_at,
           ur.real_name AS reviewer_name,
           w.batch_no AS wash_no, w.equipment_no, w.program, w.temperature_c, w.duration_min,
           p.package_no, p.package_name
    FROM sterilization_items si
    JOIN sterilization_batches sb ON sb.id = si.stbatch_id
    LEFT JOIN packages p ON p.id = sb.package_id
    LEFT JOIN wash_batches w ON w.id = p.wash_batch_id
    LEFT JOIN releases r ON r.stbatch_id = sb.id AND r.id =
      (SELECT MAX(id) FROM releases WHERE stbatch_id=sb.id)
    LEFT JOIN users ur ON ur.id = r.reviewer_id
    WHERE si.instrument_id=?
    ORDER BY sb.id DESC
  `).all(inst.id);

  const movements = db.prepare(`
    SELECT d.dist_no, d.status AS dist_status, d.handover_person, d.distributed_at,
           d.clinic_confirmed_at, d.early_release,
           c.id AS clinic_id, c.name AS clinic_name,
           (SELECT MIN(u.used_at) FROM usages u WHERE u.distribution_id=d.id AND u.instrument_id=?) AS first_used_at
    FROM distribution_items di
    JOIN distributions d ON d.id = di.distribution_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE di.instrument_id=?
    ORDER BY d.id DESC
  `).all(inst.id, inst.id);

  const usages = db.prepare(`
    SELECT u.*, c.name AS clinic_name FROM usages u
    JOIN clinics c ON c.id=u.clinic_id
    WHERE u.instrument_id=? ORDER BY u.id DESC LIMIT 50
  `).all(inst.id);

  const recalls = db.prepare(`
    SELECT rc.*, ri.return_status, ri.returned_at, ri.location_snapshot
    FROM recall_items ri JOIN recalls rc ON rc.id=ri.recall_id
    WHERE ri.instrument_id=? ORDER BY rc.id DESC
  `).all(inst.id);

  return { inst, lifecycle, movements, usages, recalls };
}

// 追溯方向二：灭菌批次正查全部器械/去向/使用
function traceByBatch(stbatchId) {
  const b = getStBatch(stbatchId);
  if (!b) return null;
  const clinicRows = db.prepare(`
    SELECT si.instrument_id, i.udi, i.name, i.spec,
           c.id AS clinic_id, c.name AS clinic_name,
           d.id AS distribution_id, d.dist_no, d.status AS dist_status,
           d.handover_person, d.distributed_at, d.clinic_confirmed_at,
           (SELECT MIN(u.used_at) FROM usages u WHERE u.instrument_id=si.instrument_id AND u.distribution_id=d.id) AS first_used_at,
           ri.return_status, ri.location_snapshot
    FROM sterilization_items si
    JOIN instruments i ON i.id=si.instrument_id
    LEFT JOIN distribution_items di ON di.instrument_id=si.instrument_id AND di.distribution_id IN
      (SELECT id FROM distributions WHERE stbatch_id=? )
    LEFT JOIN distributions d ON d.id=di.distribution_id
    LEFT JOIN clinics c ON c.id=d.clinic_id
    LEFT JOIN recall_items ri ON ri.instrument_id=si.instrument_id AND ri.recall_id IN
      (SELECT id FROM recalls WHERE stbatch_id=?)
    WHERE si.stbatch_id=?
    ORDER BY d.id, i.udi
  `).all(stbatchId, stbatchId, stbatchId);

  const monitorings = db.prepare(`
    SELECT m.*, u.real_name AS tester_name FROM monitorings m
    LEFT JOIN users u ON u.id=m.tested_by
    WHERE m.stbatch_id=? ORDER BY m.id
  `).all(stbatchId);

  const release = db.prepare(`
    SELECT r.*, u.real_name AS reviewer_name FROM releases r
    LEFT JOIN users u ON u.id=r.reviewer_id
    WHERE r.stbatch_id=? ORDER BY r.id DESC LIMIT 1`).get(stbatchId);

  const recall = db.prepare('SELECT * FROM recalls WHERE stbatch_id=? ORDER BY id DESC LIMIT 1').get(stbatchId);
  const nc = db.prepare('SELECT * FROM nonconformances WHERE stbatch_id=? ORDER BY id DESC LIMIT 1').get(stbatchId);

  return { batch: b, items: clinicRows, monitorings, release, recall, nc };
}

module.exports = { INST_STATUS_CN, getStBatch, setInstrumentStatus, lockBatchPositive, traceByUdi, traceByBatch };
