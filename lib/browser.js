'use strict';

const { RenewalError } = require('./config');
const { ChallengeError, challengeObserver, solveChallenge } = require('./challenge');
const ORIGIN = 'https://dashboard.katabump.com';

async function visible(locator, timeout = 15000) {
  await locator.first().waitFor({ state: 'visible', timeout });
  return locator.first();
}

async function login(page, user, { challengeTimeout = 45000, retryDelay = 1500 } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(`${ORIGIN}/auth/login`, { waitUntil: 'domcontentloaded' });
    let email;
    try { email = await visible(page.locator('input[type="email"],input[name="email"]')); }
    catch { throw new RenewalError('登录：页面被拦截或找不到邮箱输入框'); }
    await email.fill(user.username);
    await (await visible(page.locator('input[type="password"]'))).fill(user.password);
    try { await solveChallenge(page, page, challengeTimeout); break; }
    catch (error) {
      if (!(error instanceof ChallengeError)) throw error;
      if (attempt === 2) throw new RenewalError('登录：Turnstile 验证连续 3 次超时，请检查站点或代理网络');
      await page.waitForTimeout(retryDelay);
    }
  }
  await (await visible(page.getByRole('button', { name: /^Login$/i }))).click();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await page.getByText('Incorrect password or no account', { exact: false }).first().isVisible().catch(() => false)) {
      throw new RenewalError('登录：账号不存在或密码错误');
    }
    const url = new URL(page.url());
    if (url.origin === ORIGIN && !url.pathname.startsWith('/auth/')
      && await page.getByRole('link', { name: /^See$/i }).first().isVisible().catch(() => false)) return;
    await page.waitForTimeout(500);
  }
  throw new RenewalError('登录：提交后未进入服务器列表，请检查凭据或验证状态');
}

function serverLinks(hrefs) {
  return [...new Set(hrefs.flatMap(href => {
    try {
      const url = new URL(href, ORIGIN);
      return url.origin === ORIGIN && !url.pathname.startsWith('/auth/') ? [url.href] : [];
    } catch { return []; }
  }))];
}

async function getServers(page) {
  const hrefs = await page.getByRole('link', { name: /^See$/i }).evaluateAll(links => links.map(link => link.href));
  const links = serverLinks(hrefs);
  if (!links.length) throw new RenewalError('服务器列表：没有找到可用的 See 链接');
  return links;
}

