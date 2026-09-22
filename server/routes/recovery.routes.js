const db = require('../db');
const { requireRole, audit, notify } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

function pushDiscrepancyNotify(clinicId, batchNo, it, type, diffId) {
  const db = require('../db');
  const { notify } = require('../auth');
  const cusers = db.prepare("SELECT id FROM users WHERE role='clinic' AND clinic_id=? AND active=1").all(clinicId);
  for (const cu of cusers) {
    notify(cu.id, clinicId, 'discrepancy',
      `【差异确认】回收批次 ${batchNo} 存在${type === 'missing' ? '缺失' : '损坏/功能异常'}器械`,
      `${it.item_name}${it.udi_scanned ? '(' + it.udi_scanned + ')' : ''}：${it.damaged_desc || ''}，请确认。`,
      'discrepancy', diffId);
  }
}

module.exports = async function recoveryRoutes(req, res, path) {
  // 回收批次列表
  if (path === '/api/recovery-batches' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = db.prepare(`
      SELECT rb.*, c.name AS clinic_name, u.real_name AS receiver_name,
        (SELECT COUNT(*) FROM recovery_items ri WHERE ri.batch_id=rb.id) AS item_count,
        (SELECT COUNT(*) FROM discrepancies d WHERE d.recovery_batch_id=rb.id) AS diff_count
      FROM recovery_batches rb
      JOIN clinics c ON c.id=rb.clinic_id
      JOIN users u ON u.id=rb.receiver_id
      ${user.role === 'clinic' ? "WHERE rb.clinic_id=" + Number(user.clinic_id) : ''}
      ORDER BY rb.id DESC`).all();
    return ok(res, rows);
  }

  // 回收批次详情
  const getM = path.match(/^\/api\/recovery-batches\/(\d+)$/);
  if (getM && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rb = db.prepare(`SELECT rb.*, c.name AS clinic_name, u.real_name AS receiver_name
      FROM recovery_batches rb JOIN clinics c ON c.id=rb.clinic_id
      JOIN users u ON u.id=rb.receiver_id WHERE rb.id=?`).get(getM[1]);
    if (!rb) return fail(res, 404, '回收批次不存在');
    const items = db.prepare(`SELECT ri.*, i.udi FROM recovery_items ri
      LEFT JOIN instruments i ON i.id=ri.instrument_id WHERE ri.batch_id=? ORDER BY ri.id`).all(rb.id);
    const diffs = db.prepare(`SELECT d.*, u.real_name AS confirmer_name FROM discrepancies d
      LEFT JOIN users u ON u.id=d.confirmed_by WHERE d.recovery_batch_id=? ORDER BY d.id`).all(rb.id);
    return ok(res, { ...rb, items, diffs });
  }

  // 创建回收批次（按诊所+租赁单清点）
  if (path === '/api/recovery-batches' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.clinic_id || !b.recovered_at) return fail(res, 400, '诊所与回收时间必填');
    if (!Array.isArray(b.items) || b.items.length === 0) return fail(res, 400, '请至少登记一件器械');

    const tx = db.tx(() => {
      const batchNo = genNo('HS');
      const info = db.prepare(`INSERT INTO recovery_batches(batch_no,clinic_id,rental_order_id,recovered_at,receiver_id,location,note,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(batchNo, b.clinic_id, b.rental_order_id || null, b.recovered_at,
        user.id, b.location || '', b.note || '', now());
      const batchId = Number(info.lastInsertRowid);
      const diffs = [];

      const genUdi = () => {
        const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
        const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
        return `UDI${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${rand}`;
      };
      for (const it of b.items) {
        const qty = Math.max(1, it.quantity || 1);
        for (let n = 0; n < qty; n++) {
          // 缺失件只登记差异，不建实物档
          if (it.appearance_status === 'missing' && n === 0) {
            const dm = db.prepare(`INSERT INTO discrepancies(recovery_batch_id,clinic_id,rental_order_id,instrument_id,item_name,discrepancy_type,expected_qty,actual_qty,description,status,created_at)
              VALUES(?,?,?,?,?, 'missing', ?, 0, ?, 'pushed', ?)`).run(
              batchId, b.clinic_id, b.rental_order_id || null, null, it.item_name,
              it.expected_qty || qty, it.damaged_desc || '器械缺失', now());
            diffs.push(Number(dm.lastInsertRowid));
            db.prepare(`INSERT INTO recovery_items(batch_id,instrument_id,udi_scanned,item_name,quantity,appearance_status,function_status,damaged_desc,created_at)
              VALUES(?,?,?,?,1,'missing',?, ?,?)`).run(batchId, null, it.udi_scanned || null, it.item_name,
              it.function_status, it.damaged_desc || '', now());
            pushDiscrepancyNotify(b.clinic_id, batchNo, it, 'missing', Number(dm.lastInsertRowid));
            continue;
          }
          if (it.appearance_status === 'missing') continue;

          let instId = null;
          let udi = it.udi_scanned && n === 0 ? String(it.udi_scanned).trim() : '';
          if (udi) {
            const found = db.prepare('SELECT * FROM instruments WHERE udi=?').get(udi);
            if (found) instId = found.id;
          }
          if (!instId) {
            udi = udi || genUdi();
            const ni = db.prepare(`INSERT INTO instruments(udi,name,spec,category,current_status,label_printed,created_at)
              VALUES(?,?, '', '手术器械','registered', 0, ?)`).run(udi, it.item_name, now());
            instId = Number(ni.lastInsertRowid);
          }
          db.prepare(`INSERT INTO recovery_items(batch_id,instrument_id,udi_scanned,item_name,quantity,appearance_status,function_status,damaged_desc,created_at)
            VALUES(?,?,?,?,1,?,?,?,?)`).run(batchId, instId, udi, it.item_name,
            it.appearance_status, it.function_status, it.damaged_desc || '', now());

          const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(instId);
          trace.setInstrumentStatus(instId, 'registered', { current_clinic_id: null });
          require('../auth').addVersion(user, 'instrument', instId, 'current_status', inst.current_status, 'registered', '回收扫码登记');

          if (it.appearance_status === 'damaged' || it.function_status === 'abnormal') {
            const dm = db.prepare(`INSERT INTO discrepancies(recovery_batch_id,clinic_id,rental_order_id,instrument_id,item_name,discrepancy_type,expected_qty,actual_qty,description,status,created_at)
              VALUES(?,?,?,?,?, 'damaged', ?, ?, ?, 'pushed', ?)`).run(
              batchId, b.clinic_id, b.rental_order_id || null, instId, it.item_name,
              it.expected_qty || 1, 1, it.damaged_desc || '外观/功能异常', now());
            diffs.push(Number(dm.lastInsertRowid));
            pushDiscrepancyNotify(b.clinic_id, batchNo, { ...it, udi_scanned: udi }, 'damaged', Number(dm.lastInsertRowid));
          }
        }
      }
      audit(user, 'CREATE', 'recovery_batch', batchId, { batch_no: batchNo, items: b.items.length, diffs: diffs.length });
      return { batchId, batchNo, diffs };
    })();
    return ok(res, tx);
  }

  // 差异记录：诊所确认/异议
  const dm = path.match(/^\/api\/discrepancies\/(\d+)\/(confirm|dispute)$/);
  if (dm && req.method === 'POST') {
    const user = requireRole(req, res, ['clinic', 'operator', 'supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    const d = db.prepare('SELECT * FROM discrepancies WHERE id=?').get(dm[1]);
    if (!d) return fail(res, 404, '差异记录不存在');
    if (user.role === 'clinic' && d.clinic_id !== user.clinic_id) return fail(res, 403, '只能确认本诊所的差异');
    const status = dm[2] === 'confirm' ? 'confirmed' : 'disputed';
    db.prepare('UPDATE discrepancies SET status=?, clinic_feedback=?, confirmed_by=?, confirmed_at=? WHERE id=?')
      .run(status, b.feedback || '', user.id, now(), d.id);
    audit(user, status === 'confirmed' ? 'DISCREPANCY_CONFIRM' : 'DISCREPANCY_DISPUTE', 'discrepancy', d.id, b);
    return ok(res, {});
  }

  // 差异记录列表
  if (path === '/api/discrepancies' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = db.prepare(`SELECT d.*, c.name AS clinic_name, u.real_name AS confirmer_name,
      rb.batch_no AS recovery_batch_no
      FROM discrepancies d JOIN clinics c ON c.id=d.clinic_id
      JOIN recovery_batches rb ON rb.id=d.recovery_batch_id
      LEFT JOIN users u ON u.id=d.confirmed_by
      ${user.role === 'clinic' ? "WHERE d.clinic_id=" + Number(user.clinic_id) : ''}
      ORDER BY d.id DESC`).all();
    return ok(res, rows);
  }

  return false;
};
