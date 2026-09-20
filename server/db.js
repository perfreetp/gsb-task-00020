'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.CSSD_DB || path.join(__dirname, '..', 'data', 'cssd.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('operator','reviewer','supervisor','clinic')),
  clinic_id INTEGER REFERENCES clinics(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('washer','sterilizer')),
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT
);
CREATE TABLE IF NOT EXISTS rental_orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  expect_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recycle_batches (
  id INTEGER PRIMARY KEY,
  batch_no TEXT UNIQUE NOT NULL,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  order_id INTEGER REFERENCES rental_orders(id),
  status TEXT NOT NULL CHECK(status IN ('recycled','washed','packed','sterilized','pending_bi','released','frozen','reworked','rejected')),
  received_at TEXT NOT NULL,
  receiver_id INTEGER REFERENCES users(id),
  note TEXT
);
CREATE TABLE IF NOT EXISTS recycle_items (
  id INTEGER PRIMARY KEY,
  recycle_batch_id INTEGER NOT NULL REFERENCES recycle_batches(id),
  instrument_type TEXT NOT NULL,
  expected_qty INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0,
  appearance TEXT CHECK(appearance IN ('ok','damaged','dirty','')),
  function_status TEXT CHECK(function_status IN ('ok','fault','')),
  issue_note TEXT,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discrepancies (
  id INTEGER PRIMARY KEY,
  recycle_batch_id INTEGER NOT NULL REFERENCES recycle_batches(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  instrument_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('missing','damaged','surplus','fault')),
  qty INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','closed')),
  clinic_reply TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS instrument_instances (
  id INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  instrument_type TEXT NOT NULL,
  recycle_item_id INTEGER REFERENCES recycle_items(id),
  recycle_batch_id INTEGER REFERENCES recycle_batches(id),
  status TEXT NOT NULL CHECK(status IN ('recycled','washed','packed','sterilized','released','in_transit','in_use','frozen','recalled','reworked','scrapped')),
  current_clinic_id INTEGER REFERENCES clinics(id),
  last_ster_batch_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wash_records (
  id INTEGER PRIMARY KEY,
  recycle_batch_id INTEGER NOT NULL REFERENCES recycle_batches(id),
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  program TEXT NOT NULL,
  temperature REAL,
  duration_min INTEGER,
  operator_id INTEGER REFERENCES users(id),
  washed_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS sterilization_batches (
  id INTEGER PRIMARY KEY,
  batch_no TEXT UNIQUE NOT NULL,
  recycle_batch_id INTEGER NOT NULL REFERENCES recycle_batches(id),
  sterilizer_id INTEGER NOT NULL REFERENCES equipment(id),
  load_diagram TEXT,
  temperature REAL,
  pressure REAL,
  duration_min INTEGER,
  cycle_params TEXT,
  status TEXT NOT NULL CHECK(status IN ('sterilized','pending_bi','released','emergency_released','frozen','reworked','rejected')),
  sterilized_at TEXT NOT NULL,
  operator_id INTEGER REFERENCES users(id),
  released_by INTEGER REFERENCES users(id),
  released_at TEXT,
  release_note TEXT,
  reworked_from_batch_id INTEGER REFERENCES sterilization_batches(id),
  frozen_at TEXT,
  freeze_reason TEXT
);
CREATE TABLE IF NOT EXISTS batch_items (
  id INTEGER PRIMARY KEY,
  ster_batch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  instrument_id INTEGER NOT NULL REFERENCES instrument_instances(id),
  UNIQUE(ster_batch_id, instrument_id)
);
CREATE TABLE IF NOT EXISTS monitoring_results (
  id INTEGER PRIMARY KEY,
  ster_batch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  kind TEXT NOT NULL CHECK(kind IN ('chemical','biological','bd_test')),
  result TEXT NOT NULL CHECK(result IN ('pass','fail','pending','na')),
  value_text TEXT,
  tested_by INTEGER REFERENCES users(id),
  tested_at TEXT NOT NULL,
  issued_at TEXT,
  note TEXT,
  UNIQUE(ster_batch_id, kind)
);
CREATE TABLE IF NOT EXISTS distributions (
  id INTEGER PRIMARY KEY,
  ster_batch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  instrument_id INTEGER NOT NULL REFERENCES instrument_instances(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  handover_person TEXT,
  handed_at TEXT NOT NULL,
  operator_id INTEGER REFERENCES users(id),
  receive_person TEXT,
  received_at TEXT,
  first_used_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('in_transit','received','in_use','recalled','returned')),
  recalled_at TEXT,
  recall_task_id INTEGER
);
CREATE TABLE IF NOT EXISTS recall_tasks (
  id INTEGER PRIMARY KEY,
  ster_batch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  clinic_id INTEGER REFERENCES clinics(id),
  instrument_id INTEGER REFERENCES instrument_instances(id),
  distribution_id INTEGER REFERENCES distributions(id),
  channel TEXT NOT NULL DEFAULT 'system_push',
  status TEXT NOT NULL DEFAULT 'notified' CHECK(status IN ('notified','acknowledged','returned','cancelled')),
  notified_at TEXT NOT NULL,
  acknowledged_at TEXT,
  returned_at TEXT,
  message TEXT
);
CREATE TABLE IF NOT EXISTS nonconformances (
  id INTEGER PRIMARY KEY,
  ncr_no TEXT UNIQUE NOT NULL,
  ster_batch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  reason TEXT,
  root_cause_analysis TEXT,
  corrective_action TEXT,
  preventive_action TEXT,
  rework_required INTEGER NOT NULL DEFAULT 1,
  new_ster_batch_id INTEGER REFERENCES sterilization_batches(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','analyzing','reworking','closed')),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS special_inspections (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  ster_batch_id INTEGER REFERENCES sterilization_batches(id),
  trigger_reason TEXT,
  findings TEXT,
  rectification TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rectifying','closed')),
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS field_history (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_exports (
  id INTEGER PRIMARY KEY,
  report_type TEXT NOT NULL,
  params TEXT,
  file_name TEXT,
  exported_by INTEGER REFERENCES users(id),
  exported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER REFERENCES clinics(id),
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT,
  kind TEXT NOT NULL DEFAULT 'info',
  ref_type TEXT,
  ref_id INTEGER,
  read_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inst_status ON instrument_instances(status);
CREATE INDEX IF NOT EXISTS idx_inst_type ON instrument_instances(instrument_type);
CREATE INDEX IF NOT EXISTS idx_batch_items_inst ON batch_items(instrument_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(ster_batch_id);
CREATE INDEX IF NOT EXISTS idx_dist_inst ON distributions(instrument_id);
CREATE INDEX IF NOT EXISTS idx_dist_batch ON distributions(ster_batch_id);
CREATE INDEX IF NOT EXISTS idx_hist_entity ON field_history(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`;

db.exec(SCHEMA);

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}
function now() { return new Date().toISOString(); }

function tx(fn) {
  return function runTx() {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
}


function logAudit(entry) {
  db.prepare(`INSERT INTO audit_logs(actor_id, actor_name, role, action, entity, entity_id, detail, ip, created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(entry.actor_id ?? null, entry.actor_name ?? null, entry.role ?? null,
         entry.action, entry.entity ?? null, entry.entity_id ?? null,
         entry.detail ? JSON.stringify(entry.detail) : null, entry.ip ?? null, now());
}
function addHistory(entity, entityId, field, oldValue, newValue, reason, userId) {
  db.prepare(`INSERT INTO field_history(entity, entity_id, field, old_value, new_value, reason, changed_by, changed_at)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(entity, entityId, field, oldValue == null ? null : String(oldValue),
         newValue == null ? null : String(newValue), reason, userId, now());
}

function seed() {
  db.exec('PRAGMA foreign_keys=OFF;');
  const tables = ['audit_logs','field_history','report_exports','notifications','special_inspections',
    'nonconformances','recall_tasks','distributions','monitoring_results','batch_items',
    'sterilization_batches','wash_records','instrument_instances','discrepancies','recycle_items',
    'recycle_batches','rental_orders','equipment','users','clinics'];
  for (const t of tables) db.exec('DELETE FROM ' + t + ';');
  db.exec('PRAGMA foreign_keys=ON;');

  const t0 = Date.now();
  const iso = (minsAgo) => new Date(t0 - minsAgo * 60000).toISOString();
  const addUser = (username, password, name, role, clinicId) => {
    const { salt, hash } = hashPassword(password);
    return db.prepare(`INSERT INTO users(username,password_hash,salt,name,role,clinic_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(username, hash, salt, name, role, clinicId ?? null, iso(10080)).lastInsertRowid;
  };
  const c1 = db.prepare("INSERT INTO clinics(name,contact,phone,created_at) VALUES('康美口腔诊所','王护士长','13800000001',?)").run(iso(10080)).lastInsertRowid;
  const c2 = db.prepare("INSERT INTO clinics(name,contact,phone,created_at) VALUES('仁和综合门诊部','李主任','13800000002',?)").run(iso(10080)).lastInsertRowid;
  const c3 = db.prepare("INSERT INTO clinics(name,contact,phone,created_at) VALUES('惠民社区卫生服务中心','赵护士','13800000003',?)").run(iso(10080)).lastInsertRowid;

  addUser('operator','123456','张操作','operator');
  addUser('operator2','123456','陈清洗','operator');
  const revId = addUser('reviewer','123456','刘放行','reviewer');
  addUser('supervisor','123456','周督导','supervisor');
  addUser('clinic1','123456','王护士长','clinic', c1);
  addUser('clinic2','123456','李主任','clinic', c2);
  addUser('clinic3','123456','赵护士','clinic', c3);

  const w1 = db.prepare("INSERT INTO equipment(code,name,type,status) VALUES('WASHER-A01','全自动清洗消毒机1号','washer','active')").run().lastInsertRowid;
  db.prepare("INSERT INTO equipment(code,name,type,status,note) VALUES('STE-B02','脉动真空灭菌器2号','sterilizer','active','密封圈老化，待检修')").run();
  const s1 = db.prepare("INSERT INTO equipment(code,name,type,status) VALUES('STE-B01','脉动真空灭菌器1号','sterilizer','active')").run().lastInsertRowid;

  const o1 = db.prepare("INSERT INTO rental_orders(order_no,clinic_id,expect_date,status,note,created_at) VALUES(?,?,?,?,?,?)")
    .run('ZL20260919-001', c1, iso(1440), 'processing', '周租器械包', iso(2880)).lastInsertRowid;
  db.prepare("INSERT INTO rental_orders(order_no,clinic_id,expect_date,status,note,created_at) VALUES(?,?,?,?,?,?)")
    .run('ZL20260920-002', c3, iso(0), 'open', '常规补充', iso(600));

  // ---- 演示批次1：合格历史批次（完整走完全流程，用于正向演示） ----
  const rb1 = db.prepare(`INSERT INTO recycle_batches(batch_no,clinic_id,order_id,status,received_at,receiver_id,note)
    VALUES(?,?,?,?,?,?,?)`).run('HS20260919-01', c3, 2, 'released', iso(2880), 1, '历史合格批次').lastInsertRowid;
  const ri1 = db.prepare(`INSERT INTO recycle_items(recycle_batch_id,instrument_type,expected_qty,received_qty,appearance,function_status,seq)
    VALUES(?,?,?,?,?,?,?)`).run(rb1, '止血钳', 6, 6, 'ok', 'ok', 1).lastInsertRowid;
  db.prepare(`INSERT INTO recycle_items(recycle_batch_id,instrument_type,expected_qty,received_qty,appearance,function_status,seq)
    VALUES(?,?,?,?,?,?,?)`).run(rb1, '剪刀', 4, 4, 'ok', 'ok', 2);
  db.prepare(`INSERT INTO wash_records(recycle_batch_id,equipment_id,program,temperature,duration_min,operator_id,washed_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(rb1, w1, '标准器械清洗程序', 93.0, 45, 2, iso(2700), 'A0值合格');
  const instIds1 = [];
  for (let i = 1; i <= 6; i++) {
    instIds1.push(db.prepare(`INSERT INTO instrument_instances(uid,instrument_type,recycle_item_id,recycle_batch_id,status,created_at)
      VALUES(?,?,?,?,?,?)`).run(`UID-000${i}`, '止血钳', ri1, rb1, 'released', iso(2600)).lastInsertRowid);
  }
  const sb1 = db.prepare(`INSERT INTO sterilization_batches(batch_no,recycle_batch_id,sterilizer_id,load_diagram,temperature,pressure,duration_min,cycle_params,status,sterilized_at,operator_id,released_by,released_at,release_note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('MJ20260919-01', rb1, s1, '装载图A：上层6把止血钳', 134.0, 210.0, 8, '脉动3次/干燥15min', 'released', iso(2400), 1, revId, iso(1440), '化学、生物监测合格，同意放行').lastInsertRowid;
  const insBI = db.prepare(`INSERT INTO batch_items(ster_batch_id,instrument_id) VALUES(?,?)`);
  instIds1.forEach(id => insBI.run(sb1, id));
  db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,issued_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(sb1, 'chemical', 'pass', '包外/包内化学指示卡变色合格', 1, iso(2390), iso(2390), null);
  db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,issued_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(sb1, 'biological', 'pass', '嗜热脂肪杆菌芽孢培养阴性', 2, iso(2390), iso(1440), '快速生物阅读器结果阴性');
  for (let i = 0; i < 4; i++) {
    const d = db.prepare(`INSERT INTO distributions(ster_batch_id,instrument_id,clinic_id,handover_person,handed_at,operator_id,receive_person,received_at,first_used_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(sb1, instIds1[i], c3, '库房-孙师傅', iso(1380), 1, '赵护士', iso(1320), iso(900), i < 2 ? 'in_use' : 'received').lastInsertRowid;
  }

  // ---- 演示批次2：待生物监测批次（典型阳性召回场景的"前一秒"状态） ----
  // 12 件器械：8 把止血钳 + 4 把剪刀；化学监测合格，生物监测待检；
  // 审核人已做紧急放行：5 件发往康美(3)/仁和(2)，其中 3 件已被签收、2 件在途；7 件在库。
  const rb2 = db.prepare(`INSERT INTO recycle_batches(batch_no,clinic_id,order_id,status,received_at,receiver_id,note)
    VALUES(?,?,?,?,?,?,?)`).run('HS20260920-02', c1, o1, 'pending_bi', iso(360), 1, '待生物监测结果，演示批次').lastInsertRowid;
  const ri2a = db.prepare(`INSERT INTO recycle_items(recycle_batch_id,instrument_type,expected_qty,received_qty,appearance,function_status,seq)
    VALUES(?,?,?,?,?,?,?)`).run(rb2, '止血钳', 8, 8, 'ok', 'ok', 1).lastInsertRowid;
  db.prepare(`INSERT INTO recycle_items(recycle_batch_id,instrument_type,expected_qty,received_qty,appearance,function_status,seq)
    VALUES(?,?,?,?,?,?,?)`).run(rb2, '剪刀', 4, 4, 'ok', 'ok', 2);
  db.prepare(`INSERT INTO discrepancies(recycle_batch_id,clinic_id,instrument_type,kind,qty,detail,status,created_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(rb2, c1, '持针器', 'missing', 1, '租赁单应收1把持针器，回收时未见，当场标注待诊所确认', 'pending', iso(355), 1);
  db.prepare(`INSERT INTO wash_records(recycle_batch_id,equipment_id,program,temperature,duration_min,operator_id,washed_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(rb2, w1, '精细器械程序', 90.0, 50, 2, iso(300), null);

  const uids = [];
  for (let i = 7; i <= 14; i++) {
    uids.push(db.prepare(`INSERT INTO instrument_instances(uid,instrument_type,recycle_item_id,recycle_batch_id,status,last_ster_batch_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(`UID-000${i}0`, i <= 14 ? '止血钳' : '止血钳', ri2a, rb2, 'released', null, iso(240)).lastInsertRowid);
  }
  // 上面循环先放 8 把止血钳 UID-00070..00140；再补 4 把剪刀
  const scIds = [];
  for (const code of ['UID-00150','UID-00160','UID-00170','UID-00180']) {
    scIds.push(db.prepare(`INSERT INTO instrument_instances(uid,instrument_type,recycle_item_id,recycle_batch_id,status,created_at)
      VALUES(?,?,?,?,?,?)`).run(code, '剪刀', ri2a + 1, rb2, 'released', iso(240)).lastInsertRowid);
  }
  const all12 = uids.concat(scIds);

  const sB02 = db.prepare("SELECT id FROM equipment WHERE code='STE-B02'").get().id;
  const sb2 = db.prepare(`INSERT INTO sterilization_batches(batch_no,recycle_batch_id,sterilizer_id,load_diagram,temperature,pressure,duration_min,cycle_params,status,sterilized_at,operator_id,released_by,released_at,release_note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('MJ20260920-02', rb2, sB02, '装载图B：8止血钳+4剪刀，单层平铺', 134.2, 205.0, 7, '脉动3次/干燥12min', 'emergency_released', iso(180), 1, revId, iso(60), '急诊手术急用，化学监测合格，生物监测待检，审核人紧急放行并持续跟踪BI结果').lastInsertRowid;
  all12.forEach(id => {
    db.prepare(`INSERT INTO batch_items(ster_batch_id,instrument_id) VALUES(?,?)`).run(sb2, id);
    db.prepare('UPDATE instrument_instances SET last_ster_batch_id=?, status=? WHERE id=?').run(sb2, 'released', id);
  });
  db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,issued_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(sb2, 'chemical', 'pass', '第5类化学指示物合格', 1, iso(175), iso(175), null);
  db.prepare(`INSERT INTO monitoring_results(ster_batch_id,kind,result,value_text,tested_by,tested_at,issued_at,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(sb2, 'biological', 'pending', '培养中（3小时快速阅读）', 2, iso(175), null, '结果待出具');

  // 5 件已发：康美 3（UID-00070 已使用 / 00080 已签收 / 00090 在途），仁和 2（00150 已签收 / 00160 在途）
  const ship = (uid, clinic, person, rperson, used, status, mins) => {
    const inst = db.prepare('SELECT id FROM instrument_instances WHERE uid=?').get(uid).id;
    const handed = iso(mins);
    const received = rperson ? iso(mins - 5) : null;
    const firstUsed = used ? iso(mins - 30) : null;
    db.prepare(`INSERT INTO distributions(ster_batch_id,instrument_id,clinic_id,handover_person,handed_at,operator_id,receive_person,received_at,first_used_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sb2, inst, clinic, person, handed, 1, rperson, received, firstUsed, status);
    db.prepare('UPDATE instrument_instances SET status=?, current_clinic_id=? WHERE id=?')
      .run(used ? 'in_use' : (status === 'in_transit' ? 'in_transit' : 'released'), clinic, inst);
  };
  ship('UID-00070', c1, '库房-孙师傅', '王护士长', true, 'in_use', 50);
  ship('UID-00080', c1, '库房-孙师傅', '王护士长', false, 'received', 45);
  ship('UID-00090', c1, '库房-孙师傅', null, false, 'in_transit', 20);
  ship('UID-00150', c2, '配送-郑师傅', '李主任', false, 'received', 40);
  ship('UID-00160', c2, '配送-郑师傅', null, false, 'in_transit', 15);

  logAudit({ actor_id: revId, actor_name: '刘放行', role: 'reviewer', action: 'EMERGENCY_RELEASE', entity: 'sterilization_batches', entity_id: sb2, detail: { note: '急诊急用，BI待检紧急放行12件' } });
  logAudit({ actor_id: 1, actor_name: '张操作', role: 'operator', action: 'SEED', entity: 'system', detail: { message: '演示数据初始化完成' } });

  console.log('Seed complete.');
  console.log('待检批次: MJ20260920-02 (12件; 5件已发康美/仁和; 7件在库; BI=pending)');
  console.log('合格批次: MJ20260919-01');
}

if (require.main === module && process.argv.includes('--seed')) {
  seed();
}

module.exports = { db, seed, tx, hashPassword, verifyPassword, now, logAudit, addHistory };
