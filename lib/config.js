'use strict';

class RenewalError extends Error {}

function loadUsers(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || '[]'); }
  catch { throw new RenewalError('账号配置：USERS_JSON 不是有效的 JSON'); }
  const users = Array.isArray(parsed) ? parsed : parsed?.users;
  if (!Array.isArray(users) || users.length === 0) {
    throw new RenewalError('账号配置：USERS_JSON 中没有账号');
  }
  return users.map((user, index) => ({
    index: index + 1,
    valid: typeof user?.username === 'string' && !!user.username.trim()
      && typeof user?.password === 'string' && !!user.password,
    username: typeof user?.username === 'string' ? user.username.trim() : '',
    password: typeof user?.password === 'string' ? user.password : '',
  }));
}

function proxyConfig(raw) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname
      || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error();
    if (url.protocol === 'socks5:' && (url.username || url.password)) {
      throw new RenewalError('代理配置：浏览器不支持带认证的 SOCKS5，请使用 HTTP 代理');
    }
    return {
      server: `${url.protocol}//${url.host}`,
      ...(url.username && { username: decodeURIComponent(url.username) }),
      ...(url.password && { password: decodeURIComponent(url.password) }),
    };
  } catch (error) {
    if (error instanceof RenewalError) throw error;
    throw new RenewalError('代理配置：HTTP_PROXY 格式不正确');
  }
}

module.exports = { RenewalError, loadUsers, proxyConfig };
