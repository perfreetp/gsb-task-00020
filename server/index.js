'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ok, fail, readBody, auth, login, logout } = require('./util');
const core = require('./routes-core');
const quality = require('./routes-quality');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const routes = [];
const server = {
  get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
  post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); }
};
core.register(server);
quality.register(server);

// 兼容 /:id 参数
function matchRoute(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    else if (pp[i] !== ap[i]) return null;
  }
  return params;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, data) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;
  const ip = req.socket.remoteAddress;

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return readBody(req).then((b) => {
      const session = login(b.username, b.password, ip);
      if (!session) return fail(res, 401, '用户名或密码错误');
      ok(res, { token: session.token, user: session.user });
    }).catch((e) => fail(res, 400, e.message));
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const h = req.headers['authorization'] || '';
    if (h.startsWith('Bearer ')) logout(h.slice(7));
    return ok(res, { ok: true });
  }

  if (pathname.startsWith('/api/')) {
    const session = auth(req, res);
    if (!session) return;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = matchRoute(r.pattern, pathname);
      if (!params) continue;
      req.query = u.searchParams;
      try {
        return r.handler(req, res, session, params);
      } catch (e) {
        console.error(e);
        return fail(res, 500, '服务器内部错误: ' + e.message);
      }
    }
    return fail(res, 404, '接口不存在: ' + pathname);
  }
  serveStatic(req, res, pathname);
});

httpServer.listen(PORT, () => {
  console.log(`CSSD 器械消毒追溯系统已启动: http://localhost:${PORT}`);
});
