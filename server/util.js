function now() {
  return new Date().toISOString();
}

function genNo(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}${stamp}${Math.floor(Math.random() * 900 + 100)}`;
}

function genToken() {
  return require('node:crypto').randomBytes(24).toString('hex');
}

function hashPassword(password, salt) {
  const crypto = require('node:crypto');
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeSalt() {
  return require('node:crypto').randomBytes(8).toString('hex');
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => {
      chunks += c;
      if (chunks.length > 5 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function ok(res, data) { send(res, 200, { ok: true, data }); }
function fail(res, code, message) { send(res, code === 403 ? 403 : code || 400, { ok: false, error: message || 'bad request' }); }

module.exports = { now, genNo, genToken, hashPassword, makeSalt, bodyJson, send, ok, fail };
