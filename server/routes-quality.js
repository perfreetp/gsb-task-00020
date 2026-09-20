'use strict';
const { db, now, logAudit, addHistory, tx: txWrap } = require('./db');
const { ok, fail, readBody, requireRole, roleName, genNo, notify } = require('./util');

const STAFF = ['operator', 'reviewer', 'supervisor'];

function register(server) {
const core = require('./routes-core');

// ---------- 发放登记 ----------
server.get('/api/distributions', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare(`SELECT d.*, i.uid, i.instrument_type, c.name clinic_name, sb.batch_no
      FROM distributions d JOIN instrument_instances i ON i.id=d.instrument_id
      JOIN clinics c ON c.id=d.clinic_id JOIN sterilization_batches sb ON sb.id=d.ster_batch_id
      WHERE d.clinic_id=? ORDER BY d.id DESC`).all(session.user.clinic_id);
  } else {
    rows = db.prepare(`SELECT d.*, i.uid, i.instrument_type, c.name clinic_name, sb.batch_no
      FROM distributions d JOIN instrument_instances i ON i.id=d.instrument_id
      JOIN clinics c ON c.id=d.clinic_id JOIN sterilization_batches sb ON sb.id=d.ster_batch_id
      ORDER BY d.id DESC`).all();
  }
  ok(res, rows);
});
server.post('/api/sterilizations/:id/distribute', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const sbId = Number(p.id);
  readBody(req).then((b) => {
    const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(sbId);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (sb.status === 'frozen') return fail(res, 400, '批次已冻结，禁止发放');
    if (!['released', 'emergency_released'].includes(sb.status)) {
      const bio = db.prepare("SELECT result FROM monitoring_results WHERE ster_batch_id=? AND kind='biological'").get(sbId);
      if (!bio || bio.result === 'pending') return fail(res, 403, '生物监测未出结果，批次处于待检状态，不能发放');
      return fail(res, 403, `批次状态为 ${sb.status}，未放行不能发放`);
    }
    if (!Array.isArray(b.items) || b.items.length === 0) return fail(res, 400, '请选择要发放的器械');
    if (!b.clinic_id) return fail(res, 400, '请选择接收诊所');
    const tx = txWrap(() => {
      const created = [];
      for (const item of b.items) {
        const inst = db.prepare('SELECT * FROM instrument_instances WHERE id=?').get(Number(item.instrument_id));
        if (!inst) continue;
        const active = db.prepare("SELECT id FROM distributions WHERE instrument_id=? AND status IN ('in_transit','received','in_use')").get(inst.id);
        if (active) continue;
        const id = db.prepare(`INSERT INTO distributions(ster_batch_id,instrument_id,clinic_id,handover_person,handed_at,operator_id,status)
          VALUES(?,?,?,?,?,?,?)`).run(sbId, inst.id, b.clinic_id, b.handover_person || null, now(), session.user.id, 'in_transit').lastInsertRowid;
        db.prepare("UPDATE instrument_instances SET status='in_transit', current_clinic_id=? WHERE id=?").run(b.clinic_id, inst.id);
        created.push(id);
      }
      notify(b.clinic_id, `批次 ${sb.batch_no} 已发出 ${created.length} 件器械`, `交接人：${b.handover_person || '未登记'}，请在签收页面确认收货。`, 'distribution', 'sterilization_batches', sbId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'DISTRIBUTE', entity: 'sterilization_batches', entity_id: sbId, detail: { clinic_id: b.clinic_id, count: created.length } });
      return created;
    });
    ok(res, { distribution_ids: tx() });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 诊所签收 / 投入使用 ----------
server.post('/api/distributions/:id/receive', (req, res, session, p) => {
  readBody(req).then((b) => {
    const d = db.prepare('SELECT * FROM distributions WHERE id=?').get(Number(p.id));
    if (!d) return fail(res, 404, '发放记录不存在');
    if (session.user.role === 'clinic' && d.clinic_id !== session.user.clinic_id) return fail(res, 403, '只能签收本诊所器械');
    if (d.status !== 'in_transit') return fail(res, 400, '该单据不在待签收状态（可能已被召回）');
    if (!b.receive_person) return fail(res, 400, '请填写接收人');
    db.prepare("UPDATE distributions SET status='received', receive_person=?, received_at=? WHERE id=?")
      .run(b.receive_person, now(), d.id);
    db.prepare("UPDATE instrument_instances SET status='released' WHERE id=?").run(d.instrument_id);
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'RECEIVE', entity: 'distributions', entity_id: d.id, detail: b });
    ok(res, { status: 'received' });
  }).catch((e) => fail(res, 400, e.message));
});
server.post('/api/distributions/:id/use', (req, res, session, p) => {
  readBody(req).then(() => {
    const d = db.prepare('SELECT * FROM distributions WHERE id=?').get(Number(p.id));
    if (!d) return fail(res, 404, '发放记录不存在');
    if (session.user.role === 'clinic' && d.clinic_id !== session.user.clinic_id) return fail(res, 403, '无权操作');
    if (d.status === 'in_transit') return fail(res, 400, '未签收，不能投入使用');
    if (d.status === 'recalled') return fail(res, 400, '器械已被召回冻结，禁止使用');
    db.prepare("UPDATE distributions SET status='in_use', first_used_at=COALESCE(first_used_at,?) WHERE id=?").run(now(), d.id);
    db.prepare("UPDATE instrument_instances SET status='in_use' WHERE id=?").run(d.instrument_id);
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'IN_USE', entity: 'distributions', entity_id: d.id });
    ok(res, { status: 'in_use' });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 召回任务：诊所确认 / 退回 ----------
server.get('/api/recalls', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare(`SELECT r.*, i.uid, i.instrument_type, c.name clinic_name FROM recall_tasks r
      LEFT JOIN instrument_instances i ON i.id=r.instrument_id LEFT JOIN clinics c ON c.id=r.clinic_id
      WHERE r.clinic_id=? ORDER BY r.id DESC`).all(session.user.clinic_id);
  } else {
    rows = db.prepare(`SELECT r.*, i.uid, i.instrument_type, c.name clinic_name FROM recall_tasks r
      LEFT JOIN instrument_instances i ON i.id=r.instrument_id LEFT JOIN clinics c ON c.id=r.clinic_id ORDER BY r.id DESC`).all();
  }
  ok(res, rows);
});
server.post('/api/recalls/:id/ack', (req, res, session, p) => {
  readBody(req).then((b) => {
    const r = db.prepare('SELECT * FROM recall_tasks WHERE id=?').get(Number(p.id));
    if (!r) return fail(res, 404, '召回任务不存在');
    if (session.user.role === 'clinic' && r.clinic_id !== session.user.clinic_id) return fail(res, 403, '只能处理本诊所召回任务');
    db.prepare("UPDATE recall_tasks SET status='acknowledged', acknowledged_at=? WHERE id=?").run(now(), r.id);
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'RECALL_ACK', entity: 'recall_tasks', entity_id: r.id, detail: b });
    ok(res, { status: 'acknowledged' });
  }).catch((e) => fail(res, 400, e.message));
});
server.post('/api/recalls/:id/return', (req, res, session, p) => {
  readBody(req).then((b) => {
    const r = db.prepare('SELECT * FROM recall_tasks WHERE id=?').get(Number(p.id));
    if (!r) return fail(res, 404, '召回任务不存在');
    if (session.user.role === 'clinic' && r.clinic_id !== session.user.clinic_id) return fail(res, 403, '只能处理本诊所召回任务');
    const tx = txWrap(() => {
      db.prepare("UPDATE recall_tasks SET status='returned', returned_at=? WHERE id=?").run(now(), r.id);
      db.prepare("UPDATE distributions SET status='returned' WHERE id=?").run(r.distribution_id);
      db.prepare("UPDATE instrument_instances SET status='recalled', current_clinic_id=NULL WHERE id=?").run(r.instrument_id);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'RECALL_RETURN', entity: 'recall_tasks', entity_id: r.id, detail: b });
    });
    tx();
    ok(res, { status: 'returned' });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 不合格处置单（NCR）：原因分析、整改、返工重新灭菌 ----------
server.get('/api/ncrs', (req, res, session) => {
  const rows = db.prepare(`SELECT n.*, sb.batch_no FROM nonconformances n
    JOIN sterilization_batches sb ON sb.id=n.ster_batch_id ORDER BY n.id DESC`).all();
  ok(res, rows);
});
server.get('/api/ncrs/:id', (req, res, session, p) => {
  const n = db.prepare(`SELECT n.*, sb.batch_no FROM nonconformances n
    JOIN sterilization_batches sb ON sb.id=n.ster_batch_id WHERE n.id=?`).get(Number(p.id));
  if (!n) return fail(res, 404, '处置单不存在');
  n.history = db.prepare(`SELECT h.*, u.name changer_name FROM field_history h LEFT JOIN users u ON u.id=h.changed_by
    WHERE entity=? AND entity_id=? ORDER BY h.id`).all('nonconformances', n.id);
  ok(res, n);
});
server.post('/api/ncrs/:id/analyze', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  readBody(req).then((b) => {
    const n = db.prepare('SELECT * FROM nonconformances WHERE id=?').get(Number(p.id));
    if (!n) return fail(res, 404, '处置单不存在');
    if (!b.reason && !b.root_cause_analysis && !b.corrective_action && !b.preventive_action)
      return fail(res, 400, '请至少填写一项分析/整改内容');
    const fields = [['reason','原因'],['root_cause_analysis','原因分析'],['corrective_action','整改措施'],['preventive_action','预防措施']];
    const tx = txWrap(() => {
      for (const [f] of fields) {
        if (b[f] !== undefined && b[f] !== n[f]) addHistory('nonconformances', n.id, f, n[f], b[f], b.change_reason || '补充原因分析与整改', session.user.id);
      }
      db.prepare(`UPDATE nonconformances SET reason=COALESCE(?,reason), root_cause_analysis=COALESCE(?,root_cause_analysis),
        corrective_action=COALESCE(?,corrective_action), preventive_action=COALESCE(?,preventive_action), status='analyzing' WHERE id=?`)
        .run(b.reason ?? null, b.root_cause_analysis ?? null, b.corrective_action ?? null, b.preventive_action ?? null, n.id);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'NCR_ANALYZE', entity: 'nonconformances', entity_id: n.id, detail: b });
    });
    tx();
    ok(res, { ok: true });
  }).catch((e) => fail(res, 400, e.message));
});

