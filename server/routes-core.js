'use strict';
const { db, now, logAudit, addHistory, tx: txWrap } = require('./db');
const { ok, fail, readBody, requireRole, roleName, genNo, notify } = require('./util');

const STAFF = ['operator', 'reviewer', 'supervisor'];
const STAFF_Q = `'operator','reviewer','supervisor'`;

function clinicOf(session) { return session.user.clinic_id; }

function freezeBatch(sbId, session, reason) {
  const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(sbId);
  if (!sb || sb.status === 'frozen') return;
  const items = db.prepare('SELECT * FROM batch_items WHERE ster_batch_id=?').all(sbId);
  db.prepare("UPDATE sterilization_batches SET status='frozen', frozen_at=?, freeze_reason=? WHERE id=?").run(now(), reason, sbId);
  db.prepare("UPDATE recycle_batches SET status='frozen' WHERE id=?").run(sb.recycle_batch_id);

  const clinicsNotified = new Map();
  for (const bi of items) {
    const inst = db.prepare('SELECT * FROM instrument_instances WHERE id=?').get(bi.instrument_id);
    db.prepare("UPDATE instrument_instances SET status='frozen' WHERE id=?").run(inst.id);
    const d = db.prepare("SELECT * FROM distributions WHERE instrument_id=? AND ster_batch_id=? AND status IN ('in_transit','received','in_use')")
      .get(inst.id, sbId);
    if (d) {
      // 冻结在途/在库（诊所端）状态，创建召回任务
      const taskId = db.prepare(`INSERT INTO recall_tasks(ster_batch_id,clinic_id,instrument_id,distribution_id,channel,status,notified_at,message)
        VALUES(?,?,?,?,?,?,?,?)`).run(sbId, d.clinic_id, inst.id, d.id, 'system_push', 'notified', now(),
          `${reason}：器械 ${inst.uid} 立即停止使用并封存，等待回收`).lastInsertRowid;
      db.prepare("UPDATE distributions SET status='recalled', recalled_at=?, recall_task_id=? WHERE id=?").run(now(), taskId, d.id);
      db.prepare("UPDATE instrument_instances SET status='frozen' WHERE id=?").run(inst.id);
      const c = db.prepare('SELECT name FROM clinics WHERE id=?').get(d.clinic_id);
      clinicsNotified.set(d.clinic_id, c.name);
      notify(d.clinic_id, `【紧急召回】灭菌批次 ${sb.batch_no} ${reason}`,
        `器械编号 ${inst.uid}（${inst.instrument_type}）请立即停止使用、就地封存并联系供应中心回收。交接时间 ${d.handed_at}，使用时间 ${d.first_used_at || '尚未使用'}。`,
        'recall', 'sterilization_batches', sbId);
    }
  }
  const ncrNo = genNo('NCR');
  const ncrId = db.prepare(`INSERT INTO nonconformances(ncr_no,ster_batch_id,reason,rework_required,status,created_at,created_by)
    VALUES(?,?,?,?,?,?,?)`).run(ncrNo, sbId, reason, 1, 'open', now(), session ? session.user.id : null).lastInsertRowid;
  logAudit({ actor_id: session ? session.user.id : null, actor_name: session ? session.user.name : '系统', role: session ? session.user.role : 'system',
    action: 'FREEZE_RECALL', entity: 'sterilization_batches', entity_id: sbId,
    detail: { reason, items: items.length, clinics: [...clinicsNotified.values()], ncr_no: ncrNo } });
  return { ncr_id: ncrId, ncr_no: ncrNo, clinics: [...clinicsNotified.values()] };
}

