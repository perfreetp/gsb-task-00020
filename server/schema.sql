-- 器械消毒追溯系统 数据库结构
PRAGMA foreign_keys = ON;

-- 会话
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 用户（操作员/审核人/感控督导员/诊所端）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  real_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('operator','reviewer','supervisor','clinic')),
  clinic_id INTEGER REFERENCES clinics(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 合作诊所
CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  contact_phone TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 租赁单
CREATE TABLE IF NOT EXISTS rental_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  rental_date TEXT NOT NULL,
  expected_item_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  note TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

-- 器械主档（单件唯一标识 UDI）
CREATE TABLE IF NOT EXISTS instruments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  udi TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  spec TEXT,
  category TEXT,
  current_status TEXT NOT NULL DEFAULT 'registered',
  current_clinic_id INTEGER REFERENCES clinics(id),
  current_stbatch_id INTEGER,
  label_printed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 回收批次（回收登记单）
CREATE TABLE IF NOT EXISTS recovery_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  rental_order_id INTEGER REFERENCES rental_orders(id),
  recovered_at TEXT NOT NULL,
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  location TEXT,
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','washing','done')),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES recovery_batches(id),
  instrument_id INTEGER REFERENCES instruments(id),
  udi_scanned TEXT,
  item_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  appearance_status TEXT NOT NULL CHECK(appearance_status IN ('intact','worn','damaged','missing')),
  function_status TEXT NOT NULL CHECK(function_status IN ('normal','abnormal','untested')),
  damaged_desc TEXT,
  created_at TEXT NOT NULL
);

-- 差异记录
CREATE TABLE IF NOT EXISTS discrepancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recovery_batch_id INTEGER NOT NULL REFERENCES recovery_batches(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  rental_order_id INTEGER REFERENCES rental_orders(id),
  instrument_id INTEGER REFERENCES instruments(id),
  item_name TEXT,
  discrepancy_type TEXT NOT NULL CHECK(discrepancy_type IN ('missing','damaged','surplus')),
  expected_qty INTEGER NOT NULL DEFAULT 0,
  actual_qty INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pushed' CHECK(status IN ('pushed','confirmed','disputed','closed')),
  clinic_feedback TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);

-- 清洗消毒批次
CREATE TABLE IF NOT EXISTS wash_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  recovery_batch_id INTEGER REFERENCES recovery_batches(id),
  source_stbatch_id INTEGER,
  equipment_no TEXT NOT NULL,
  program TEXT NOT NULL,
  temperature_c REAL NOT NULL,
  duration_min INTEGER NOT NULL,
  chemical TEXT,
  operator_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('done','rewash')),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wash_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wash_batch_id INTEGER NOT NULL REFERENCES wash_batches(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  result TEXT NOT NULL DEFAULT 'clean' CHECK(result IN ('clean','rewash')),
  note TEXT
);

-- 包装记录
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_no TEXT UNIQUE NOT NULL,
  wash_batch_id INTEGER NOT NULL REFERENCES wash_batches(id),
  package_name TEXT NOT NULL,
  package_type TEXT NOT NULL DEFAULT 'set' CHECK(package_type IN ('single','set')),
  sterilization_method TEXT NOT NULL,
  packer_id INTEGER NOT NULL REFERENCES users(id),
  packed_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS package_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  labeled_at TEXT NOT NULL
);

-- 灭菌批次（核心）
CREATE TABLE IF NOT EXISTS sterilization_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  package_id INTEGER REFERENCES packages(id),
  sterilizer_no TEXT NOT NULL,
  load_diagram TEXT,
  program TEXT,
  param_temp REAL,
  param_pressure REAL,
  param_hold_min INTEGER,
  param_dry_min INTEGER,
  operator_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  chemical_result TEXT DEFAULT 'pending' CHECK(chemical_result IN ('pending','pass','fail')),
  biological_result TEXT DEFAULT 'pending' CHECK(biological_result IN ('pending','negative','positive')),
  bio_sample_no TEXT,
  bio_result_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending_monitor'
    CHECK(status IN ('pending_monitor','released','locked','failed','reprocessed')),
  early_release INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT,
  freeze_reason TEXT,
  nc_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sterilization_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  package_id INTEGER REFERENCES packages(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id)
);