// 返工：对冻结批次器械重新清洗+重新灭菌（创建新灭菌批次），新批次合格放行后闭环
server.post('/api/ncrs/:id/rework', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  readBody(req).then((b) => {
    const n = db.prepare('SELECT * FROM nonconformances WHERE id=?').get(Number(p.id));
    if (!n) return fail(res, 404, '处置单不存在');
    const oldSb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(n.ster_batch_id);
    if (!b.sterilizer_id) return fail(res, 400, '请选择重新灭菌使用的灭菌器');
    if (!b.root_cause_analysis || !b.corrective_action) return fail(res, 400, '返工前必须填写原因分析和整改措施');
    const items = db.prepare('SELECT * FROM batch_items WHERE ster_batch_id=?').all(oldSb.id);
    const tx = txWrap(() => {
      if (b.root_cause_analysis !== n.root_cause_analysis) addHistory('nonconformances', n.id, 'root_cause_analysis', n.root_cause_analysis, b.root_cause_analysis, '返工前更新', session.user.id);
      if (b.corrective_action !== n.corrective_action) addHistory('nonconformances', n.id, 'corrective_action', n.corrective_action, b.corrective_action, '返工前更新', session.user.id);
      db.prepare(`UPDATE nonconformances SET root_cause_analysis=?, corrective_action=COALESCE(?,corrective_action),
        preventive_action=COALESCE(?,preventive_action), status='reworking' WHERE id=?`)
        .run(b.root_cause_analysis, b.corrective_action ?? null, b.preventive_action ?? null, n.id);

      db.prepare(`INSERT INTO wash_records(recycle_batch_id,equipment_id,program,temperature,duration_min,operator_id,washed_at,note)
        VALUES(?,?,?,?,?,?,?,?)`).run(oldSb.recycle_batch_id, b.washer_id || oldSb.sterilizer_id, b.program || '返工程序-加强清洗',
          b.temperature ?? 93, b.duration_min ?? 50, session.user.id, now(), '不合格返工重新清洗');

      const no = genNo('MJR');
      const newId = db.prepare(`INSERT INTO sterilization_batches
        (batch_no,recycle_batch_id,sterilizer_id,load_diagram,temperature,pressure,duration_min,cycle_params,status,sterilized_at,operator_id,reworked_from_batch_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(no, oldSb.recycle_batch_id, b.sterilizer_id, b.load_diagram || '返工装载', b.temperature ?? 134, b.pressure ?? 210,
          b.duration_min ?? 8, b.cycle_params || '脉动3次/干燥15min', 'sterilized', now(), session.user.id, oldSb.id).lastInsertRowid;
      const bind = db.prepare('INSERT INTO batch_items(ster_batch_id,instrument_id) VALUES(?,?)');
      for (const it of items) { bind.run(newId, it.instrument_id); }
      db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,note)
        VALUES(?,?,?,?,?,?,?)`).run(newId, 'chemical', b.chemical_result === 'fail' ? 'fail' : 'pending', b.chemical_value || '返工批次，待判读', session.user.id, now(), null);
      db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,note)
        VALUES(?,?,?,?,?,?,?)`).run(newId, 'biological', b.biological_result === 'pass' ? 'pass' : (b.biological_result === 'fail' ? 'fail' : 'pending'),
          b.biological_value || '返工批次，培养中', session.user.id, now(), null);
      const bio = b.biological_result;
      const newStatus = bio === 'fail' ? 'frozen' : (bio === 'pass' ? 'sterilized' : 'pending_bi');
      db.prepare('UPDATE sterilization_batches SET status=? WHERE id=?').run(newStatus, newId);
      db.prepare("UPDATE recycle_batches SET status=? WHERE id=?").run(newStatus, oldSb.recycle_batch_id);
      db.prepare('UPDATE nonconformances SET new_ster_batch_id=? WHERE id=?').run(newId, n.id);
      db.prepare("UPDATE sterilization_batches SET status='reworked' WHERE id=? AND status='frozen'").run(oldSb.id);
      db.prepare("UPDATE instrument_instances SET status=CASE WHEN ?='frozen' THEN 'frozen' ELSE 'sterilized' END WHERE id IN (SELECT instrument_id FROM batch_items WHERE ster_batch_id=?)").run(newStatus, newId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'NCR_REWORK', entity: 'nonconformances', entity_id: n.id, detail: { old_batch: oldSb.batch_no, new_batch: no, count: items.length } });
      if (newStatus === 'frozen') {
        // 返工再次失败：不产生新的外发，直接记录
        logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'REWORK_FAIL', entity: 'sterilization_batches', entity_id: newId });
      }
      return { newId, no, status: newStatus };
    });
    const r = tx();
    ok(res, r);
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 专项检查（督导员） ----------
server.get('/api/inspections', (req, res, session) => {
  const rows = db.prepare(`SELECT si.*, sb.batch_no, u.name starter_name, uc.name closer_name
    FROM special_inspections si LEFT JOIN sterilization_batches sb ON sb.id=si.ster_batch_id
    LEFT JOIN users u ON u.id=si.started_by LEFT JOIN users uc ON uc.id=si.closed_by ORDER BY si.id DESC`).all();
  ok(res, rows);
});
server.post('/api/inspections', (req, res, session) => {
  if (!requireRole(res, session, ['supervisor'])) return;
  readBody(req).then((b) => {
    if (!b.title) return fail(res, 400, '请填写检查主题');
    const id = db.prepare(`INSERT INTO special_inspections(title,ster_batch_id,trigger_reason,status,started_by,started_at)
      VALUES(?,?,?,?,?,?)`).run(b.title, b.ster_batch_id || null, b.trigger_reason || null, 'open', session.user.id, now()).lastInsertRowid;
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'INSPECTION_START', entity: 'special_inspections', entity_id: id, detail: b });
    ok(res, { id });
  }).catch((e) => fail(res, 400, e.message));
});
server.post('/api/inspections/:id/update', (req, res, session, p) => {
  if (!requireRole(res, session, ['supervisor'])) return;
  readBody(req).then((b) => {
    const si = db.prepare('SELECT * FROM special_inspections WHERE id=?').get(Number(p.id));
    if (!si) return fail(res, 404, '专项检查不存在');
    if (si.status === 'closed') return fail(res, 400, '已闭环的检查不能再修改');
    const tx = txWrap(() => {
      if (b.findings !== undefined && b.findings !== si.findings) addHistory('special_inspections', si.id, 'findings', si.findings, b.findings, b.change_reason || '检查记录追加', session.user.id);
      if (b.rectification !== undefined && b.rectification !== si.rectification) addHistory('special_inspections', si.id, 'rectification', si.rectification, b.rectification, b.change_reason || '整改情况追加', session.user.id);
      let status = si.status;
      if (b.findings || b.rectification) status = 'rectifying';
      if (b.action === 'close') {
        if (!b.findings || !b.rectification) throw new Error('闭环前必须填写检查记录与整改情况');
        status = 'closed';
      }
      db.prepare('UPDATE special_inspections SET findings=COALESCE(?,findings), rectification=COALESCE(?,rectification), status=?, closed_at=CASE WHEN ?=? THEN ? ELSE closed_at END, closed_by=CASE WHEN ?=? THEN ? ELSE closed_by END WHERE id=?')
        .run(b.findings ?? null, b.rectification ?? null, status, status, 'closed', now(), status, 'closed', session.user.id, si.id);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: b.action === 'close' ? 'INSPECTION_CLOSE' : 'INSPECTION_UPDATE', entity: 'special_inspections', entity_id: si.id, detail: b });
      return status;
    });
    try { ok(res, { status: tx() }); } catch (e) { fail(res, 400, e.message); }
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 双向追溯 ----------
// 1) 单件反查：UID -> 经历过的全部批次、监测、去向、使用时间
server.get('/api/trace/instrument', (req, res, session) => {
  const q = (req.query.get('uid') || '').trim();
  if (!q) return fail(res, 400, '请输入器械唯一标识');
  const inst = db.prepare('SELECT * FROM instrument_instances WHERE uid=?').get(q);
  if (!inst) return fail(res, 404, '未找到该器械');
  const lifecycle = db.prepare(`
    SELECT sb.id ster_id, sb.batch_no, sb.status, sb.sterilized_at, e.code sterilizer_code,
      (SELECT result FROM monitoring_results WHERE ster_batch_id=sb.id AND kind='chemical') chemical,
      (SELECT result FROM monitoring_results WHERE ster_batch_id=sb.id AND kind='biological') biological,
      d.status dist_status, d.handed_at, d.received_at, d.first_used_at,
      c.name clinic_name, d.handover_person, d.receive_person,
      r.status recall_status, r.notified_at
    FROM batch_items bi JOIN sterilization_batches sb ON sb.id=bi.ster_batch_id
    LEFT JOIN equipment e ON e.id=sb.sterilizer_id
    LEFT JOIN distributions d ON d.ster_batch_id=sb.id AND d.instrument_id=bi.instrument_id
    LEFT JOIN clinics c ON c.id=d.clinic_id
    LEFT JOIN recall_tasks r ON r.instrument_id=bi.instrument_id AND r.ster_batch_id=sb.id
    WHERE bi.instrument_id=? ORDER BY sb.id`).all(inst.id);
  const recycle = db.prepare(`SELECT rb.*, c.name clinic_name FROM recycle_batches rb JOIN clinics c ON c.id=rb.clinic_id WHERE rb.id=?`).get(inst.recycle_batch_id);
  const washes = db.prepare(`SELECT w.*, e.code equipment_code FROM wash_records w LEFT JOIN equipment e ON e.id=w.equipment_id WHERE w.recycle_batch_id=? ORDER BY w.id`).all(inst.recycle_batch_id);
  ok(res, { instrument: inst, recycle, washes, lifecycle });
});

// 2) 批次正查：灭菌批次 -> 全部器械、去向、使用时间
server.get('/api/trace/batch', (req, res, session) => {
  const q = (req.query.get('batch_no') || '').trim();
  if (!q) return fail(res, 400, '请输入灭菌批次号');
  const sb = db.prepare(`SELECT sb.*, e.code sterilizer_code FROM sterilization_batches sb LEFT JOIN equipment e ON e.id=sb.sterilizer_id WHERE sb.batch_no=?`).get(q);
  if (!sb) return fail(res, 404, '未找到该灭菌批次');
  const items = db.prepare(`SELECT i.uid, i.instrument_type, i.status, d.status dist_status,
    c.name clinic_name, d.handed_at, d.receive_person, d.received_at, d.first_used_at, d.recalled_at,
    r.status recall_status
    FROM batch_items bi JOIN instrument_instances i ON i.id=bi.instrument_id
    LEFT JOIN distributions d ON d.ster_batch_id=bi.ster_batch_id AND d.instrument_id=i.id
    LEFT JOIN clinics c ON c.id=d.clinic_id
    LEFT JOIN recall_tasks r ON r.instrument_id=i.id AND r.ster_batch_id=bi.ster_batch_id
    WHERE bi.ster_batch_id=? ORDER BY i.uid`).all(sb.id);
  const monitoring = db.prepare('SELECT * FROM monitoring_results WHERE ster_batch_id=?').all(sb.id);
  const clinics = {};
  for (const it of items) {
    if (it.clinic_name) clinics[it.clinic_name] = (clinics[it.clinic_name] || 0) + 1;
  }
  ok(res, { batch: sb, monitoring, items, affected_clinics: clinics, total: items.length });
});

// 3) 影响面速查：器械/批次出现问题时几分钟内圈定
server.get('/api/trace/impact', (req, res, session) => {
  const q = (req.query.get('q') || '').trim();
  if (!q) return fail(res, 400, '请输入批次号或器械UID');
  let sbId = null;
  const sb = db.prepare('SELECT * FROM sterilization_batches WHERE batch_no=?').get(q);
  if (sb) sbId = sb.id;
  else {
    const inst = db.prepare('SELECT * FROM instrument_instances WHERE uid=?').get(q);
    if (inst && inst.last_ster_batch_id) sbId = inst.last_ster_batch_id;
  }
  if (!sbId) return fail(res, 404, '未匹配到灭菌批次');
  const detail = require('./routes-core').sterDetail(sbId);
  const affectedInstruments = detail.items.map((i) => ({ uid: i.uid, type: i.instrument_type, status: i.status, clinic: i.dist_clinic_name || '中心库房', dist_status: i.dist_status, first_used_at: i.first_used_at }));
  const clinicMap = {};
  for (const i of detail.items) {
    const key = i.dist_clinic_name || '中心库房';
    if (!clinicMap[key]) clinicMap[key] = { clinic: key, total: 0, in_transit: 0, received: 0, in_use: 0, in_stock: 0, uids: [] };
    clinicMap[key].total++;
    clinicMap[key].uids.push(i.uid);
    if (i.dist_status === 'in_transit') clinicMap[key].in_transit++;
    if (i.dist_status === 'received') clinicMap[key].received++;
    if (i.dist_status === 'in_use') clinicMap[key].in_use++;
    if (!i.dist_status) clinicMap[key].in_stock++;
  }
  ok(res, { batch_no: detail.batch_no, status: detail.status, freeze_reason: detail.freeze_reason, total_instruments: affectedInstruments.length, instruments: affectedInstruments, clinics: Object.values(clinicMap), recalls: detail.recalls });
});

// ---------- 灭菌参数/放行结论的追加式修改 ----------
server.post('/api/sterilizations/:id/revise', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const sbId = Number(p.id);
  readBody(req).then((b) => {
    const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(sbId);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (!b.reason) return fail(res, 400, '修改必须填写理由（审计留痕）');
    const fields = ['temperature','pressure','duration_min','load_diagram','cycle_params','release_note'];
    const tx = txWrap(() => {
      for (const f of fields) {
        if (b[f] !== undefined && String(b[f] ?? '') !== String(sb[f] ?? '')) {
          addHistory('sterilization_batches', sbId, f, sb[f], b[f], b.reason, session.user.id);
          db.prepare(`UPDATE sterilization_batches SET ${f}=? WHERE id=?`).run(b[f], sbId);
        }
      }
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'REVISE_STER_PARAMS', entity: 'sterilization_batches', entity_id: sbId, detail: { reason: b.reason, fields: Object.keys(b).filter((k) => fields.includes(k)) } });
    });
    tx();
    ok(res, { ok: true });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 差异列表 ----------
server.get('/api/discrepancies', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare(`SELECT d.*, c.name clinic_name, rb.batch_no recycle_no, u.name confirmer_name
      FROM discrepancies d JOIN clinics c ON c.id=d.clinic_id
      JOIN recycle_batches rb ON rb.id=d.recycle_batch_id
      LEFT JOIN users u ON u.id=d.confirmed_by WHERE d.clinic_id=? ORDER BY d.id DESC`).all(session.user.clinic_id);
  } else {
    rows = db.prepare(`SELECT d.*, c.name clinic_name, rb.batch_no recycle_no, u.name confirmer_name
      FROM discrepancies d JOIN clinics c ON c.id=d.clinic_id
      JOIN recycle_batches rb ON rb.id=d.recycle_batch_id
      LEFT JOIN users u ON u.id=d.confirmed_by ORDER BY d.id DESC`).all();
  }
  ok(res, rows);
});

// ---------- 感控报表（督导员/审核人） ----------
server.get('/api/reports/quality', (req, res, session) => {
  if (!requireRole(res, session, ['supervisor', 'reviewer'])) return;
  const from = req.query.get('from');
  const to = req.query.get('to');
  const where = [];
  const args = [];
  if (from) { where.push('date(sb.sterilized_at)>=date(?)'); args.push(from); }
  if (to) { where.push('date(sb.sterilized_at)<=date(?)'); args.push(to); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const summary = db.prepare(`SELECT
      COUNT(*) total_batches,
      SUM(CASE WHEN sb.status='frozen' THEN 1 ELSE 0 END) frozen_batches,
      SUM(CASE WHEN sb.status='reworked' THEN 1 ELSE 0 END) reworked_batches,
      SUM(CASE WHEN bio.result='fail' THEN 1 ELSE 0 END) bi_fail,
      SUM(CASE WHEN bio.result='pass' THEN 1 ELSE 0 END) bi_pass,
      SUM(CASE WHEN chem.result='fail' THEN 1 ELSE 0 END) chem_fail
    FROM sterilization_batches sb
    LEFT JOIN monitoring_results bio ON bio.ster_batch_id=sb.id AND bio.kind='biological'
    LEFT JOIN monitoring_results chem ON chem.ster_batch_id=sb.id AND chem.kind='chemical'
    ${w}`).get(...args);
  const bySterilizer = db.prepare(`SELECT e.code, e.name, COUNT(*) batches,
      SUM(CASE WHEN sb.status='frozen' THEN 1 ELSE 0 END) frozen
    FROM sterilization_batches sb JOIN equipment e ON e.id=sb.sterilizer_id
    ${w.replace(/sb\./g, 'sb.')} GROUP BY e.id ORDER BY frozen DESC`).all(...args);
  const byClinic = db.prepare(`SELECT c.name, COUNT(DISTINCT sb.id) batches, COUNT(d.id) distributed
    FROM sterilization_batches sb
    JOIN recycle_batches rb ON rb.id=sb.recycle_batch_id JOIN clinics c ON c.id=rb.clinic_id
    LEFT JOIN distributions d ON d.ster_batch_id=sb.id
    ${where.length ? 'WHERE ' + where.join(' AND ').replace(/sb\./g, 'sb.') : ''}
    GROUP BY c.id ORDER BY distributed DESC`).all(...args);
  const abnormal = db.prepare(`SELECT sb.batch_no, sb.status, sb.freeze_reason, sb.sterilized_at, e.code sterilizer_code,
      bio.result bio, chem.result chem
    FROM sterilization_batches sb JOIN equipment e ON e.id=sb.sterilizer_id
    LEFT JOIN monitoring_results bio ON bio.ster_batch_id=sb.id AND bio.kind='biological'
    LEFT JOIN monitoring_results chem ON chem.ster_batch_id=sb.id AND chem.kind='chemical'
    WHERE sb.status IN ('frozen','reworked') OR bio.result='fail' OR chem.result='fail' ORDER BY sb.id DESC`).all();
  const recalls = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='returned' THEN 1 ELSE 0 END) returned,
      SUM(CASE WHEN status!='returned' THEN 1 ELSE 0 END) pending
    FROM recall_tasks`).get();
  const ncrs = db.prepare(`SELECT status, COUNT(*) c FROM nonconformances GROUP BY status`).all();
  ok(res, { summary, bySterilizer, byClinic, abnormal, recalls, ncrs, generated_at: now() });
});

server.get('/api/reports/export', (req, res, session) => {
  if (!requireRole(res, session, ['supervisor', 'reviewer'])) return;
  const type = req.query.get('type') || 'quality';
  const payload = {
    exported_at: now(),
    exported_by: session.user.name,
    report_type: type,
    rows: db.prepare(`SELECT sb.batch_no, sb.status, sb.sterilized_at, e.code sterilizer_code,
        bio.result bio_result, chem.result chem_result,
        (SELECT COUNT(*) FROM batch_items WHERE ster_batch_id=sb.id) item_count,
        (SELECT COUNT(*) FROM distributions WHERE ster_batch_id=sb.id) distributed_count
      FROM sterilization_batches sb JOIN equipment e ON e.id=sb.sterilizer_id
      LEFT JOIN monitoring_results bio ON bio.ster_batch_id=sb.id AND bio.kind='biological'
      LEFT JOIN monitoring_results chem ON chem.ster_batch_id=sb.id AND chem.kind='chemical'
      ORDER BY sb.id`).all()
  };
  const fileName = `${type}_report_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  db.prepare('INSERT INTO report_exports(report_type,params,file_name,exported_by,exported_at) VALUES(?,?,?,?,?)')
    .run(type, JSON.stringify(Object.fromEntries(req.query.entries())), fileName, session.user.id, now());
  logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'REPORT_EXPORT', entity: 'report_exports', detail: { type, file_name: fileName } });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`
  });
  res.end(JSON.stringify(payload, null, 2));
});

