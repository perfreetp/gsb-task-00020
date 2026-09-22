const db = require('../db');
const { requireRole, audit, addVersion, notify } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

module.exports = async function qualityRoutes(req, res, path) {
  // 召回列表
  if (path === '/api/recalls' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = db.prepare(`SELECT rc.*, sb.batch_no AS stbatch_no,
      (SELECT COUNT(*) FROM recall_items ri WHERE ri.recall_id=rc.id) AS total,
      (SELECT COUNT(*) FROM recall_items ri WHERE ri.recall_id=rc.id AND ri.return_status='returned') AS returned
      FROM recalls rc JOIN sterilization_batches sb ON sb.id=rc.stbatch_id
      ORDER BY rc.id DESC`).all();
    return ok(res, user.role === 'clinic'
      ? rows.filter((r) => db.prepare('SELECT id FROM recall_items WHERE recall_id=? AND clinic_id=?').get(r.id, user.clinic_id))
      : rows);
  }

  const rgm = path.match(/^\/api\/recalls\/(\d+)$/);
  if (rgm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rc = db.prepare(`SELECT rc.*, sb.batch_no AS stbatch_no, sb.sterilizer_no
      FROM recalls rc JOIN sterilization_batches sb ON sb.id=rc.stbatch_id WHERE rc.id=?`).get(rgm[1]);
    if (!rc) return fail(res, 404, '召回任务不存在');
    rc.items = db.prepare(`SELECT ri.*, i.udi, i.name, c.name AS clinic_name
      FROM recall_items ri JOIN instruments i ON i.id=ri.instrument_id
      LEFT JOIN clinics c ON c.id=ri.clinic_id WHERE ri.recall_id=? ORDER BY ri.id`).all(rc.id);
    rc.nc = db.prepare('SELECT * FROM nonconformances WHERE recall_id=?').get(rc.id);
    if (user.role === 'clinic' && !rc.items.some((i) => i.clinic_id === user.clinic_id)) return fail(res, 403, '无权查看');
    return ok(res, rc);
  }

  // 器械退回登记（诊所或操作员）
  const rtm = path.match(/^\/api\/recalls\/(\d+)\/items\/(\d+)\/return$/);
  if (rtm && req.method === 'POST') {
    const user = requireRole(req, res, ['clinic', 'operator']);
    if (!user) return;
    const ri = db.prepare('SELECT * FROM recall_items WHERE id=? AND recall_id=?').get(rtm[2], rtm[1]);
    if (!ri) return fail(res, 404, '召回明细不存在');
    if (user.role === 'clinic' && ri.clinic_id !== user.clinic_id) return fail(res, 403, '无权操作');
    db.prepare("UPDATE recall_items SET return_status='returned', returned_at=? WHERE id=?").run(now(), ri.id);
    const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(ri.instrument_id);
    addVersion(user, 'instrument', ri.instrument_id, 'current_status', inst.current_status, 'returned_rewash', '召回器械退回，待重新清洗灭菌');
    trace.setInstrumentStatus(ri.instrument_id, 'returned_rewash', { current_clinic_id: null });
    audit(user, 'RECALL_RETURN', 'recall_item', ri.id, {});
    return ok(res, {});
  }

  // 不合格处置单列表/详情
  if (path === '/api/ncs' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT nc.*, sb.batch_no AS stbatch_no, rc.recall_no,
      u.real_name AS creator_name, (SELECT COUNT(*) FROM sterilization_items WHERE stbatch_id=nc.stbatch_id) AS item_count
      FROM nonconformances nc JOIN sterilization_batches sb ON sb.id=nc.stbatch_id
      LEFT JOIN recalls rc ON rc.id=nc.recall_id
      LEFT JOIN users u ON u.id=nc.created_by ORDER BY nc.id DESC`).all();
    return ok(res, rows);
  }
  const ngm = path.match(/^\/api\/ncs\/(\d+)$/);
  if (ngm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const nc = db.prepare(`SELECT nc.*, sb.batch_no AS stbatch_no FROM nonconformances nc
      JOIN sterilization_batches sb ON sb.id=nc.stbatch_id WHERE nc.id=?`).get(ngm[1]);
    if (!nc) return fail(res, 404, '处置单不存在');
    return ok(res, nc);
  }

  // 原因分析与整改措施（督导员）
  const nam = path.match(/^\/api\/ncs\/(\d+)\/analysis$/);
  if (nam && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.root_cause) return fail(res, 400, '原因分析必填');
    const nc = db.prepare('SELECT * FROM nonconformances WHERE id=?').get(nam[1]);
    if (!nc) return fail(res, 404, '处置单不存在');
    addVersion(user, 'nonconformance', nc.id, 'root_cause', nc.root_cause, b.root_cause, b.reason || '填写原因分析');
    db.prepare("UPDATE nonconformances SET root_cause=?, correction=?, status='reprocessing' WHERE id=?")
      .run(b.root_cause, b.correction || nc.correction || '', nc.id);
    audit(user, 'NC_ANALYSIS', 'nonconformance', nc.id, { root_cause: b.root_cause, correction: b.correction });
    return ok(res, {});
  }

  // 重新清洗灭菌（操作员）：一键生成 清洗→包装→灭菌 再处理链
  const rpm = path.match(/^\/api\/st-batches\/(\d+)\/reprocess$/);
  if (rpm && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    const tx = db.tx(() => {
      const sb = trace.getStBatch(rpm[1]);
      if (!sb) throw new Error('灭菌批次不存在');
      if (sb.status !== 'locked') throw new Error('只有锁定批次可以重新处理');
      const nc = db.prepare('SELECT * FROM nonconformances WHERE stbatch_id=? ORDER BY id DESC LIMIT 1').get(sb.id);
      const items = db.prepare('SELECT instrument_id FROM sterilization_items WHERE stbatch_id=?').all(sb.id);

      // 全部召回明细标记退回（在库件 na）
      const recall = db.prepare('SELECT * FROM recalls WHERE stbatch_id=? ORDER BY id DESC LIMIT 1').get(sb.id);
      if (recall) {
        for (const ri of db.prepare('SELECT * FROM recall_items WHERE recall_id=?').all(recall.id)) {
          if (ri.return_status === 'pending') {
            db.prepare("UPDATE recall_items SET return_status=?, returned_at=? WHERE id=?"
              ).run(ri.location_snapshot === 'in_stock' ? 'na' : 'returned', now(), ri.id);
          }
        }
      }
      for (const it of items) {
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
        trace.setInstrumentStatus(it.instrument_id, 'returned_rewash', { current_clinic_id: null });
      }

      // 1) 重新清洗
      const washNo = genNo('QX');
      const wi = db.prepare(`INSERT INTO wash_batches(batch_no,source_stbatch_id,equipment_no,program,temperature_c,duration_min,chemical,operator_id,started_at,ended_at,status,note,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?, 'rewash', '召回后重新清洗消毒', ?)`).run(
        washNo, sb.id, b.equipment_no, b.program || '标准重处理程序', b.temperature_c ?? 93,
        b.duration_min || 10, b.chemical || '', user.id, now(), now(), now());
      const washId = Number(wi.lastInsertRowid);
      for (const it of items) db.prepare('INSERT INTO wash_items(wash_batch_id,instrument_id,result,note) VALUES(?,?,\'rewash\',\'召回重处理\')').run(washId, it.instrument_id);

      // 2) 重新包装（UDI 不变，沿用原包名）
      const oldPkg = db.prepare('SELECT * FROM packages WHERE id=?').get(sb.package_id);
      const pkgNo = genNo('BZ');
      const pi = db.prepare(`INSERT INTO packages(package_no,wash_batch_id,package_name,package_type,sterilization_method,packer_id,packed_at,note,created_at)
        VALUES(?,?,?,?,?,?,?, '召回后重新包装', ?)`).run(pkgNo, washId, oldPkg.package_name + '(重处理)',
        oldPkg.package_type, b.sterilization_method || oldPkg.sterilization_method, user.id, now(), now());
      const pkgId = Number(pi.lastInsertRowid);
      for (const it of items) {
        db.prepare('INSERT INTO package_items(package_id,instrument_id,labeled_at) VALUES(?,?,?)').run(pkgId, it.instrument_id, now());
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
        trace.setInstrumentStatus(it.instrument_id, 'packaged');
      }

      // 3) 重新灭菌
      const stNo = genNo('MJ');
      const si = db.prepare(`INSERT INTO sterilization_batches(batch_no,package_id,sterilizer_no,load_diagram,program,param_temp,param_pressure,param_hold_min,param_dry_min,operator_id,started_at,ended_at,chemical_result,biological_result,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending','pending_monitor',?)`).run(
        stNo, pkgId, b.sterilizer_no, b.load_diagram || '', b.program2 || b.program || '标准灭菌程序',
        b.param_temp ?? 134, b.param_pressure ?? 0.21, b.param_hold_min ?? 4, b.param_dry_min ?? 8,
        user.id, now(), now(), now());
      const newSid = Number(si.lastInsertRowid);
      for (const it of items) {
        db.prepare('INSERT INTO sterilization_items(stbatch_id,package_id,instrument_id) VALUES(?,?,?)').run(newSid, pkgId, it.instrument_id);
        trace.setInstrumentStatus(it.instrument_id, 'sterilized_pending', { current_stbatch_id: newSid });
      }
      db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,note,created_at) VALUES(?, 'chemical','pending','重处理批次化学监测',?)`).run(newSid, now());
      db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,note,created_at) VALUES(?, 'biological','pending','重处理批次生物监测',?)`).run(newSid, now());

      if (nc) db.prepare('UPDATE nonconformances SET reprocess_stbatch_id=? WHERE id=?').run(newSid, nc.id);
      audit(user, 'REPROCESS', 'sterilization_batch', sb.id, { new_stbatch_id: newSid, wash_no: washNo, st_no: stNo });
      return { newStBatchId: newSid, newBatchNo: stNo };
    });
    try { return ok(res, tx()); } catch (e) { return fail(res, 400, e.message); }
  }

  // 专项检查列表
  if (path === '/api/inspections' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT ins.*, sb.batch_no AS stbatch_no, u.real_name AS initiator_name,
      c.real_name AS closer_name FROM inspections ins
      LEFT JOIN sterilization_batches sb ON sb.id=ins.stbatch_id
      LEFT JOIN users u ON u.id=ins.initiated_by
      LEFT JOIN users c ON c.id=ins.closed_by ORDER BY ins.id DESC`).all();
    return ok(res, rows);
  }
  const igm = path.match(/^\/api\/inspections\/(\d+)$/);
  if (igm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const ins = db.prepare('SELECT * FROM inspections WHERE id=?').get(igm[1]);
    if (!ins) return fail(res, 404, '检查记录不存在');
    return ok(res, ins);
  }
  if (path === '/api/inspections' && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.title) return fail(res, 400, '检查主题必填');
    const info = db.prepare(`INSERT INTO inspections(insp_no,stbatch_id,title,content,initiated_by,initiated_at,status,created_at)
      VALUES(?,?,?,?,?,?,'open',?)`).run(genNo('JC'), b.stbatch_id || null, b.title, b.content || '', user.id, now(), now());
    audit(user, 'INSPECTION_CREATE', 'inspection', info.lastInsertRowid, b);
    return ok(res, { id: Number(info.lastInsertRowid) });
  }
  const irm = path.match(/^\/api\/inspections\/(\d+)\/rectify$/);
  if (irm && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    const ins = db.prepare('SELECT * FROM inspections WHERE id=?').get(irm[1]);
    if (!ins) return fail(res, 404, '检查记录不存在');
    db.prepare("UPDATE inspections SET finding=?, rectification=?, status='rectifying' WHERE id=?")
      .run(b.finding || '', b.rectification || '', ins.id);
    addVersion(user, 'inspection', ins.id, 'rectification', ins.rectification, b.rectification || '', b.reason || '填写整改措施');
    audit(user, 'INSPECTION_RECTIFY', 'inspection', ins.id, b);
    return ok(res, {});
  }
  const icm = path.match(/^\/api\/inspections\/(\d+)\/close$/);
  if (icm && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    const ins = db.prepare('SELECT * FROM inspections WHERE id=?').get(icm[1]);
    if (!ins) return fail(res, 404, '检查记录不存在');
    db.prepare("UPDATE inspections SET status='closed', closed_by=?, closed_at=? WHERE id=?").run(user.id, now(), ins.id);
    audit(user, 'INSPECTION_CLOSE', 'inspection', ins.id, b);
    return ok(res, {});
  }

  return false;
};
