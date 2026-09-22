const db = require('./db');
const { now, genToken, hashPassword, fail } = require('./util');

const ROLE_NAMES = {
  operator: '操作员',
  reviewer: '审核人',
  supervisor: '感控督导员',
  clinic: '诊所端',
};

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) return null;
  if (hashPassword(password, user.salt) !== user.password_hash) return null;
  const token = genToken();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(token, user.id, now(), new Date(Date.now() + 12 * 3600 * 1000).toISOString());
  return { token, user: publicUser(user) };
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, real_name: u.real_name,
    role: u.role, role_name: ROLE_NAMES[u.role], clinic_id: u.clinic_id,
  };
}

function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > ?`).get(token, now());
  return row ? publicUser(row) : null;
}

function requireAuth(req, res) {
  const user = getUser(req);
  if (!user) { fail(res, 401, '未登录或会话已过期'); return null; }
  return user;
}

function requireRole(req, res, roles) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (roles && !roles.includes(user.role)) {
    fail(res, 403, `权限不足：需要 ${roles.map((r) => ROLE_NAMES[r] || r).join('/')} 角色`);
    return null;
  }
  return user;
}

function audit(user, action, entityType, entityId, detail) {
  db.prepare(`INSERT INTO audit_logs(user_id,username,role,action,entity_type,entity_id,detail,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    user ? user.id : null, user ? user.username : 'system', user ? user.role : 'system',
    action, entityType || null, entityId == null ? null : String(entityId),
    detail ? JSON.stringify(detail) : null, now());
}

function addVersion(user, entityType, entityId, fieldLabel, oldVal, newVal, reason) {
  db.prepare(`INSERT INTO history_versions(entity_type,entity_id,field_label,old_value,new_value,changed_by,changed_at,reason)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    entityType, entityId, fieldLabel,
    oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal),
    user ? user.id : null, now(), reason || '');
}

function notify(userId, clinicId, type, title, body, refType, refId) {
  db.prepare(`INSERT INTO notifications(user_id,clinic_id,type,title,body,ref_type,ref_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(userId || null, clinicId || null, type, title, body || null,
    refType || null, refId || null, now());
}

module.exports = { ROLE_NAMES, login, publicUser, getUser, requireAuth, requireRole, audit, addVersion, notify };
