'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { loadUsers, proxyConfig, RenewalError } = require('../lib/config');
const { renewalStatus, serverLinks, expiryTimestamp, readExpiry } = require('../lib/browser');
const { Notifier, report } = require('../lib/notify');
const { main, processAccount } = require('../renew');

const env = async (values, fn) => {
  const old = { ...process.env };
  try {
    delete process.env.HTTP_PROXY;
    delete process.env.SETUP_FAILED;
    delete process.env.GITHUB_STEP_SUMMARY;
    Object.assign(process.env, values);
    return await fn();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
  }
};

const validUser = { index: 1, valid: true, username: 'private@example.com', password: 'secret' };

test('array and users envelope preserve passwords and account numbering', () => {
  for (const data of [[{ username: 'a', password: ' p ' }, {}], { users: [{ username: 'a', password: ' p ' }, {}] }]) {
    const users = loadUsers(JSON.stringify(data));
    assert.equal(users[0].password, ' p ');
    assert.equal(users[1].index, 2);
    assert.equal(users[1].valid, false);
  }
});

test('malformed account JSON never echoes its content', () => {
  assert.throws(() => loadUsers('PRIVATE_PASSWORD'), error => error instanceof RenewalError && !error.message.includes('PRIVATE_PASSWORD'));
});

test('proxy auth stays separate from server address', () => {
  const proxy = proxyConfig('http://user:p%40ss@localhost:8080');
  assert.equal(proxy.server, 'http://localhost:8080');
  assert.equal(proxy.password, 'p@ss');
  assert.throws(() => proxyConfig('socks5://user:password@localhost:1080'), RenewalError);
  assert.throws(() => proxyConfig('file:///secret'), RenewalError);
});

test('server discovery removes external/auth links and duplicates', () => {
  assert.deepEqual(serverLinks(['/server/1', '/server/1', 'https://other.test/server/1', '/auth/logout']),
    ['https://dashboard.katabump.com/server/1']);
});

test('closed modal or HTTP redirect alone is not renewal success', () => {
  assert.equal(renewalStatus('Dashboard'), null);
  assert.equal(renewalStatus('Renew'), null);
  assert.equal(renewalStatus('', { success: false }), null);
});

test('explicit success and skip results are distinguished', () => {
  assert.equal(renewalStatus('Server renewed successfully!').status, 'success');
  assert.equal(renewalStatus('', { success: true }).status, 'success');
  assert.equal(renewalStatus("You can't renew your server yet. as of 2026-10-01T00:00:00Z").status, 'skipped');
  assert.equal(renewalStatus('Please complete the captcha to continue').status, 'captcha');
});

test('original screenshot bytes are sent in one branded report', async () => {
  const image = Buffer.from('ORIGINAL_SCREENSHOT');
  let call;
  await report({ send: async (...args) => { call = args; } },
    { account: 1, server: 2, reason: '登录：验证码超时' },
    { isClosed: () => false, screenshot: async options => { assert.equal(options.path, undefined); return image; } });
  assert.match(call[0], /^Katabump 报告/);
  assert.match(call[0], /账号 1 · 服务器 2/);
  assert.equal(call[1], image);
});

test('screenshot failure falls back without leaking the exception', async () => {
  let call;
  await report({ send: async (...args) => { call = args; } }, { account: 1, reason: '登录失败' },
    { isClosed: () => false, screenshot: async () => { throw new Error('PRIVATE_URL'); } });
  assert.equal(call[1], undefined);
  assert.ok(!call[0].includes('PRIVATE_URL'));
});

test('Telegram sends photo with caption and checks API ok', async () => {
  let url, body;
  const notifier = new Notifier({ token: 'token', chatId: 'chat', fetchImpl: async (target, options) => {
    url = target; body = options.body;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  assert.equal(await notifier.send('Katabump 报告', Buffer.from('image')), true);
  assert.ok(url.endsWith('/sendPhoto'));
  assert.equal(body.get('caption'), 'Katabump 报告');
  assert.equal(body.get('photo').name, 'result.png');
  assert.equal(notifier.photos, 1);
});

test('rejected photo falls back to text and does not count as delivered image', async () => {
  const calls = [];
  const notifier = new Notifier({ token: 'token', chatId: 'chat', fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body });
    return { ok: !url.endsWith('/sendPhoto'), status: url.endsWith('/sendPhoto') ? 400 : 200,
      json: async () => ({ ok: !url.endsWith('/sendPhoto') }) };
  } });
  assert.equal(await notifier.send('safe', Buffer.from('image')), true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.get('text'), /回退文字通知/);
  assert.equal(notifier.photos, 0);
});

