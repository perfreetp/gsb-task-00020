'use strict';
const crypto = require('node:crypto');
const { db, verifyPassword, now, logAudit } = require('./db');

const tokens = new Map();

function json(res, code, body) {
  const data = JSON.stringify(body ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function ok(res, body) { json(res, 200, body); }
function fail(res, code, message, extra) { json(res, code, Object.assign({ error: message }, extra || {})); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

const PUBLIC_PATHS = new Set(['/api/auth/login']);

function auth(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = token && tokens.get(token);
  if (!session) { fail(res, 401, '未登录或会话已过期'); return null; }
  session.last_seen = now();
  return session;
}

function requireRole(res, session, roles) {
  if (!roles.includes(session.user.role)) {
    fail(res, 403, `权限不足：需要 ${roles.join('/')} 角色，当前为「${roleName(session.user.role)}」`);
    return false;
  }
  return true;
}

const ROLE_NAMES = { operator: '操作员', reviewer: '审核人', supervisor: '感控督导员', clinic: '诊所用户' };
function roleName(r) { return ROLE_NAMES[r] || r; }

function login(username, password, ip) {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const session = { token, user: sanitizeUser(user), login_at: now(), ip };
  tokens.set(token, session);
  logAudit({ actor_id: user.id, actor_name: user.name, role: user.role, action: 'LOGIN', entity: 'user', entity_id: user.id, ip });
  return session;
}
function logout(token) {
  const s = tokens.get(token);
  if (s) {
    tokens.delete(token);
    logAudit({ actor_id: s.user.id, actor_name: s.user.name, role: s.user.role, action: 'LOGOUT', entity: 'user', entity_id: s.user.id });
  }
}
function sanitizeUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, clinic_id: u.clinic_id ?? null };
}

function genNo(prefix) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = String(crypto.randomInt(100, 999));
  return `${prefix}${ymd}-${rand}`;
}

function notify(clinicId, title, body, kind, refType, refId, userId) {
  db.prepare(`INSERT INTO notifications(clinic_id,user_id,title,body,kind,ref_type,ref_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(clinicId ?? null, userId ?? null, title, body, kind || 'info',
      refType ?? null, refId ?? null, now());
}

module.exports = { json, ok, fail, readBody, auth, requireRole, roleName, login, logout, tokens, genNo, notify };
