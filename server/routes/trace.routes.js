const db = require('../db');
const { requireRole, audit, addVersion } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const traceSvc = require('../services/trace');

module.exports = async function traceRoutes(req, res, path) {
  // 方向一：UDI 反查
  if (path.startsWith('/api/trace/udi') && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const udi = new URL(req.url, 'http://x').searchParams.get('udi') || '';
    const result = traceSvc.traceByUdi(udi);
    if (!result) return fail(res, 404, '未找到该唯一标识对应的器械');
    if (user.role === 'clinic') {
      result.lifecycle = result.lifecycle;
    }
    audit(user, 'TRACE_UDI', 'instrument', result.inst.id, { udi });
    return ok(res, { ...result, inst: { ...result.inst, status_cn: traceSvc.INST_STATUS_CN[result.inst.current_status] } });
  }

  // 方向二：灭菌批次正查
  const tbm = path.match(/^\/api\/trace\/batch\/(\d+)$/);
  if (tbm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const result = traceSvc.traceByBatch(tbm[1]);
    if (!result) return fail(res, 404, '灭菌批次不存在');
    if (user.role === 'clinic' && !result.items.some((i) => i.clinic_id === user.clinic_id)) {
      return fail(res, 403, '该批次与本诊所无关');
    }
    audit(user, 'TRACE_BATCH', 'sterilization_batch', tbm[1], {});
    return ok(res, result);
  }

  // 历史版本
  const hvm = path.match(/^\/api\/history\/([a-z_]+)\/(\d+)$/);
  if (hvm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT hv.*, u.real_name AS changer_name FROM history_versions hv
      LEFT JOIN users u ON u.id=hv.changed_by
      WHERE hv.entity_type=? AND hv.entity_id=? ORDER BY hv.id DESC`).all(hvm[1], hvm[2]);
    return ok(res, rows);
  }

  // 审计日志（督导员全部，其他只能看自己相关动作）
  if (path === '/api/audit-logs' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const et = q.get('entity_type') || '';
    const eid = q.get('entity_id') || '';
    const kw = q.get('q') || '';
    let sql = `SELECT al.* FROM audit_logs al WHERE 1=1`;
    const args = [];
    if (et) { sql += ' AND al.entity_type=?'; args.push(et); }
    if (eid) { sql += ' AND al.entity_id=?'; args.push(eid); }
    if (kw) { sql += ' AND (al.username LIKE ? OR al.action LIKE ? OR al.detail LIKE ?)'; args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
    if (user.role !== 'supervisor') sql += ' AND al.user_id=' + user.id;
    sql += ' ORDER BY al.id DESC LIMIT 300';
    return ok(res, db.prepare(sql).all(...args));
  }

  // 追加更正（不覆盖原值）：灭菌参数
  const asm = path.match(/^\/api\/st-batches\/(\d+)\/amend-param$/);
  if (asm && req.method === 'POST') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    const allow = ['param_temp', 'param_pressure', 'param_hold_min', 'param_dry_min', 'program', 'load_diagram'];
    if (!allow.includes(b.field) || b.value === undefined) return fail(res, 400, '字段不允许更正');
    if (!b.reason) return fail(res, 400, '必须填写修改理由');
    const sb = traceSvc.getStBatch(asm[1]);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    const tx = db.tx(() => {
      addVersion(user, 'sterilization_batch', sb.id, b.field, sb[b.field], b.value, b.reason);
      db.prepare(`UPDATE sterilization_batches SET ${b.field}=? WHERE id=?`).run(b.value, sb.id);
      audit(user, 'AMEND_PARAM', 'sterilization_batch', sb.id, { field: b.field, old: sb[b.field], new: b.value, reason: b.reason });
    })();
    return ok(res, {});
  }

  // 追加更正：监测结果（仅允许 pending→结果，或追加更正说明；阳性立即触发锁定）
  const amm = path.match(/^\/api\/st-batches\/(\d+)\/amend-monitor$/);
  if (amm && req.method === 'POST') {
    const user = requireRole(req, res, ['reviewer', 'supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.reason) return fail(res, 400, '必须填写修改理由');
    const sb = traceSvc.getStBatch(amm[1]);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (b.monitor_type === 'chemical') {
      if (!['pass', 'fail'].includes(b.result)) return fail(res, 400, '化学结果非法');
      const tx = db.tx(() => {
        addVersion(user, 'sterilization_batch', sb.id, 'chemical_result', sb.chemical_result, b.result, b.reason);
        db.prepare('UPDATE sterilization_batches SET chemical_result=? WHERE id=?').run(b.result, sb.id);
        db.prepare("UPDATE monitorings SET result=?, tested_by=?, tested_at=? WHERE stbatch_id=? AND monitor_type='chemical'")
          .run(b.result, user.id, now(), sb.id);
        audit(user, 'AMEND_MONITOR', 'sterilization_batch', sb.id, { type: 'chemical', result: b.result, reason: b.reason });
      })();
      return ok(res, {});
    }
    if (b.monitor_type === 'biological') {
      if (!['negative', 'positive'].includes(b.result)) return fail(res, 400, '生物结果非法');
      if (b.result === 'positive') {
        const r = traceSvc.lockBatchPositive(sb.id, user, b.reason);
        audit(user, 'AMEND_MONITOR', 'sterilization_batch', sb.id, { type: 'biological', result: 'positive', reason: b.reason });
        return ok(res, { locked: true, ...r });
      }
      const tx = db.tx(() => {
        addVersion(user, 'sterilization_batch', sb.id, 'biological_result', sb.biological_result, 'negative', b.reason);
        db.prepare("UPDATE sterilization_batches SET biological_result='negative', bio_result_at=? WHERE id=?").run(now(), sb.id);
        db.prepare("UPDATE monitorings SET result='negative', tested_by=?, tested_at=? WHERE stbatch_id=? AND monitor_type='biological'")
          .run(user.id, now(), sb.id);
        audit(user, 'AMEND_MONITOR', 'sterilization_batch', sb.id, { type: 'biological', result: 'negative', reason: b.reason });
      })();
      return ok(res, { locked: false });
    }
    return fail(res, 400, '监测类型非法');
  }

  // 放行结论追加说明（不删除原结论）
  const arl = path.match(/^\/api\/st-batches\/(\d+)\/release-note$/);
  if (arl && req.method === 'POST') {
    const user = requireRole(req, res, ['reviewer', 'supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.note) return fail(res, 400, '说明内容必填');
    const last = db.prepare('SELECT * FROM releases WHERE stbatch_id=? ORDER BY id DESC LIMIT 1').get(arl[1]);
    if (!last) return fail(res, 404, '尚无放行记录');
    addVersion(user, 'release', last.id, 'append_note', '', b.note, b.reason || '放行结论追加说明');
    audit(user, 'RELEASE_APPEND_NOTE', 'release', last.id, { note: b.note, reason: b.reason });
    return ok(res, {});
  }

  return false;
};
