const db = require('../db');
const { requireRole, audit, addVersion } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

function batchDetail(id) {
  const b = db.prepare(`SELECT sb.*, u.real_name AS operator_name, p.package_no, p.package_name
    FROM sterilization_batches sb JOIN users u ON u.id=sb.operator_id
    LEFT JOIN packages p ON p.id=sb.package_id WHERE sb.id=?`).get(id);
  if (!b) return null;
  b.items = db.prepare(`SELECT si.instrument_id, i.udi, i.name, i.spec, i.current_status
    FROM sterilization_items si JOIN instruments i ON i.id=si.instrument_id
    WHERE si.stbatch_id=? ORDER BY i.udi`).all(id);
  return b;
}

module.exports = async function sterileRoutes(req, res, path) {
  if (path === '/api/st-batches' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const status = q.get('status') || '';
    const rows = db.prepare(`SELECT sb.*, u.real_name AS operator_name, p.package_name,
      (SELECT COUNT(*) FROM sterilization_items si WHERE si.stbatch_id=sb.id) AS item_count,
      (SELECT real_name FROM users WHERE id=(SELECT reviewer_id FROM releases r WHERE r.stbatch_id=sb.id ORDER BY id DESC LIMIT 1)) AS reviewer_name
      FROM sterilization_batches sb JOIN users u ON u.id=sb.operator_id
      LEFT JOIN packages p ON p.id=sb.package_id
      WHERE (?='' OR sb.status=?) ORDER BY sb.id DESC`).all(status, status);
    return ok(res, rows);
  }

  const gm = path.match(/^\/api\/st-batches\/(\d+)$/);
  if (gm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const detail = batchDetail(gm[1]);
    if (!detail) return fail(res, 404, '灭菌批次不存在');
    detail.monitorings = db.prepare('SELECT * FROM monitorings WHERE stbatch_id=? ORDER BY id').all(detail.id);
    return ok(res, detail);
  }

  // 登记灭菌批次：灭菌器编号、批次号、装载图、参数
  if (path === '/api/st-batches' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.package_id || !b.sterilizer_no) return fail(res, 400, '灭菌器编号与待灭菌包必填');

    const tx = db.tx(() => {
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(b.package_id);
      if (!pkg) throw new Error('包装记录不存在');
      const dup = db.prepare('SELECT id FROM sterilization_batches WHERE package_id=? AND status IN (\'pending_monitor\',\'released\')').get(b.package_id);
      if (dup) throw new Error('该包已有在途灭菌批次');

      const batchNo = genNo('MJ');
      const info = db.prepare(`INSERT INTO sterilization_batches(batch_no,package_id,sterilizer_no,load_diagram,program,param_temp,param_pressure,param_hold_min,param_dry_min,operator_id,started_at,ended_at,chemical_result,biological_result,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending','pending_monitor',?)`).run(
        batchNo, b.package_id, b.sterilizer_no, b.load_diagram || '', b.program || '',
        b.param_temp || null, b.param_pressure || null, b.param_hold_min || null, b.param_dry_min || null,
        user.id, b.started_at || now(), b.ended_at || now(), now());
      const sid = Number(info.lastInsertRowid);
      const items = db.prepare('SELECT instrument_id FROM package_items WHERE package_id=?').all(b.package_id);
      for (const it of items) {
        db.prepare('INSERT INTO sterilization_items(stbatch_id,package_id,instrument_id) VALUES(?,?,?)').run(sid, b.package_id, it.instrument_id);
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
        addVersion(user, 'instrument', it.instrument_id, 'current_status', inst.current_status, 'sterilized_pending', `装入灭菌批次 ${batchNo}`);
        trace.setInstrumentStatus(it.instrument_id, 'sterilized_pending', { current_stbatch_id: sid });
      }
      db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,note,created_at) VALUES(?, 'chemical','pending','化学指示卡/包外指示物', ?)`)
        .run(sid, now());
      db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,sample_no,note,created_at) VALUES(?, 'biological','pending',?, '嗜热脂肪杆菌芽孢菌片培养', ?)`)
        .run(sid, b.bio_sample_no || '', now());
      audit(user, 'CREATE', 'sterilization_batch', sid, { batch_no: batchNo, sterilizer: b.sterilizer_no, items: items.length });
      return { id: sid, batchNo };
    });
    try { return ok(res, tx()); } catch (e) { return fail(res, 400, e.message); }
  }

  // 录入化学监测
  const cm = path.match(/^\/api\/st-batches\/(\d+)\/chemical$/);
  if (cm && req.method === 'POST') {
    const user = requireRole(req, res, ['operator', 'reviewer']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!['pass', 'fail'].includes(b.result)) return fail(res, 400, '化学监测结果非法');
    const sb = trace.getStBatch(cm[1]);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (sb.status === 'locked' || sb.status === 'failed') return fail(res, 400, '批次已锁定/不合格，不能录入');
    const tx = db.tx(() => {
      addVersion(user, 'sterilization_batch', sb.id, 'chemical_result', sb.chemical_result, b.result, b.reason || '化学监测结果录入');
      db.prepare("UPDATE sterilization_batches SET chemical_result=? WHERE id=?").run(b.result, sb.id);
      db.prepare("UPDATE monitorings SET result=?, tested_by=?, tested_at=?, note=? WHERE stbatch_id=? AND monitor_type='chemical'")
        .run(b.result, user.id, now(), b.note || '', sb.id);
      audit(user, 'MONITOR_CHEMICAL', 'sterilization_batch', sb.id, { result: b.result });
    })();
    return ok(res, {});
  }

  // 录入生物监测结果（核心控制点）
  const bm = path.match(/^\/api\/st-batches\/(\d+)\/biological$/);
  if (bm && req.method === 'POST') {
    const user = requireRole(req, res, ['operator', 'reviewer']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!['negative', 'positive'].includes(b.result)) return fail(res, 400, '生物监测结果非法');
    const sb = trace.getStBatch(bm[1]);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (sb.status === 'locked' || sb.status === 'failed') return fail(res, 400, '批次已锁定');

    if (b.result === 'positive') {
      const r = trace.lockBatchPositive(sb.id, user, b.note);
      return ok(res, { locked: true, ...r });
    }
    const tx = db.tx(() => {
      addVersion(user, 'sterilization_batch', sb.id, 'biological_result', sb.biological_result, 'negative', b.note || '生物监测合格');
      db.prepare("UPDATE sterilization_batches SET biological_result='negative', bio_result_at=?, bio_sample_no=? WHERE id=?")
        .run(now(), b.sample_no || sb.bio_sample_no || '', sb.id);
      db.prepare("UPDATE monitorings SET result='negative', sample_no=?, tested_by=?, tested_at=?, note=? WHERE stbatch_id=? AND monitor_type='biological'")
        .run(b.sample_no || '', user.id, now(), b.note || '', sb.id);
      audit(user, 'MONITOR_BIOLOGICAL', 'sterilization_batch', sb.id, { result: 'negative' });
    })();
    return ok(res, { locked: false });
  }

  return false;
};
