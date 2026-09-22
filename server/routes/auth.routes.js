const { login, requireAuth, audit, ROLE_NAMES } = require('../auth');
const { bodyJson, ok, fail } = require('../util');

module.exports = async function authRoutes(req, res, path) {
  if (path === '/api/login' && req.method === 'POST') {
    const b = await bodyJson(req);
    const result = login((b.username || '').trim(), b.password || '');
    if (!result) return fail(res, 401, '用户名或密码错误');
    audit(result.user, 'LOGIN', 'user', result.user.id, { username: result.user.username });
    return ok(res, result);
  }
  if (path === '/api/me' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    return ok(res, { ...user, role_name: ROLE_NAMES[user.role] });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (user) audit(user, 'LOGOUT', 'user', user.id, {});
    return ok(res, {});
  }
  return false;
};
