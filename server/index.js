const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { send, fail } = require('./util');

const routers = [
  require('./routes/auth.routes'),
  require('./routes/meta.routes'),
  require('./routes/recovery.routes'),
  require('./routes/wash.routes'),
  require('./routes/package.routes'),
  require('./routes/sterile.routes'),
  require('./routes/release.routes'),
  require('./routes/quality.routes'),
  require('./routes/trace.routes'),
  require('./routes/report.routes'),
];

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(WEB_DIR, p));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  const target = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? path.join(filePath, 'index.html') : filePath;
  if (!fs.existsSync(target)) {
    const index = path.join(WEB_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return fs.createReadStream(index).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  try {
    if (urlPath.startsWith('/api/')) {
      for (const router of routers) {
        const handled = await router(req, res, urlPath);
        if (handled !== false) return;
      }
      return fail(res, 404, `接口不存在: ${urlPath}`);
    }
    return serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('[server error]', err);
    if (!res.headersSent) return fail(res, 500, err.message || '服务器内部错误');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`器械消毒追溯系统已启动: http://localhost:${PORT}`);
});
