const db = require('../db');
const { requireRole, audit, addVersion, notify } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

function closeReprocessChain(newSb, reviewer) {
  const nc = db.prepare('SELECT * FROM nonconformances WHERE reprocess_stbatch_id=?').get(newSb.id);
  if (!nc) return;
  const old = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(nc.stbatch_id);
  if (old) db.prepare("UPDATE sterilization_batches SET status='reprocessed' WHERE id=?").run(old.id);
  db.prepare("UPDATE nonconformances SET status='closed', closed_at=? WHERE id=?").run(now(), nc.id);
  db.prepare("UPDATE recalls SET status='completed', closed_at=? WHERE id=?").run(now(), nc.recall_id);
  audit(reviewer, 'REPROCESS_CHAIN_CLOSED', 'nonconformance', nc.id, {
    old_batch: old && old.batch_no, new_batch: newSb.batch_no });
}

module.exports = async function releaseRoutes(req, res, path) {
  // 放行/驳回 —— 只有审核人；生物监测未出结果禁止放行
  const rm = path.match(/^\/api\/st-batches\/(\d+)\/release$/);
  if (rm && req.method === 'POST') {
    const user = requireRole(req, res, ['reviewer']);
    if (!user) return;
    const b = await bodyJson(req);
    const sb = trace.getStBatch(rm[1]);
    if (!sb) return fail(res, 404, '灭菌批次不存在');

    if (b.decision === 'released') {
      if (sb.status === 'locked') return fail(res, 400, '该批次已因生物监测阳性锁定，不能放行');
      if (sb.chemical_result === 'pending') return fail(res, 400, '化学监测结果未录入，不能放行');
      if (sb.chemical_result === 'fail') return fail(res, 400, '化学监测不合格，不能放行');
      if (sb.biological_result === 'pending') return fail(res, 400, '生物监测结果未出，批次处于待检状态，不能放行发放');
      if (sb.biological_result === 'positive') return fail(res, 400, '生物监测阳性，批次已锁定');

      const tx = db.tx(() => {
        addVersion(user, 'sterilization_batch', sb.id, 'status', sb.status, 'released', b.comment || '审核人复核放行');
        db.prepare("UPDATE sterilization_batches SET status='released' WHERE id=?").run(sb.id);
        db.prepare(`INSERT INTO releases(stbatch_id,decision,reviewer_id,reviewed_at,comment,created_at)
          VALUES(?, 'released', ?, ?, ?, ?)`).run(sb.id, user.id, now(), b.comment || '', now());
        const items = db.prepare('SELECT instrument_id FROM sterilization_items WHERE stbatch_id=?').all(sb.id);
        for (const it of items) {
          const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
          addVersion(user, 'instrument', it.instrument_id, 'current_status', inst.current_status, 'in_stock', '批次放行，入合格区');
          trace.setInstrumentStatus(it.instrument_id, 'in_stock');
        }
        closeReprocessChain(sb, user);
        audit(user, 'RELEASE', 'sterilization_batch', sb.id, { decision: 'released', comment: b.comment });
      })();
      return ok(res, {});
    }

    if (b.decision === 'rejected') {
      const tx = db.tx(() => {
        addVersion(user, 'sterilization_batch', sb.id, 'status', sb.status, 'failed', b.comment || '审核驳回');
        db.prepare("UPDATE sterilization_batches SET status='failed' WHERE id=?").run(sb.id);
        db.prepare(`INSERT INTO releases(stbatch_id,decision,reviewer_id,reviewed_at,comment,created_at)
          VALUES(?, 'rejected', ?, ?, ?, ?)`).run(sb.id, user.id, now(), b.comment || '', now());
        audit(user, 'RELEASE', 'sterilization_batch', sb.id, { decision: 'rejected', comment: b.comment });
      })();
      return ok(res, {});
    }
    return fail(res, 400, '放行决定非法');
  }

  // 发放列表
  if (path === '/api/distributions' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = db.prepare(`SELECT d.*, c.name AS clinic_name, u.real_name AS operator_name,
      sb.batch_no AS stbatch_no,
      (SELECT COUNT(*) FROM distribution_items di WHERE di.distribution_id=d.id) AS item_count
      FROM distributions d JOIN clinics c ON c.id=d.clinic_id
      JOIN users u ON u.id=d.operator_id
      JOIN sterilization_batches sb ON sb.id=d.stbatch_id
      ${user.role === 'clinic' ? "WHERE d.clinic_id=" + Number(user.clinic_id) : ''}
      ORDER BY d.id DESC`).all();
    return ok(res, rows);
  }

  const dm = path.match(/^\/api\/distributions\/(\d+)$/);
  if (dm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const d = db.prepare(`SELECT d.*, c.name AS clinic_name FROM distributions d
      JOIN clinics c ON c.id=d.clinic_id WHERE d.id=?`).get(dm[1]);
    if (!d) return fail(res, 404, '发放单不存在');
    if (user.role === 'clinic' && d.clinic_id !== user.clinic_id) return fail(res, 403, '无权查看');
    d.items = db.prepare(`SELECT di.instrument_id, i.udi, i.name, i.spec, i.current_status
      FROM distribution_items di JOIN instruments i ON i.id=di.instrument_id
      WHERE di.distribution_id=?`).all(d.id);
    d.usages = db.prepare('SELECT * FROM usages WHERE distribution_id=? ORDER BY used_at').all(d.id);
    return ok(res, d);
  }

  // 发放：按诊所记录交接人、时间
  if (path === '/api/distributions' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.stbatch_id || !b.clinic_id || !b.handover_person || !b.distributed_at) {
      return fail(res, 400, '灭菌批次、诊所、交接人、发放时间必填');
    }
    const itemIds = (b.instrument_ids || []).map(Number);
    if (!itemIds.length) return fail(res, 400, '请勾选发放器械');

    const tx = db.tx(() => {
      const sb = trace.getStBatch(b.stbatch_id);
      if (!sb) throw new Error('灭菌批次不存在');
      if (sb.status !== 'released') throw new Error('批次未放行，不能发放');
      for (const iid of itemIds) {
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(iid);
        if (!inst) throw new Error('器械不存在');
        if (inst.current_status === 'frozen_recall') throw new Error(`${inst.udi} 已被冻结，禁止发放`);
        if (inst.current_status !== 'in_stock') throw new Error(`${inst.udi} 当前不在库，不能发放`);
      }
      const distNo = genNo('FF');
      const info = db.prepare(`INSERT INTO distributions(dist_no,stbatch_id,clinic_id,handover_person,operator_id,distributed_at,status,note,created_at)
        VALUES(?,?,?,?,?,?,'in_transit',?,?)`).run(distNo, b.stbatch_id, b.clinic_id, b.handover_person,
        user.id, b.distributed_at, b.note || '', now());
      const did = Number(info.lastInsertRowid);
      for (const iid of itemIds) {
        db.prepare('INSERT INTO distribution_items(distribution_id,instrument_id) VALUES(?,?)').run(did, iid);
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(iid);
        addVersion(user, 'instrument', iid, 'current_status', inst.current_status, 'in_transit', `发放至诊所，交接人 ${b.handover_person}`);
        trace.setInstrumentStatus(iid, 'in_transit', { current_clinic_id: b.clinic_id });
      }
      const cusers = db.prepare("SELECT id FROM users WHERE role='clinic' AND clinic_id=? AND active=1").all(b.clinic_id);
      for (const cu of cusers) {
        notify(cu.id, b.clinic_id, 'distribution', `【到货签收】发放单 ${distNo} 已发出`,
          `共 ${itemIds.length} 件器械，请确认签收后方可投入使用。`, 'distribution', did);
      }
      audit(user, 'DISTRIBUTE', 'distribution', did, { dist_no: distNo, clinic_id: b.clinic_id, items: itemIds.length });
      return { id: did, distNo };
    });
    try { return ok(res, tx()); } catch (e) { return fail(res, 400, e.message); }
  }

  // 诊所端签收确认
  const cm = path.match(/^\/api\/distributions\/(\d+)\/confirm$/);
  if (cm && req.method === 'POST') {
    const user = requireRole(req, res, ['clinic']);
    if (!user) return;
    const d = db.prepare('SELECT * FROM distributions WHERE id=?').get(cm[1]);
    if (!d) return fail(res, 404, '发放单不存在');
    if (d.clinic_id !== user.clinic_id) return fail(res, 403, '只能签收本诊所的发放单');
    if (d.status === 'frozen') return fail(res, 400, '该批次已被紧急召回冻结，禁止签收使用');
    if (d.status === 'received') return fail(res, 400, '已签收，请勿重复操作');
    const tx = db.tx(() => {
      db.prepare("UPDATE distributions SET status='received', clinic_confirmed_by=?, clinic_confirmed_at=? WHERE id=?")
        .run(user.id, now(), d.id);
      const items = db.prepare('SELECT instrument_id FROM distribution_items WHERE distribution_id=?').all(d.id);
      for (const it of items) {
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(it.instrument_id);
        addVersion(user, 'instrument', it.instrument_id, 'current_status', inst.current_status, 'at_clinic', '诊所签收确认，可投入使用');
        trace.setInstrumentStatus(it.instrument_id, 'at_clinic', { current_clinic_id: d.clinic_id });
      }
      audit(user, 'CLINIC_CONFIRM', 'distribution', d.id, {});
    })();
    return ok(res, {});
  }

  // 诊所端记录使用（必须已签收）
  if (path === '/api/usages' && req.method === 'POST') {
    const user = requireRole(req, res, ['clinic']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.instrument_id || !b.used_at) return fail(res, 400, '器械与使用时间必填');
    const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(b.instrument_id);
    if (!inst) return fail(res, 404, '器械不存在');
    const dist = db.prepare(`SELECT d.* FROM distributions d
      JOIN distribution_items di ON di.distribution_id=d.id
      WHERE di.instrument_id=? AND d.clinic_id=? AND d.status IN ('received')
      ORDER BY d.id DESC LIMIT 1`).get(b.instrument_id, user.clinic_id);
    if (!dist) return fail(res, 400, '该器械尚未由诊所签收，不能记录使用');
    db.prepare(`INSERT INTO usages(instrument_id,clinic_id,distribution_id,used_at,patient_ref,note,recorded_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(b.instrument_id, user.clinic_id, dist.id, b.used_at, b.patient_ref || '', b.note || '', user.id, now());
    if (inst.current_status !== 'in_use') trace.setInstrumentStatus(b.instrument_id, 'in_use');
    audit(user, 'USAGE', 'instrument', b.instrument_id, { used_at: b.used_at });
    return ok(res, {});
  }

  return false;
};