-- 监测记录
CREATE TABLE IF NOT EXISTS monitorings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  monitor_type TEXT NOT NULL CHECK(monitor_type IN ('chemical','biological','bowie_dick')),
  result TEXT NOT NULL CHECK(result IN ('pending','pass','fail','negative','positive')),
  sample_no TEXT,
  tested_by INTEGER REFERENCES users(id),
  tested_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 放行记录
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  decision TEXT NOT NULL CHECK(decision IN ('released','rejected','early')),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

-- 发放
CREATE TABLE IF NOT EXISTS distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dist_no TEXT UNIQUE NOT NULL,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  handover_person TEXT NOT NULL,
  operator_id INTEGER NOT NULL REFERENCES users(id),
  distributed_at TEXT NOT NULL,
  early_release INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_transit' CHECK(status IN ('in_transit','received','frozen','returned')),
  clinic_confirmed_by INTEGER REFERENCES users(id),
  clinic_confirmed_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS distribution_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id INTEGER NOT NULL REFERENCES distributions(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id)
);

-- 诊所使用记录
CREATE TABLE IF NOT EXISTS usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  distribution_id INTEGER REFERENCES distributions(id),
  used_at TEXT NOT NULL,
  patient_ref TEXT,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- 召回
CREATE TABLE IF NOT EXISTS recalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_no TEXT UNIQUE NOT NULL,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  reason TEXT NOT NULL,
  triggered_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS recall_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id INTEGER NOT NULL REFERENCES recalls(id),
  instrument_id INTEGER NOT NULL REFERENCES instruments(id),
  clinic_id INTEGER REFERENCES clinics(id),
  location_snapshot TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  return_status TEXT NOT NULL DEFAULT 'pending' CHECK(return_status IN ('pending','returned','na')),
  returned_at TEXT
);

-- 不合格处置单
CREATE TABLE IF NOT EXISTS nonconformances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nc_no TEXT UNIQUE NOT NULL,
  stbatch_id INTEGER NOT NULL REFERENCES sterilization_batches(id),
  recall_id INTEGER REFERENCES recalls(id),
  reason_type TEXT NOT NULL,
  description TEXT,
  root_cause TEXT,
  correction TEXT,
  reprocess_stbatch_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','analysis','reprocessing','closed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

-- 专项检查
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insp_no TEXT UNIQUE NOT NULL,
  stbatch_id INTEGER REFERENCES sterilization_batches(id),
  title TEXT NOT NULL,
  content TEXT,
  initiated_by INTEGER REFERENCES users(id),
  initiated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rectifying','closed')),
  finding TEXT,
  rectification TEXT,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  created_at TEXT NOT NULL
);

-- 历史版本（只追加）
CREATE TABLE IF NOT EXISTS history_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field_label TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- 审计日志（只追加）
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- 报表导出留痕
CREATE TABLE IF NOT EXISTS export_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  report_type TEXT NOT NULL,
  params TEXT,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 通知（诊所端）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER REFERENCES clinics(id),
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inst_status ON instruments(current_status);
CREATE INDEX IF NOT EXISTS idx_ri_batch ON recovery_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_si_st ON sterilization_items(stbatch_id);
CREATE INDEX IF NOT EXISTS idx_si_inst ON sterilization_items(instrument_id);
CREATE INDEX IF NOT EXISTS idx_di_dist ON distribution_items(distribution_id);
CREATE INDEX IF NOT EXISTS idx_di_inst ON distribution_items(instrument_id);
CREATE INDEX IF NOT EXISTS idx_usage_inst ON usages(instrument_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_hv_entity ON history_versions(entity_type, entity_id);

-- 防删除/防修改触发器
CREATE TRIGGER IF NOT EXISTS trg_audit_no_del BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, '审计日志不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_upd BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, '审计日志不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_hv_no_del BEFORE DELETE ON history_versions
BEGIN SELECT RAISE(ABORT, '历史版本不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_hv_no_upd BEFORE UPDATE ON history_versions
BEGIN SELECT RAISE(ABORT, '历史版本不可修改'); END;