// ---------- 审计日志与历史版本 ----------
server.get('/api/audit', (req, res, session) => {
  if (!requireRole(res, session, ['supervisor', 'reviewer'])) return;
  const limit = Math.min(Number(req.query.get('limit')) || 200, 1000);
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  ok(res, rows);
});
server.get('/api/history', (req, res, session) => {
  if (!requireRole(res, session, STAFF.concat(['reviewer']))) return;
  const entity = req.query.get('entity');
  const id = req.query.get('id');
  if (!entity || !id) return fail(res, 400, '需要 entity 和 id');
  const rows = db.prepare(`SELECT h.*, u.name changer_name FROM field_history h
    LEFT JOIN users u ON u.id=h.changed_by WHERE entity=? AND entity_id=? ORDER BY h.id`).all(entity, Number(id));
  ok(res, rows);
});

// ---------- 通知 ----------
server.get('/api/notifications', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare('SELECT * FROM notifications WHERE clinic_id=? ORDER BY id DESC LIMIT 100').all(session.user.clinic_id);
  } else {
    rows = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 100').all();
  }
  ok(res, rows);
});
server.post('/api/notifications/:id/read', (req, res, session, p) => {
  db.prepare('UPDATE notifications SET read_flag=1 WHERE id=?').run(Number(p.id));
  ok(res, { ok: true });
});

// ---------- 器械台账 ----------
server.get('/api/instruments', (req, res, session) => {
  const uid = req.query.get('uid');
  const status = req.query.get('status');
  const where = [];
  const args = [];
  if (uid) { where.push('i.uid LIKE ?'); args.push('%' + uid + '%'); }
  if (status) { where.push('i.status=?'); args.push(status); }
  if (session.user.role === 'clinic') { where.push('(d.clinic_id=? OR i.current_clinic_id=?)'); args.push(session.user.clinic_id, session.user.clinic_id); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT i.*, c.name current_clinic_name, sb.batch_no last_batch
    FROM instrument_instances i LEFT JOIN clinics c ON c.id=i.current_clinic_id
    LEFT JOIN sterilization_batches sb ON sb.id=i.last_ster_batch_id
    LEFT JOIN distributions d ON d.instrument_id=i.id AND d.status IN ('in_transit','received','in_use')
    ${w} ORDER BY i.id DESC LIMIT 300`).all(...args);
  ok(res, rows);
});

} // end register

module.exports = { register };
