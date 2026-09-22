// 演示数据：账号、诊所、器械、正常批次，以及典型「生物监测阳性→锁定召回→重处理」场景
const db = require('./db');
const { now, genNo, makeSalt, hashPassword } = require('./util');
const { audit, addVersion, notify } = require('./auth');

db.exec(`
  DROP TRIGGER IF EXISTS trg_audit_no_del;
  DROP TRIGGER IF EXISTS trg_audit_no_upd;
  DROP TRIGGER IF EXISTS trg_hv_no_del;
  DROP TRIGGER IF EXISTS trg_hv_no_upd;
  PRAGMA foreign_keys=OFF;
  DELETE FROM sessions; DELETE FROM audit_logs; DELETE FROM history_versions; DELETE FROM export_logs;
  DELETE FROM notifications; DELETE FROM nonconformances; DELETE FROM recall_items; DELETE FROM recalls;
  DELETE FROM usages; DELETE FROM distribution_items; DELETE FROM distributions; DELETE FROM releases;
  DELETE FROM monitorings; DELETE FROM sterilization_items; DELETE FROM sterilization_batches;
  DELETE FROM package_items; DELETE FROM packages; DELETE FROM wash_items; DELETE FROM wash_batches;
  DELETE FROM discrepancies; DELETE FROM recovery_items; DELETE FROM recovery_batches;
  DELETE FROM rental_orders; DELETE FROM instruments; DELETE FROM clinics; DELETE FROM users;
  DELETE FROM inspections;
  DELETE FROM sqlite_sequence;
  PRAGMA foreign_keys=ON;
`);
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_audit_no_del BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, '审计日志不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_upd BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, '审计日志不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_hv_no_del BEFORE DELETE ON history_versions
BEGIN SELECT RAISE(ABORT, '历史版本不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_hv_no_upd BEFORE UPDATE ON history_versions
BEGIN SELECT RAISE(ABORT, '历史版本不可修改'); END;
`);

function user(username, password, realName, role, clinicId = null) {
  const salt = makeSalt();
  const info = db.prepare(`INSERT INTO users(username,password_hash,salt,real_name,role,clinic_id,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(username, hashPassword(password, salt), salt, realName, role, clinicId, now());
  return Number(info.lastInsertRowid);
}

const uOp = user('op', '123456', '王丽', 'operator');
const uRev = user('rev', '123456', '陈强', 'reviewer');
const uSup = user('sup', '123456', '李督导', 'supervisor');

const c1 = db.prepare(`INSERT INTO clinics(code,name,contact_person,contact_phone,address,created_at)
  VALUES(?,?,?,?,?,?)`).run('C001', '康平口腔诊所', '张护士', '13800000001', '人民路 12 号', now()).lastInsertRowid;
const c2 = db.prepare(`INSERT INTO clinics(code,name,contact_person,contact_phone,address,created_at)
  VALUES(?,?,?,?,?,?)`).run('C002', '和美医美诊所', '刘护士长', '13800000002', '解放大道 88 号', now()).lastInsertRowid;
const c3 = db.prepare(`INSERT INTO clinics(code,name,contact_person,contact_phone,address,created_at)
  VALUES(?,?,?,?,?,?)`).run('C003', '健齿正畸门诊', '赵医生', '13800000003', '建设街 5 号', now()).lastInsertRowid;

user('kp', '123456', '张护士', 'clinic', Number(c1));
user('hm', '123456', '刘护士长', 'clinic', Number(c2));
user('jc', '123456', '赵医生', 'clinic', Number(c3));

function clinicUser(clinicId, n) {
  return db.prepare('SELECT id FROM users WHERE role=\'clinic\' AND clinic_id=? ORDER BY id LIMIT 1 OFFSET ?').get(clinicId, n).id;
}

function inst(udi, name, spec, status) {
  const info = db.prepare(`INSERT INTO instruments(udi,name,spec,category,current_status,label_printed,created_at)
    VALUES(?,?,?, ?, ?, 1, ?)`).run(udi, name, spec, '手术器械', status, now());
  return Number(info.lastInsertRowid);
}

// 12 件属于阳性批次的器械
const NAMES = ['止血钳', '持针器', '组织剪', '线剪', '布巾钳', '刀柄', '镊子', '牙挺', '拔牙钳', '骨锉', '分离器', '刮匙'];
const lockedInsts = NAMES.map((n, i) => inst(`UDI20260922${String(1001 + i)}`, n, '14cm/标准', 'registered'));
// 另一批正常在库器械
const normalInsts = ['弯盘', '治疗碗', '换药碗', '探针'].map((n, i) =>
  inst(`UDI20260922${String(2001 + i)}`, n, '304不锈钢', 'in_stock'));

function order(clinicId, no, cnt, date) {
  return Number(db.prepare(`INSERT INTO rental_orders(order_no,clinic_id,rental_date,expected_item_count,status,created_at,created_by)
    VALUES(?,?,?,?,'open',?,?)`).run(no, clinicId, date, cnt, date, uOp).lastInsertRowid);
}
const ord1 = order(Number(c1), 'ZL20260920001', 8, '2026-09-20 09:00:00');
const ord2 = order(Number(c2), 'ZL20260920002', 7, '2026-09-20 10:00:00');

const { genNo: _g } = require('./util');

const t = (h) => `2026-09-21 ${h}`;

// 通用：回收→清洗→包装→灭菌(已放行) 流水线
function buildChain(instrumentIds, opts) {
  const rbNo = genNo('HS');
  const rb = Number(db.prepare(`INSERT INTO recovery_batches(batch_no,clinic_id,rental_order_id,recovered_at,receiver_id,location,status,created_at)
    VALUES(?,?,?,?,?,?,'done',?)`).run(rbNo, Number(c3), null, t('08:10:00'), uOp, '去污区', now()).lastInsertRowid);
  for (const id of instrumentIds) {
    db.prepare(`INSERT INTO recovery_items(batch_id,instrument_id,item_name,quantity,appearance_status,function_status,created_at)
      VALUES(?,?, (SELECT name FROM instruments WHERE id=?), 1,'intact','normal',?)`).run(rb, id, id, now());
  }
  const wNo = genNo('QX');
  const wb = Number(db.prepare(`INSERT INTO wash_batches(batch_no,recovery_batch_id,equipment_no,program,temperature_c,duration_min,chemical,operator_id,started_at,ended_at,status,created_at)
    VALUES(?,?, 'QX-A 全自动清洗消毒机','器械清洗程序',93,10,'多酶清洗剂',?,?,?,'done',?)`)
    .run(wNo, rb, uOp, t('08:30:00'), t('09:05:00'), now()).lastInsertRowid);
  for (const id of instrumentIds) db.prepare('INSERT INTO wash_items(wash_batch_id,instrument_id) VALUES(?,?)').run(wb, id);

  const pNo = genNo('BZ');
  const pkg = Number(db.prepare(`INSERT INTO packages(package_no,wash_batch_id,package_name,package_type,sterilization_method,packer_id,packed_at,created_at)
    VALUES(?,?,?, 'set','压力蒸汽灭菌',?,?,?)`).run(pNo, wb, opts.pkgName, uOp, t('09:30:00'), now()).lastInsertRowid);
  for (const id of instrumentIds) db.prepare('INSERT INTO package_items(package_id,instrument_id,labeled_at) VALUES(?,?,?)').run(pkg, id, t('09:30:00'));

  const sNo = opts.batchNo || genNo('MJ');
  const sb = Number(db.prepare(`INSERT INTO sterilization_batches(batch_no,package_id,sterilizer_no,load_diagram,program,param_temp,param_pressure,param_hold_min,param_dry_min,operator_id,started_at,ended_at,chemical_result,biological_result,bio_result_at,status,created_at)
    VALUES(?,?, 'SJ-01 脉动真空灭菌器','装载图: 上层纸塑袋，下层手术器械包','134℃脉动真空',134,0.21,4,8,?,?,?, ?,?, ?, 'released',?)`)
    .run(sNo, pkg, uOp, t('10:00:00'), t('10:45:00'), 'pass', 'negative', t('14:20:00'), now()).lastInsertRowid);
  for (const id of instrumentIds) db.prepare('INSERT INTO sterilization_items(stbatch_id,package_id,instrument_id) VALUES(?,?,?)').run(sb, pkg, id);
  db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,tested_by,tested_at,created_at) VALUES(?, 'chemical','pass',?,?,?)`).run(sb, uOp, t('10:45:00'), now());
  db.prepare(`INSERT INTO monitorings(stbatch_id,monitor_type,result,sample_no,tested_by,tested_at,created_at) VALUES(?, 'biological','negative','BIO-SAMPLE',?,?,?)`).run(sb, uOp, t('14:20:00'), now());
  db.prepare(`INSERT INTO releases(stbatch_id,decision,reviewer_id,reviewed_at,comment,created_at)
    VALUES(?, 'released', ?, ?, '化学/生物监测合格，同意放行', ?)`).run(sb, uRev, t('14:30:00'), now());
  return { rb, wb, pkg, sb, batchNo: sNo };
}

// 正常批次（4 件，已放行，在库）
const normalChain = buildChain(normalInsts, { pkgName: '基础换器械包' });
for (const id of normalInsts) db.prepare("UPDATE instruments SET current_status='in_stock' WHERE id=?").run(id);
audit({ id: uRev, username: 'rev', role: 'reviewer' }, 'RELEASE', 'sterilization_batch', normalChain.sb, { seeded: true });

// ===== 典型场景：生物监测阳性批次（12 件） =====
// 回收/清洗/包装/灭菌链（先以 released 建链，再改 locked，模拟“生物结果补录阳性”）
const posChain = buildChain(lockedInsts, { pkgName: '口腔综合器械包', batchNo: 'MJ2026092110' });
const posSb = posChain.sb;

// 发放：3 件 → 康平，2 件 → 和美（早期放行历史单，含交接人与时间）
function distribute(clinicId, ids, distNo, handover, at) {
  const d = Number(db.prepare(`INSERT INTO distributions(dist_no,stbatch_id,clinic_id,handover_person,operator_id,distributed_at,early_release,status,clinic_confirmed_by,clinic_confirmed_at,note,created_at)
    VALUES(?,?,?,?,?,? ,1,'received',?,?, '早期放行（生物监测结果待出时发放，阳性后已被冻结）',?)`)
    .run(distNo, posSb, clinicId, handover, uOp, at, clinicUser(clinicId, 0), at, now()).lastInsertRowid);
  for (const id of ids) {
    db.prepare('INSERT INTO distribution_items(distribution_id,instrument_id) VALUES(?,?)').run(d, id);
    db.prepare("UPDATE instruments SET current_status='at_clinic', current_clinic_id=? WHERE id=?").run(clinicId, id);
  }
  return d;
}
const toC1 = lockedInsts.slice(0, 3); // 止血钳/持针器/组织剪
const toC2 = lockedInsts.slice(3, 5); // 线剪/布巾钳
const inStock = lockedInsts.slice(5); // 7 件
const d1 = distribute(Number(c1), toC1, 'FF2026092115', '张护士', '2026-09-21 15:20:00');
const d2 = distribute(Number(c2), toC2, 'FF2026092116', '刘护士长', '2026-09-21 15:40:00');
// 7 件在库
for (const id of inStock) db.prepare("UPDATE instruments SET current_status='in_stock', current_clinic_id=NULL WHERE id=?").run(id);

// 使用时间记录（诊所端）
db.prepare(`INSERT INTO usages(instrument_id,clinic_id,distribution_id,used_at,patient_ref,recorded_by,created_at)
  VALUES(?,?,?,?,'P-2098',?,?)`).run(toC1[0], Number(c1), d1, '2026-09-21 16:30:00', clinicUser(Number(c1), 0), now());
db.prepare(`INSERT INTO usages(instrument_id,clinic_id,distribution_id,used_at,patient_ref,recorded_by,created_at)
  VALUES(?,?,?,?,'P-2103',?,?)`).run(toC1[2], Number(c1), d1, '2026-09-21 17:05:00', clinicUser(Number(c1), 0), now());
db.prepare(`INSERT INTO usages(instrument_id,clinic_id,distribution_id,used_at,patient_ref,recorded_by,created_at)
  VALUES(?,?,?,?,'HM-778',?,?)`).run(toC2[0], Number(c2), d2, '2026-09-21 16:50:00', clinicUser(Number(c2), 0), now());

// ===== 生物监测结果录入阳性 → 系统锁定（直接落库等价于 lockBatchPositive 的结果态） =====
db.prepare(`UPDATE sterilization_batches
  SET biological_result='positive', bio_result_at=?, status='locked', frozen_at=?, freeze_reason='生物监测阳性', early_release=1
  WHERE id=?`).run('2026-09-22 08:05:00', '2026-09-22 08:05:00', posSb);
db.prepare("UPDATE monitorings SET result='positive', tested_by=?, tested_at=? WHERE stbatch_id=? AND monitor_type='biological'")
  .run(uOp, '2026-09-22 08:05:00', posSb);
db.prepare("UPDATE distributions SET status='frozen' WHERE stbatch_id=? AND id IN (?,?)").run(posSb, d1, d2);

const ncId = Number(db.prepare(`INSERT INTO nonconformances(nc_no,stbatch_id,reason_type,description,status,created_by,created_at)
  VALUES(?,?, '生物监测阳性','批次 MJ2026092110 生物监测阳性，12 件器械全部冻结，其中 5 件已发往康平/和美两家诊所，7 件在库。', 'analysis', ?, ?)`)
  .run(genNo('NC'), posSb, uSup, now()).lastInsertRowid);
const recallId = Number(db.prepare(`INSERT INTO recalls(recall_no,stbatch_id,reason,triggered_by,status,created_at)
  VALUES(?,?, '生物监测阳性（嗜热脂肪杆菌芽孢培养阳性）',?, 'active', ?)`)
  .run(genNo('RC'), posSb, uSup, now()).lastInsertRowid);
db.prepare('UPDATE nonconformances SET recall_id=? WHERE id=?').run(recallId, ncId);
db.prepare('UPDATE sterilization_batches SET nc_id=? WHERE id=?').run(ncId, posSb);

for (const id of lockedInsts) {
  const distRow = id < toC1[0] || inStock.includes(id)
    ? null
    : db.prepare(`SELECT d.clinic_id, d.status FROM distribution_items di
        JOIN distributions d ON d.id=di.distribution_id
        WHERE di.instrument_id=? AND d.stbatch_id=?`).get(id, posSb);
  const dispatched = toC1.includes(id) || toC2.includes(id);
  const clinicId = dispatched ? (toC1.includes(id) ? Number(c1) : Number(c2)) : null;
  const snapshot = dispatched ? (id === toC1[0] || id === toC1[2] || id === toC2[0] ? 'at_clinic' : 'in_transit_signed') : 'in_stock';
  db.prepare(`INSERT INTO recall_items(recall_id,instrument_id,clinic_id,location_snapshot,notified,notified_at,return_status)
    VALUES(?,?,?,?,?, '2026-09-22 08:05:00','pending')`).run(recallId, id, clinicId, snapshot, dispatched ? 1 : 0);
  db.prepare("UPDATE instruments SET current_status='frozen_recall' WHERE id=?").run(id);
  if (dispatched) {
    notify(clinicUser(clinicId, 0), clinicId, 'recall',
      '【紧急召回】灭菌批次 MJ2026092110 生物监测阳性',
      `器械已被冻结，立即停止使用并等待召回（涉及发放单 ${id && (toC1.includes(id) ? 'FF2026092115' : 'FF2026092116')}）。`,
      'recall', recallId);
  }
}

// 督导员已启动原因排查（专项检查，进行中）
db.prepare(`INSERT INTO inspections(insp_no,stbatch_id,title,content,initiated_by,initiated_at,status,created_at)
  VALUES(?,?, 'MJ2026092110 生物监测阳性专项检查','排查灭菌器 SJ-01 运行参数、装载方式、密封圈状态与生物监测操作规范性。',?,?,'rectifying',?)`)
  .run(genNo('JC'), posSb, uSup, '2026-09-22 08:20:00', now());

audit({ id: uOp, username: 'op', role: 'operator' }, 'BIO_POSITIVE_LOCK', 'sterilization_batch', posSb,
  { batch_no: 'MJ2026092110', total: 12, dispatched: 5, in_stock: 7, clinics: [Number(c1), Number(c2)], seeded: true });
addVersion({ id: uOp, username: 'op' }, 'sterilization_batch', posSb, 'biological_result', 'pending', 'positive', '生物监测结果为阳性');
addVersion({ id: uOp, username: 'op' }, 'sterilization_batch', posSb, 'status', 'released', 'locked', '生物阳性自动锁定');

// ===== 一个待检批次（化学合格、生物未出结果）：用于演示“待检不能发放” =====
const pendingInsts = ['窥阴器', '卵圆钳', '海绵钳'].map((n, i) => inst(`UDI20260922${String(3001 + i)}`, n, '标准', 'registered'));
const pendChain = buildChain(pendingInsts, { pkgName: '检查器械包' });
// 将待检批次改回待检状态
db.prepare(`UPDATE sterilization_batches SET chemical_result='pass', biological_result='pending', bio_result_at=NULL, status='pending_monitor' WHERE id=?`).run(pendChain.sb);
db.prepare(`UPDATE releases SET decision='rejected', comment='演示数据：生物监测结果待出，保持待检状态' WHERE stbatch_id=?`).run(pendChain.sb);
for (const id of pendingInsts) db.prepare("UPDATE instruments SET current_status='sterilized_pending' WHERE id=?").run(id);

// 差异记录演示：康平回收时一件损坏
const rbDemo = Number(db.prepare(`INSERT INTO recovery_batches(batch_no,clinic_id,rental_order_id,recovered_at,receiver_id,location,status,note,created_at)
  VALUES(?,?,?,? ,?,'去污区','done','含损坏差异演示',?)`).run(genNo('HS'), Number(c1), ord1, '2026-09-20 18:00:00', uOp, now()).lastInsertRowid);
const damInst = inst(`UDI20260920${String(9001)}`, '组织剪', '16cm', 'registered');
db.prepare(`INSERT INTO recovery_items(batch_id,instrument_id,item_name,quantity,appearance_status,function_status,damaged_desc,created_at)
  VALUES(?,?, '组织剪',1,'damaged','abnormal','关节处有裂纹，闭合不到位',?)`).run(rbDemo, damInst, now());
db.prepare(`INSERT INTO discrepancies(recovery_batch_id,clinic_id,rental_order_id,instrument_id,item_name,discrepancy_type,expected_qty,actual_qty,description,status,created_at)
  VALUES(?,?,?,?, '组织剪','damaged',1,1,'关节处有裂纹，闭合不到位','pushed',?)`).run(rbDemo, Number(c1), ord1, damInst, now());
notify(clinicUser(Number(c1), 0), Number(c1), 'discrepancy', '【差异确认】回收批次存在损坏器械', '组织剪：关节处有裂纹，闭合不到位，请确认。', 'discrepancy', null);

console.log('演示数据写入完成');
console.log('账号: op / rev / sup / kp / hm / jc  密码均为 123456');
console.log('阳性批次: MJ2026092110  召回涉及 12 件（5 外发 / 7 在库）');