function sterDetail(id) {
  const sb = db.prepare(`SELECT sb.*, rb.batch_no recycle_no, rb.clinic_id, c.name clinic_name, e.code sterilizer_code,
    u.name operator_name, ur.name release_name
    FROM sterilization_batches sb
    JOIN recycle_batches rb ON rb.id=sb.recycle_batch_id
    JOIN clinics c ON c.id=rb.clinic_id
    JOIN equipment e ON e.id=sb.sterilizer_id
    LEFT JOIN users u ON u.id=sb.operator_id
    LEFT JOIN users ur ON ur.id=sb.released_by WHERE sb.id=?`).get(id);
  if (!sb) return null;
  sb.items = db.prepare(`SELECT i.*, d.status dist_status, d.clinic_id dist_clinic_id, dc.name dist_clinic_name,
    d.handover_person, d.handed_at, d.receive_person, d.received_at, d.first_used_at, d.id distribution_id
    FROM batch_items bi JOIN instrument_instances i ON i.id=bi.instrument_id
    LEFT JOIN distributions d ON d.instrument_id=i.id AND d.ster_batch_id=bi.ster_batch_id
    LEFT JOIN clinics dc ON dc.id=d.clinic_id
    WHERE bi.ster_batch_id=? ORDER BY i.uid`).all(id);
  sb.monitoring = db.prepare('SELECT m.*, u.name tester_name FROM monitoring_results m LEFT JOIN users u ON u.id=m.tested_by WHERE ster_batch_id=?').all(id);
  sb.recalls = db.prepare(`SELECT r.*, i.uid, c.name clinic_name FROM recall_tasks r
    LEFT JOIN instrument_instances i ON i.id=r.instrument_id LEFT JOIN clinics c ON c.id=r.clinic_id WHERE r.ster_batch_id=? ORDER BY r.id`).all(id);
  sb.ncrs = db.prepare('SELECT * FROM nonconformances WHERE ster_batch_id=?').all(id);
  sb.history = db.prepare(`SELECT h.*, u.name changer_name FROM field_history h LEFT JOIN users u ON u.id=h.changed_by
    WHERE entity=? AND entity_id=? ORDER BY h.id`).all('sterilization_batches', id);
  return sb;
}