function renewalStatus(text, payload) {
  if (/you can['’]t renew your server yet/i.test(text)) {
    const match = text.match(/as of\s+([^\n\r(]+)/i);
    const date = match ? expiryTimestamp(match[1].trim()) : null;
    return { status: 'skipped', reason: '尚未到允许续期时间'
      + (date !== null ? `；可续期时间：${new Date(date).toISOString()}` : '；具体时间见截图') };
  }
  if (/please complete the captcha/i.test(text)) return { status: 'captcha' };
  if (/(?:not|never|failed to|unable to)\s+(?:(?:be|been)\s+)?(?:successfully\s+)?renew|renewal (?:failed|unsuccessful)/i.test(text)) {
    return { status: 'failure', reason: '站点返回续期失败，请稍后重试' };
  }
  if (payload?.success === true || payload?.status === 'success'
    || /(?:\bserver\s+(?:(?:has been|was)\s+)?(?:successfully\s+)?renewed\b|renewal successful|successfully renewed)/i.test(text)) {
    return { status: 'success', reason: '站点已明确确认续期成功' };
  }
  return null;
}

function expiryTimestamp(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  let timestamp;
  const day = raw.match(/^(20\d{2})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (day) {
    timestamp = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    const date = new Date(timestamp);
    if (date.getUTCMonth() !== Number(day[2]) - 1 || date.getUTCDate() !== Number(day[3])) return null;
  } else if (/^\d{10}(?:\d{3})?$/.test(raw)) timestamp = Number(raw) * (raw.length === 10 ? 1000 : 1);
  else timestamp = /\b20\d{2}\b/.test(raw) ? Date.parse(raw) : NaN;
  return Number.isFinite(timestamp) && timestamp > Date.UTC(2000, 0, 1) && timestamp < Date.UTC(2100, 0, 1)
    ? timestamp : null;
}

async function readExpiry(page) {
  const candidates = await page.evaluate(() => {
    const results = [];
    const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    for (const el of document.querySelectorAll('[data-expires-at],[data-expiration],[id*="expir" i],time[datetime]')) {
      if (!visible(el)) continue;
      if (el.matches('time') && !/expir/i.test(el.parentElement?.textContent || '')) continue;
      results.push(el.getAttribute('data-expires-at') || el.getAttribute('data-expiration')
        || el.getAttribute('datetime') || el.textContent.trim());
    }
    for (const el of document.querySelectorAll('dt,th,td,label,span,p,div')) {
      if (!visible(el)) continue;
      const text = el.textContent.trim();
      if (text.length > 120) continue;
      const inline = text.match(/^(?:expiry|expiration|expires(?: at| on)?|expiration date|expiry date|到期时间|到期日期)\s*:?\s*(20\d{2}[/-]\d{1,2}[/-]\d{1,2}(?:[T ].*)?)$/i);
      if (inline) results.push(inline[1]);
      if (/^(?:expiry|expiration|expires(?: at| on)?|expiration date|expiry date|到期时间|到期日期)\s*:?\s*$/i.test(text)
        && el.nextElementSibling) results.push(el.nextElementSibling.textContent.trim());
    }
    return results;
  }).catch(() => []);
  const values = [...new Set(candidates.map(expiryTimestamp).filter(value => value !== null))];
  return values.length === 1 ? values[0] : null;
}

async function renewServer(page, url, {
  challengeTimeout = 45000, confirmationTimeout = 20000, retryDelay = 1500,
} = {}) {
  let previousExpiry = null;
  let accepted = null;
  const capture = async response => {
    try {
      const target = new URL(response.url());
      if (target.origin !== ORIGIN || !/renew/i.test(target.pathname)
        || response.request().method() !== 'POST' || !response.ok()) return;
      const data = await response.json();
      if (data && typeof data === 'object') accepted = data;
    } catch { /* HTML redirects are checked through visible page content. */ }
  };
  page.on('response', capture);
  try {
    // Reload only before submitting, or after an explicit captcha rejection.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await page.waitForTimeout(retryDelay);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (attempt === 0) previousExpiry = await readExpiry(page);
      accepted = null;
      let button, modal;
      try { button = await visible(page.getByRole('button', { name: /^Renew$/i })); }
      catch { throw new RenewalError('续期：页面没有可用的 Renew 按钮'); }
      await button.click();
      try { modal = await visible(page.locator('#renew-modal')); }
      catch { throw new RenewalError('续期：点击后未出现确认窗口'); }
      try { await solveChallenge(page, modal, challengeTimeout); }
      catch (error) {
        if (!(error instanceof ChallengeError)) throw error;
        if (attempt === 2) throw new RenewalError('续期：Turnstile 验证连续 3 次超时，请检查站点或代理网络');
        continue;
      }
      await (await visible(modal.getByRole('button', { name: /^Renew$/i }))).click();
      const deadline = Date.now() + confirmationTimeout;
      let rejected = false;
      while (Date.now() < deadline) {
        const text = await page.locator('body').innerText();
        const warning = new URL(page.url()).searchParams.get('renew-error') || '';
        const confirmation = new URL(page.url()).searchParams.get('success') || '';
        const result = renewalStatus(`${text}\n${warning.slice(0, 1000)}\n${confirmation.slice(0, 1000)}`, accepted);
        if (result?.status === 'captcha') { rejected = true; break; }
        if (result) return result;
        const currentExpiry = await readExpiry(page);
        if (previousExpiry !== null && currentExpiry !== null && currentExpiry > previousExpiry) {
          return { status: 'success', reason: '已确认服务器到期时间延后' };
        }
        await page.waitForTimeout(500);
      }
      if (!rejected) {
        const error = new RenewalError('续期：请求已提交，但没有收到明确成功结果，未重复提交');
        error.uncertain = true;
        throw error;
      }
    }
    throw new RenewalError('续期：站点持续拒绝验证码，请稍后重试');
  } finally {
    page.off('response', capture);
  }
}

module.exports = { challengeObserver, login, getServers, renewServer, renewalStatus, serverLinks, expiryTimestamp, readExpiry };
