const db = require('../db');
const { requireRole, audit } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const { INST_STATUS_CN } = require('../services/trace');

module.exports = async function metaRoutes(req, res, path) {
  // 字典
  if (path === '/api/meta' && req.method === 'GET') {
    const user = require('../auth').requireAuth(req, res);
    if (!user) return;
    return ok(res, {
      status_cn: INST_STATUS_CN,
      roles: ROLE_ARR,
      sterilizers: ['SJ-01 脉动真空灭菌器', 'SJ-02 快速灭菌器', 'SJ-03 低温等离子灭菌器'],
      washers: ['QX-A 全自动清洗消毒机', 'QX-B 超声清洗机'],
    });
  }

  // 诊所列表
  if (path === '/api/clinics' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = user.role === 'clinic'
      ? db.prepare('SELECT * FROM clinics WHERE id=? ORDER BY id').all(user.clinic_id)
      : db.prepare('SELECT * FROM clinics ORDER BY id').all();
    return ok(res, rows);
  }

  // 新建诊所（督导员）
  if (path === '/api/clinics' && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.name) return fail(res, 400, '诊所名称必填');
    const code = b.code || genNo('C');
    const info = db.prepare(`INSERT INTO clinics(code,name,contact_person,contact_phone,address,created_at)
      VALUES(?,?,?,?,?,?)`).run(code, b.name, b.contact_person || '', b.contact_phone || '', b.address || '', now());
    audit(user, 'CREATE', 'clinic', info.lastInsertRowid, b);
    return ok(res, { id: Number(info.lastInsertRowid) });
  }

  // 租赁单
  if (path === '/api/rental-orders' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = db.prepare(`
      SELECT ro.*, c.name AS clinic_name,
        (SELECT COUNT(*) FROM recovery_batches rb WHERE rb.rental_order_id=ro.id) AS recovered_count
      FROM rental_orders ro JOIN clinics c ON c.id=ro.clinic_id
      ${user.role === 'clinic' ? 'WHERE ro.clinic_id=' + Number(user.clinic_id) : ''}
      ORDER BY ro.id DESC`).all();
    return ok(res, rows);
  }
  if (path === '/api/rental-orders' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator', 'supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.clinic_id || !b.rental_date) return fail(res, 400, '诊所与租赁日期必填');
    const info = db.prepare(`INSERT INTO rental_orders(order_no,clinic_id,rental_date,expected_item_count,note,created_at,created_by)
      VALUES(?,?,?,?,?,?,?)`).run(genNo('ZL'), b.clinic_id, b.rental_date, b.expected_item_count || 0, b.note || '', now(), user.id);
    audit(user, 'CREATE', 'rental_order', info.lastInsertRowid, b);
    return ok(res, { id: Number(info.lastInsertRowid) });
  }

  // 器械主档
  if (path.startsWith('/api/instruments') && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const kw = q.get('q') || '';
    const rows = db.prepare(`
      SELECT i.*, c.name AS clinic_name FROM instruments i
      LEFT JOIN clinics c ON c.id=i.current_clinic_id
      WHERE (?='' OR i.udi LIKE ? OR i.name LIKE ?)
      ORDER BY i.id DESC LIMIT 100`)
      .all(kw, `%${kw}%`, `%${kw}%`);
    return ok(res, rows.map((r) => ({ ...r, status_cn: INST_STATUS_CN[r.current_status] || r.current_status })));
  }

  // 用户列表（督导员）
  if (path === '/api/users' && req.method === 'GET') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT u.id,u.username,u.real_name,u.role,u.clinic_id,u.active,c.name AS clinic_name,u.created_at
      FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id ORDER BY u.id`).all();
    return ok(res, rows);
  }
  if (path === '/api/users' && req.method === 'POST') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.username || !b.password || !b.real_name || !b.role) return fail(res, 400, '账号信息不完整');
    const salt = require('../util').makeSalt();
    const hash = require('../util').hashPassword(b.password, salt);
    try {
      const info = db.prepare(`INSERT INTO users(username,password_hash,salt,real_name,role,clinic_id,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(b.username, hash, salt, b.real_name, b.role, b.clinic_id || null, now());
      audit(user, 'CREATE', 'user', info.lastInsertRowid, { username: b.username, role: b.role });
      return ok(res, { id: Number(info.lastInsertRowid) });
    } catch (e) {
      return fail(res, 400, '用户名已存在');
    }
  }

  // 通知
  if (path === '/api/notifications' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor', 'clinic']);
    if (!user) return;
    const rows = user.role === 'clinic'
      ? db.prepare('SELECT * FROM notifications WHERE clinic_id=? ORDER BY id DESC LIMIT 100').all(user.clinic_id)
      : db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all();
    return ok(res, rows);
  }
  if (path.startsWith('/api/notifications/') && req.method === 'POST') {
    const user = requireAuth2(req, res);
    if (!user) return;
    const id = Number(path.split('/').pop());
    db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(id);
    return ok(res, {});
  }

  return false;
};

const ROLE_ARR = [
  { value: 'operator', label: '操作员' },
  { value: 'reviewer', label: '审核人' },
  { value: 'supervisor', label: '感控督导员' },
  { value: 'clinic', label: '诊所端' },
];
function requireAuth2(req, res) { return require('../auth').requireAuth(req, res); }