function register(server) {

// ---------- 基础资料 ----------
server.get('/api/meta', (req, res, session) => {
  ok(res, {
    user: session.user,
    role_name: roleName(session.user.role),
    clinics: db.prepare('SELECT * FROM clinics ORDER BY id').all(),
    equipment: db.prepare("SELECT * FROM equipment ORDER BY type, code").all(),
    users: db.prepare(`SELECT id, username, name, role, clinic_id FROM users ORDER BY id`).all(),
    instrument_types: ['止血钳', '剪刀', '持针器', '镊子', '牙科手机', '弯盘', '刀柄', '拉钩'],
    roles: { operator: '操作员', reviewer: '审核人', supervisor: '感控督导员', clinic: '诊所用户' },
    batch_statuses: ['recycled','washed','packed','sterilized','pending_bi','released','emergency_released','frozen','reworked','rejected']
  });
});

server.get('/api/dashboard', (req, res, session) => {
  const d = {};
  d.counts = {
    recycle_batches: db.prepare('SELECT COUNT(*) c FROM recycle_batches').get().c,
    ster_batches: db.prepare('SELECT COUNT(*) c FROM sterilization_batches').get().c,
    instruments: db.prepare('SELECT COUNT(*) c FROM instrument_instances').get().c,
    pending_bi: db.prepare("SELECT COUNT(*) c FROM sterilization_batches WHERE status IN ('sterilized','pending_bi','emergency_released')").get().c,
    frozen: db.prepare("SELECT COUNT(*) c FROM sterilization_batches WHERE status='frozen'").get().c,
    in_transit: db.prepare("SELECT COUNT(*) c FROM distributions WHERE status='in_transit'").get().c,
    pending_discrepancies: db.prepare("SELECT COUNT(*) c FROM discrepancies WHERE status='pending'").get().c,
    open_ncrs: db.prepare("SELECT COUNT(*) c FROM nonconformances WHERE status!='closed'").get().c,
    open_inspections: db.prepare("SELECT COUNT(*) c FROM special_inspections WHERE status!='closed'").get().c
  };
  d.recent_batches = db.prepare(`
    SELECT sb.id, sb.batch_no, sb.status, sb.sterilized_at, c.name clinic_name,
      (SELECT result FROM monitoring_results WHERE ster_batch_id=sb.id AND kind='chemical') chem,
      (SELECT result FROM monitoring_results WHERE ster_batch_id=sb.id AND kind='biological') bio,
      (SELECT COUNT(*) FROM batch_items WHERE ster_batch_id=sb.id) item_count
    FROM sterilization_batches sb JOIN recycle_batches rb ON rb.id=sb.recycle_batch_id
    JOIN clinics c ON c.id=rb.clinic_id ORDER BY sb.id DESC LIMIT 10`).all();
  if (session.user.role === 'clinic') {
    const cid = clinicOf(session);
    d.my_notifications = db.prepare('SELECT * FROM notifications WHERE clinic_id=? ORDER BY id DESC LIMIT 20').all(cid);
    d.my_instruments = db.prepare(`
      SELECT i.uid, i.instrument_type, d.status dist_status, d.first_used_at, sb.batch_no
      FROM distributions d JOIN instrument_instances i ON i.id=d.instrument_id
      JOIN sterilization_batches sb ON sb.id=d.ster_batch_id
      WHERE d.clinic_id=? ORDER BY d.id DESC LIMIT 20`).all(cid);
    d.my_discrepancies = db.prepare(`SELECT * FROM discrepancies WHERE clinic_id=? ORDER BY id DESC`).all(cid);
    d.my_recalls = db.prepare(`SELECT r.*, i.uid FROM recall_tasks r LEFT JOIN instrument_instances i ON i.id=r.instrument_id WHERE r.clinic_id=? ORDER BY r.id DESC LIMIT 20`).all(cid);
  }
  ok(res, d);
});

// ---------- 租赁单 ----------
server.get('/api/orders', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare(`SELECT o.*, c.name clinic_name FROM rental_orders o JOIN clinics c ON c.id=o.clinic_id
      WHERE o.clinic_id=? ORDER BY o.id DESC`).all(clinicOf(session));
  } else {
    rows = db.prepare(`SELECT o.*, c.name clinic_name FROM rental_orders o JOIN clinics c ON c.id=o.clinic_id ORDER BY o.id DESC`).all();
  }
  ok(res, rows);
});
server.post('/api/orders', (req, res, session) => {
  if (!requireRole(res, session, STAFF)) return;
  readBody(req).then((b) => {
    if (!b.clinic_id) return fail(res, 400, '请选择诊所');
    const no = b.order_no || genNo('ZL');
    const id = db.prepare(`INSERT INTO rental_orders(order_no,clinic_id,expect_date,status,note,created_at)
      VALUES(?,?,?,?,?,?)`).run(no, b.clinic_id, b.expect_date || null, b.status || 'open', b.note || null, now()).lastInsertRowid;
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'CREATE', entity: 'rental_orders', entity_id: id, detail: b });
    ok(res, { id, order_no: no });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 回收批次 ----------
function getRecycleDetail(id) {
  const batch = db.prepare(`SELECT rb.*, c.name clinic_name, u.name receiver_name
    FROM recycle_batches rb JOIN clinics c ON c.id=rb.clinic_id
    LEFT JOIN users u ON u.id=rb.receiver_id WHERE rb.id=?`).get(id);
  if (!batch) return null;
  batch.items = db.prepare('SELECT * FROM recycle_items WHERE recycle_batch_id=? ORDER BY seq,id').all(id);
  batch.discrepancies = db.prepare(`SELECT d.*, u.name confirmer_name FROM discrepancies d
    LEFT JOIN users u ON u.id=d.confirmed_by WHERE d.recycle_batch_id=? ORDER BY d.id`).all(id);
  batch.wash = db.prepare(`SELECT w.*, e.code equipment_code, u.name operator_name FROM wash_records w
    LEFT JOIN equipment e ON e.id=w.equipment_id LEFT JOIN users u ON u.id=w.operator_id
    WHERE w.recycle_batch_id=? ORDER BY w.id DESC`).all(id);
  return batch;
}

server.get('/api/recycles', (req, res, session) => {
  let rows;
  if (session.user.role === 'clinic') {
    rows = db.prepare(`SELECT rb.*, c.name clinic_name FROM recycle_batches rb JOIN clinics c ON c.id=rb.clinic_id
      WHERE rb.clinic_id=? ORDER BY rb.id DESC`).all(clinicOf(session));
  } else {
    rows = db.prepare(`SELECT rb.*, c.name clinic_name FROM recycle_batches rb JOIN clinics c ON c.id=rb.clinic_id ORDER BY rb.id DESC`).all();
  }
  ok(res, rows);
});
server.get('/api/recycles/:id', (req, res, session, p) => {
  const detail = getRecycleDetail(Number(p.id));
  if (!detail) return fail(res, 404, '回收批次不存在');
  if (session.user.role === 'clinic' && detail.clinic_id !== clinicOf(session)) return fail(res, 403, '无权查看其他诊所批次');
  ok(res, detail);
});
server.post('/api/recycles', (req, res, session) => {
  if (!requireRole(res, session, STAFF)) return;
  readBody(req).then((b) => {
    if (!b.clinic_id) return fail(res, 400, '请选择诊所');
    if (!Array.isArray(b.items) || b.items.length === 0) return fail(res, 400, '至少清点一种器械');
    const no = b.batch_no || genNo('HS');
    const tx = txWrap(() => {
      const rbId = db.prepare(`INSERT INTO recycle_batches(batch_no,clinic_id,order_id,status,received_at,receiver_id,note)
        VALUES(?,?,?,?,?,?,?)`).run(no, b.clinic_id, b.order_id || null, 'recycled', now(), session.user.id, b.note || null).lastInsertRowid;
      const insItem = db.prepare(`INSERT INTO recycle_items(recycle_batch_id,instrument_type,expected_qty,received_qty,appearance,function_status,issue_note,seq)
        VALUES(?,?,?,?,?,?,?,?)`);
      const insDisc = db.prepare(`INSERT INTO discrepancies(recycle_batch_id,clinic_id,instrument_type,kind,qty,detail,status,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      b.items.forEach((it, idx) => {
        const expected = Number(it.expected_qty) || 0;
        const received = Number(it.received_qty) || 0;
        const appearance = it.appearance || 'ok';
        const func = it.function_status || 'ok';
        insItem.run(rbId, it.instrument_type, expected, received, appearance, func, it.issue_note || null, idx + 1);
        if (received < expected) {
          insDisc.run(rbId, b.clinic_id, it.instrument_type, 'missing', expected - received,
            `应收 ${expected}，实收 ${received}，缺失 ${expected - received} 件` + (it.issue_note ? `；${it.issue_note}` : ''),
            'pending', now(), session.user.id);
        }
        if (appearance === 'damaged' || appearance === 'dirty') {
          insDisc.run(rbId, b.clinic_id, it.instrument_type, 'damaged', received,
            `外观状态：${appearance === 'damaged' ? '损坏' : '明显污染'}` + (it.issue_note ? `；${it.issue_note}` : ''),
            'pending', now(), session.user.id);
        }
        if (func === 'fault') {
          insDisc.run(rbId, b.clinic_id, it.instrument_type, 'fault', received,
            `功能检查异常` + (it.issue_note ? `；${it.issue_note}` : ''), 'pending', now(), session.user.id);
        }
      });
      if (b.order_id) db.prepare("UPDATE rental_orders SET status='processing' WHERE id=?").run(b.order_id);
      const discCount = db.prepare('SELECT COUNT(*) c FROM discrepancies WHERE recycle_batch_id=?').get(rbId).c;
      if (discCount > 0) notify(b.clinic_id, `回收批次 ${no} 有 ${discCount} 条差异待确认`, '请在差异确认中核对缺失/损坏器械', 'discrepancy', 'recycle', rbId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'RECYCLE_CREATE', entity: 'recycle_batches', entity_id: rbId, detail: { batch_no: no, item_types: b.items.length, discrepancies: discCount } });
      return rbId;
    });
    const id = tx();
    ok(res, { id, batch_no: no });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 差异记录确认（诊所端） ----------
server.post('/api/discrepancies/:id/confirm', (req, res, session, p) => {
  readBody(req).then((b) => {
    const d = db.prepare('SELECT * FROM discrepancies WHERE id=?').get(Number(p.id));
    if (!d) return fail(res, 404, '差异记录不存在');
    if (session.user.role === 'clinic') {
      if (d.clinic_id !== clinicOf(session)) return fail(res, 403, '只能确认本诊所差异');
    } else if (!STAFF.includes(session.user.role)) return fail(res, 403, '无权限');
    if (d.status !== 'pending') return fail(res, 400, '该差异已处理');
    const accept = b.action !== 'reject';
    db.prepare("UPDATE discrepancies SET status=?, clinic_reply=?, confirmed_by=?, confirmed_at=? WHERE id=?")
      .run(accept ? 'confirmed' : 'rejected', b.reply || null, session.user.id, now(), d.id);
    logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'DISCREPANCY_' + (accept ? 'CONFIRM' : 'REJECT'), entity: 'discrepancies', entity_id: d.id, detail: b });
    ok(res, { status: accept ? 'confirmed' : 'rejected' });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 清洗消毒 ----------
server.post('/api/recycles/:id/wash', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const rbId = Number(p.id);
  readBody(req).then((b) => {
    const rb = db.prepare('SELECT * FROM recycle_batches WHERE id=?').get(rbId);
    if (!rb) return fail(res, 404, '回收批次不存在');
    if (rb.status === 'frozen') return fail(res, 400, '批次已冻结，不能清洗');
    if (!b.equipment_id || !b.program) return fail(res, 400, '设备与程序必填');
    const tx = txWrap(() => {
      const id = db.prepare(`INSERT INTO wash_records(recycle_batch_id,equipment_id,program,temperature,duration_min,operator_id,washed_at,note)
        VALUES(?,?,?,?,?,?,?,?)`).run(rbId, b.equipment_id, b.program, b.temperature ?? null, b.duration_min ?? null,
        session.user.id, now(), b.note || null).lastInsertRowid;
      if (rb.status === 'recycled') db.prepare("UPDATE recycle_batches SET status='washed' WHERE id=?").run(rbId);
      db.prepare("UPDATE instrument_instances SET status='washed' WHERE recycle_batch_id=? AND status IN ('recycled','frozen')").run(rbId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'WASH', entity: 'recycle_batches', entity_id: rbId, detail: b });
      return id;
    });
    ok(res, { id: tx() });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 包装：逐件赋唯一标识并与批次绑定 ----------
server.post('/api/recycles/:id/pack', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const rbId = Number(p.id);
  readBody(req).then((b) => {
    const rb = db.prepare('SELECT * FROM recycle_batches WHERE id=?').get(rbId);
    if (!rb) return fail(res, 404, '回收批次不存在');
    const washed = db.prepare('SELECT COUNT(*) c FROM wash_records WHERE recycle_batch_id=?').get(rbId).c;
    if (!washed) return fail(res, 400, '请先完成清洗消毒登记');
    const existing = db.prepare('SELECT COUNT(*) c FROM instrument_instances WHERE recycle_batch_id=?').get(rbId).c;
    if (existing > 0 && !b.force) return fail(res, 409, '该批次已完成包装赋码', { existing_count: existing });

    const items = db.prepare('SELECT * FROM recycle_items WHERE recycle_batch_id=?').all(rbId);
    const tx = txWrap(() => {
      const created = [];
      for (const it of items) {
        for (let n = 0; n < it.received_qty; n++) {
          const uid = genNo('UID-').replace('UID-', 'UID-') + '-' + String(it.id).padStart(2, '0') + String(n + 1).padStart(2, '0');
          // 简化：UID-YYYYMMDD-NNN-项次序号，保证唯一
          const id = db.prepare(`INSERT INTO instrument_instances(uid,instrument_type,recycle_item_id,recycle_batch_id,status,created_at)
            VALUES(?,?,?,?,?,?)`).run(uid, it.instrument_type, it.id, rbId, 'packed', now()).lastInsertRowid;
          created.push({ id, uid, instrument_type: it.instrument_type });
        }
      }
      db.prepare("UPDATE recycle_batches SET status='packed' WHERE id=?").run(rbId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'PACK', entity: 'recycle_batches', entity_id: rbId, detail: { count: created.length } });
      return created;
    });
    ok(res, { instruments: tx() });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 灭菌登记 ----------
server.get('/api/sterilizations', (req, res, session) => {
  const rows = db.prepare(`SELECT sb.*, rb.batch_no recycle_no, c.name clinic_name, e.code sterilizer_code,
    u.name operator_name, ur.name release_name
    FROM sterilization_batches sb
    JOIN recycle_batches rb ON rb.id=sb.recycle_batch_id
    JOIN clinics c ON c.id=rb.clinic_id
    JOIN equipment e ON e.id=sb.sterilizer_id
    LEFT JOIN users u ON u.id=sb.operator_id
    LEFT JOIN users ur ON ur.id=sb.released_by
    ORDER BY sb.id DESC`).all();
  for (const sb of rows) {
    sb.chemical = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='chemical'").get(sb.id);
    sb.biological = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='biological'").get(sb.id);
    sb.item_count = db.prepare('SELECT COUNT(*) c FROM batch_items WHERE ster_batch_id=?').get(sb.id).c;
    sb.distributed_count = db.prepare('SELECT COUNT(*) c FROM distributions WHERE ster_batch_id=?').get(sb.id).c;
  }
  ok(res, rows);
});

server.get('/api/sterilizations/:id', (req, res, session, p) => {
  const sb = sterDetail(Number(p.id));
  if (!sb) return fail(res, 404, '灭菌批次不存在');
  if (session.user.role === 'clinic' && sb.clinic_id !== clinicOf(session)) return fail(res, 403, '无权查看');
  ok(res, sb);
});

server.post('/api/recycles/:id/sterilize', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const rbId = Number(p.id);
  readBody(req).then((b) => {
    const rb = db.prepare('SELECT * FROM recycle_batches WHERE id=?').get(rbId);
    if (!rb) return fail(res, 404, '回收批次不存在');
    if (!['packed','washed','frozen'].includes(rb.status) && !b.rework) return fail(res, 400, `当前批次状态(${rb.status})不能灭菌登记`);
    const insts = db.prepare("SELECT * FROM instrument_instances WHERE recycle_batch_id=? AND status!='scrapped'").all(rbId);
    if (insts.length === 0) return fail(res, 400, '批次内没有已包装器械，请先完成包装');
    if (!b.sterilizer_id) return fail(res, 400, '请选择灭菌器');
    const tx = txWrap(() => {
      const no = b.batch_no || genNo('MJ');
      const sbId = db.prepare(`INSERT INTO sterilization_batches
        (batch_no,recycle_batch_id,sterilizer_id,load_diagram,temperature,pressure,duration_min,cycle_params,status,sterilized_at,operator_id,reworked_from_batch_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(no, rbId, b.sterilizer_id, b.load_diagram || null, b.temperature ?? null, b.pressure ?? null,
          b.duration_min ?? null, b.cycle_params || null, 'sterilized', now(), session.user.id, b.reworked_from || null).lastInsertRowid;
      const bind = db.prepare('INSERT INTO batch_items(ster_batch_id,instrument_id) VALUES(?,?)');
      const upd = db.prepare('UPDATE instrument_instances SET status=?, last_ster_batch_id=? WHERE id=?');
      for (const i of insts) { bind.run(sbId, i.id); upd.run('sterilized', sbId, i.id); }
      db.prepare("UPDATE recycle_batches SET status='sterilized' WHERE id=?").run(rbId);
      db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,note)
        VALUES(?,?,?,?,?,?,?)`).run(sbId, 'chemical', b.chemical_result === 'pass' ? 'pass' : (b.chemical_result === 'fail' ? 'fail' : 'pending'),
          b.chemical_value || null, session.user.id, now(), b.chemical_note || null);
      db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,note)
        VALUES(?,?,?,?,?,?,?)`).run(sbId, 'biological', b.biological_result === 'pass' ? 'pass' : (b.biological_result === 'fail' ? 'fail' : 'pending'),
          b.biological_value || (b.biological_result ? null : '培养中'), session.user.id, now(), b.biological_note || null);
      const bioFail = b.biological_result === 'fail';
      const chemFail = b.chemical_result === 'fail';
      let status;
      if (bioFail || chemFail) status = 'frozen';
      else if (b.biological_result === 'pass' && !chemFail) status = 'sterilized';
      else status = 'pending_bi';
      if (status === 'frozen') {
        db.prepare('UPDATE sterilization_batches SET status=?, frozen_at=?, freeze_reason=? WHERE id=?')
          .run('frozen', now(), bioFail ? '生物监测阳性' : '化学监测不合格', sbId);
      } else {
        db.prepare('UPDATE sterilization_batches SET status=? WHERE id=?').run(status, sbId);
      }
      db.prepare("UPDATE recycle_batches SET status=? WHERE id=?").run(status, rbId);
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'STERILIZE', entity: 'sterilization_batches', entity_id: sbId, detail: { batch_no: no, count: insts.length, chemical: b.chemical_result, biological: b.biological_result } });
      if (status === 'frozen') freezeBatch(sbId, session, bioFail ? '生物监测阳性' : '化学监测不合格');
      return sbId;
    });
    const sbId = tx();
    ok(res, { id: sbId, detail_url: `/api/sterilizations/${sbId}` });
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 监测结果录入/更新（带理由的追加式修改） ----------
server.post('/api/sterilizations/:id/monitoring', (req, res, session, p) => {
  if (!requireRole(res, session, STAFF)) return;
  const sbId = Number(p.id);
  readBody(req).then((b) => {
    const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(sbId);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    if (!['chemical', 'biological', 'bd_test'].includes(b.kind)) return fail(res, 400, '监测类型错误');
    if (!['pass', 'fail', 'pending', 'na'].includes(b.result)) return fail(res, 400, '监测结果错误');
    const existing = db.prepare('SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind=?').get(sbId, b.kind);
    const tx = txWrap(() => {
      if (!existing) {
        db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,issued_at,note)
          VALUES(?,?,?,?,?,?,?,?)`).run(sbId, b.kind, b.result, b.value_text || null, session.user.id, now(),
            b.result === 'pending' ? null : now(), b.note || null);
        logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'MONITOR_CREATE', entity: 'monitoring_results', entity_id: sbId, detail: { kind: b.kind, result: b.result } });
      } else {
        // 待检 -> 正式结果属于首次出具，不需要理由；正式结果之间的改动才必须填写修改理由
        if (existing.result !== b.result && existing.result !== 'pending' && !b.reason) throw new Error('监测结果发生变化必须填写修改理由');
        addHistory('monitoring_results', existing.id, 'result', existing.result, b.result, b.reason || '补充记录', session.user.id);
        if (b.value_text !== undefined) addHistory('monitoring_results', existing.id, 'value_text', existing.value_text, b.value_text, b.reason || '补充记录', session.user.id);
        db.prepare('UPDATE monitoring_results SET result=?, value_text=?, tested_by=?, tested_at=?, issued_at=?, note=? WHERE id=?')
          .run(b.result, b.value_text ?? existing.value_text, session.user.id, now(),
            b.result === 'pending' ? existing.issued_at : (existing.issued_at || now()), b.note ?? existing.note, existing.id);
        logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'MONITOR_UPDATE', entity: 'monitoring_results', entity_id: existing.id, detail: { kind: b.kind, from: existing.result, to: b.result, reason: b.reason } });
      }
      // 状态联动
      const bio = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='biological'").get(sbId);
      const chem = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='chemical'").get(sbId);
      let frozenInfo = null;
      if ((bio && bio.result === 'fail') || (chem && chem.result === 'fail')) {
        if (sb.status !== 'frozen' && sb.status !== 'reworked') frozenInfo = freezeBatch(sbId, session, bio && bio.result === 'fail' ? '生物监测阳性' : '化学监测不合格');
      } else if (bio && bio.result === 'pass' && sb.status === 'pending_bi') {
        db.prepare("UPDATE sterilization_batches SET status='sterilized' WHERE id=?").run(sbId);
      } else if (bio && bio.result === 'pending' && sb.status === 'sterilized') {
        db.prepare("UPDATE sterilization_batches SET status='pending_bi' WHERE id=?").run(sbId);
      }
      return frozenInfo;
    });
    try {
      const frozenInfo = tx();
      ok(res, { frozen: !!frozenInfo, ...(frozenInfo || {}) });
    } catch (e) {
      fail(res, 400, e.message);
    }
  }).catch((e) => fail(res, 400, e.message));
});

// ---------- 放行（仅审核人）：正式放行 / 紧急放行 ----------
function guardsForRelease(sb, emergency) {
  const bio = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='biological'").get(sb.id);
  const chem = db.prepare("SELECT * FROM monitoring_results WHERE ster_batch_id=? AND kind='chemical'").get(sb.id);
  if (sb.status === 'frozen') return '批次已冻结，禁止放行';
  if (sb.status === 'released') return '批次已放行';
  if (!chem || chem.result !== 'pass') return '化学监测不合格或未录入，不能放行';
  if (!emergency) {
    if (!bio) return '生物监测结果未录入';
    if (bio.result === 'fail') return '生物监测阳性，批次已锁定';
    if (bio.result !== 'pass') return '生物监测结果未出（待检），不能发放；如临床急需可走紧急放行';
  } else {
    if (bio && bio.result === 'pass') return '生物监测已合格，请直接正式放行';
  }
  return null;
}
server.post('/api/sterilizations/:id/release', (req, res, session, p) => {
  if (!requireRole(res, session, ['reviewer', 'supervisor'])) return;
  const sbId = Number(p.id);
  readBody(req).then((b) => {
    const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(sbId);
    if (!sb) return fail(res, 404, '灭菌批次不存在');
    const emergency = b.emergency === true;
    const err = guardsForRelease(sb, emergency);
    if (err) return fail(res, 400, err);
    if (!b.note) return fail(res, 400, '请填写放行审核意见');
    if (emergency && !b.emergency_reason) return fail(res, 400, '紧急放行必须填写紧急原因');
    const newStatus = emergency ? 'emergency_released' : 'released';
    const tx = txWrap(() => {
      addHistory('sterilization_batches', sbId, 'status', sb.status, newStatus, b.note, session.user.id);
      db.prepare('UPDATE sterilization_batches SET status=?, released_by=?, released_at=?, release_note=? WHERE id=?')
        .run(newStatus, session.user.id, now(), b.note + (emergency ? `｜紧急原因：${b.emergency_reason}` : ''), sbId);
      db.prepare("UPDATE instrument_instances SET status='released' WHERE id IN (SELECT instrument_id FROM batch_items WHERE ster_batch_id=?) AND status IN ('sterilized','washed')").run(sbId);
      db.prepare("UPDATE recycle_batches SET status=? WHERE id=?").run(newStatus, sb.recycle_batch_id);
      // 返工批次合格放行：自动闭环对应不合格处置单
      if (sb.reworked_from_batch_id) {
        const ncr = db.prepare('SELECT * FROM nonconformances WHERE new_ster_batch_id=? AND status!=?').get(sbId, 'closed');
        if (ncr) {
          addHistory('nonconformances', ncr.id, 'status', ncr.status, 'closed', '返工后重新灭菌并监测合格，放行即闭环', session.user.id);
          db.prepare("UPDATE nonconformances SET status='closed', closed_at=?, closed_by=? WHERE id=?").run(now(), session.user.id, ncr.id);
          logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: 'NCR_AUTO_CLOSE', entity: 'nonconformances', entity_id: ncr.id, detail: { released_batch: sb.batch_no } });
        }
      }
      logAudit({ actor_id: session.user.id, actor_name: session.user.name, role: session.user.role, action: emergency ? 'EMERGENCY_RELEASE' : 'RELEASE', entity: 'sterilization_batches', entity_id: sbId, detail: { note: b.note, emergency_reason: b.emergency_reason } });
    });
    tx();
    ok(res, { status: newStatus });
  }).catch((e) => fail(res, 400, e.message));
});

} // end register

module.exports = { register, freezeBatch, sterDetail };