test('Telegram rate limit is retried with bounded delay', async () => {
  const delays = [];
  let count = 0;
  const notifier = new Notifier({ token: 'token', chatId: 'chat', sleep: async ms => delays.push(ms),
    fetchImpl: async () => ++count === 1
      ? { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 600 } }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) } });
  assert.equal(await notifier.send('safe'), true);
  assert.deepEqual(delays, [30000]);
});

test('per-server failure reports reason and continues, profile is removed', async () => {
  const reports = [];
  let profile, closed = false, count = 0;
  const page = {};
  await processAccount(validUser, undefined, {}, {
    launchBrowser: async directory => { profile = directory; return { pages: () => [page], close: async () => { closed = true; } }; },
    flow: { login: async () => {}, getServers: async () => ['one', 'two'], renewServer: async () => {
      if (++count === 1) throw new RenewalError('续期：验证码超时');
      return { status: 'success', reason: '已确认' };
    } }, sendReport: async (_, result) => reports.push(result),
  });
  assert.equal(reports.length, 2);
  assert.match(reports[0].reason, /验证码超时/);
  assert.equal(reports[1].status, 'success');
  assert.equal(closed, true);
  await assert.rejects(fs.access(profile));
});

test('browser initialization exception is sanitized and reported', async () => {
  let result;
  await processAccount(validUser, undefined, {}, {
    launchBrowser: async () => { throw new Error('PRIVATE_TOKEN=secret'); },
    sendReport: async (_, value) => { result = value; },
  });
  assert.match(result.reason, /浏览器初始化/);
  assert.ok(!result.reason.includes('PRIVATE_TOKEN'));
});

test('business failure still returns zero and processes remaining accounts', async () => env({
  USERS_JSON: JSON.stringify([{ username: 'a', password: 'p' }, { username: 'b', password: 'p' }]),
}, async () => {
  let processed = 0, notified = 0;
  const notifier = { delivered: 0, attempted: 0, photos: 0, send: async () => { notified++; } };
  const code = await main({ notifier, processUser: async () => { if (++processed === 1) throw new Error('secret'); } });
  assert.equal(code, 0);
  assert.equal(processed, 2);
  assert.equal(notified, 1);
}));

test('setup failure reports without requiring browser packages', async () => env({ SETUP_FAILED: 'true' }, async () => {
  let caption;
  const notifier = { delivered: 0, attempted: 0, photos: 0, send: async message => { caption = message; } };
  assert.equal(await main({ notifier }), 0);
  assert.match(caption, /依赖或浏览器安装失败/);
}));

test('negative renewal wording is never classified as success', () => {
  assert.equal(renewalStatus('Server has not been successfully renewed').status, 'failure');
  assert.equal(renewalStatus('Renewal unsuccessful').status, 'failure');
});

test('plain renewed confirmation is recognized', () => {
  assert.equal(renewalStatus('Your server has been renewed.').status, 'success');
  assert.equal(renewalStatus('The server was renewed!').status, 'success');
});

test('expiry parsing rejects counters and supports dates and timestamps', () => {
  const expected = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(expiryTimestamp('2026-10-01T00:00:00Z'), expected);
  assert.equal(expiryTimestamp(String(expected / 1000)), expected);
  assert.equal(expiryTimestamp('20'), null);
  assert.equal(expiryTimestamp('10'), null);
  assert.equal(expiryTimestamp('2026/10-02'), Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(expiryTimestamp('tomorrow'), null);
});

test('expiry comparison requires one unambiguous date field', async () => {
  assert.equal(await readExpiry({ evaluate: async () => ['2026/10-02', '2026-10-02'] }), Date.UTC(2026, 9, 2));
  assert.equal(await readExpiry({ evaluate: async () => ['2026-10-02', '2026-10-03'] }), null);
});

test('renewal notice never invents a year for partial dates', () => {
  const result = renewalStatus("You can't renew your server yet, as of October 1");
  assert.equal(result.status, 'skipped');
  assert.ok(!result.reason.includes('2001'));
  assert.match(result.reason, /具体时间见截图/);
  const complete = renewalStatus("You can't renew your server yet, as of 2026-10-01T00:00:00Z");
  assert.match(complete.reason, /2026-10-01T00:00:00.000Z/);
});
