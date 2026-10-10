'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { chromium } = require('playwright');
const { challengeObserver, challengeState, solveChallenge, clickChallenge, enableAccessibilityLookup } = require('../lib/challenge');
const { login, renewServer } = require('../lib/browser');

const ORIGIN = 'https://dashboard.katabump.com';
const TOKEN = 'fixture-response-with-at-least-twenty-characters';
let browser;

before(async () => {
  const executablePath = process.env.CHROME_PATH
    || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
  browser = await chromium.launch({ ...(executablePath && { executablePath }), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => { await browser?.close(); });

async function fixture(t, handler, { observe = true } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  if (observe) await context.addInitScript(challengeObserver);
  else enableAccessibilityLookup(context);
  await context.route('**/*', async route => {
    const body = await handler(new URL(route.request().url()), route.request());
    await route.fulfill({ status: 200, contentType: 'text/html', body: body || '<html></html>' });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  return page;
}

function widget({ hidden = false, token = '', frame = false } = {}) {
  return `<div class="cf-turnstile" ${hidden ? 'hidden' : ''}>
    <input type="hidden" name="cf-turnstile-response" value="${token}">
    ${frame ? '<iframe src="https://challenges.cloudflare.com/widget" style="width:300px;height:70px;border:0"></iframe>' : ''}
  </div>`;
}

const closedShadowFrame = `<body><script>
  const root = document.body.attachShadow({mode:'closed'});
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.style.cssText = 'position:fixed;left:20px;top:20px;width:24px;height:24px;display:none;margin:0';
  box.addEventListener('change', () => parent.postMessage('verified', '${ORIGIN}'));
  root.append(box);
  window.showCheckbox = () => { box.style.display = 'block'; };
  window.moveCheckbox = () => { box.style.left = '200px'; };
</script>`;

test('a closed-shadow checkbox is found after a CSS-only reveal and a layout change', async t => {
  const page = await fixture(t, url => url.hostname === 'challenges.cloudflare.com' ? closedShadowFrame
    : `${widget({ frame: true })}<script>addEventListener('message', event => {
        if(event.origin === 'https://challenges.cloudflare.com' && event.data === 'verified')
          document.querySelector('input[name="cf-turnstile-response"]').value = '${TOKEN}';
      });</script>`);
  await page.goto(ORIGIN);
  const frame = page.frames().find(frame => frame.url().includes('challenges.cloudflare.com'));
  assert.equal(await frame.evaluate(() => window.__turnstile_data), null);
  await frame.evaluate(() => window.showCheckbox());
  const first = await frame.evaluate(() => window.__turnstile_data);
  assert.ok(first.xRatio < 0.2);
  await frame.evaluate(() => window.moveCheckbox());
  const moved = await frame.evaluate(() => window.__turnstile_data);
  assert.ok(moved.xRatio > 0.6);
  await solveChallenge(page, page, 2000);
  assert.equal((await page.evaluate(challengeState)).solved, true);
  assert.equal(await clickChallenge(page), false, 'a checked checkbox must not be clicked again');
});

test('a hidden stale widget does not block a solved login form', async t => {
  const page = await fixture(t, () => widget({ token: TOKEN }) + widget({ hidden: true }));
  await page.goto(ORIGIN);
  assert.deepEqual(await page.evaluate(challengeState), { present: true, solved: true });
});

test('the accessibility tree locates a moved closed-shadow checkbox without injecting scripts', async t => {
  const page = await fixture(t, url => url.hostname === 'challenges.cloudflare.com' ? closedShadowFrame
    : `${widget({ frame: true })}<script>addEventListener('message', event => {
        if(event.origin === 'https://challenges.cloudflare.com' && event.data === 'verified')
          document.querySelector('input[name="cf-turnstile-response"]').value = '${TOKEN}';
      });</script>`, { observe: false });
  await page.goto(ORIGIN);
  const frame = page.frames().find(frame => frame.url().includes('challenges.cloudflare.com'));
  assert.equal(await frame.evaluate(() => window.__turnstile_data), undefined);
  assert.equal(await clickChallenge(page), false);
  await frame.evaluate(() => { window.showCheckbox(); window.moveCheckbox(); });
  await solveChallenge(page, page, 3000);
  assert.equal((await page.evaluate(challengeState)).solved, true);
  assert.equal(await clickChallenge(page), false);
});

test('a shadow root attached after polling is still discoverable', async t => {
  const page = await fixture(t, () => `<script>
    const host = document.createElement('div');
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = '<input type="checkbox">';
    window.attachWidget = () => document.body.append(host);
  </script>`);
  await page.goto(ORIGIN);
  assert.equal(await page.evaluate(() => window.__turnstile_data), null);
  await page.evaluate(() => window.attachWidget());
  assert.ok(await page.evaluate(() => window.__turnstile_data));
});

test('a widget without a response field uses its own Turnstile API response', async t => {
  const page = await fixture(t, () => `<div class="cf-turnstile" id="active"></div><script>
    window.turnstile = { getResponse: widget => widget.id === 'active' ? '${TOKEN}' : '' };
  </script>`);
  await page.goto(ORIGIN);
  assert.deepEqual(await page.evaluate(challengeState), { present: true, solved: true });
});

test('one solved widget cannot satisfy another visible widget', async t => {
  const page = await fixture(t, () => widget({ token: TOKEN }) + widget());
  await page.goto(ORIGIN);
  assert.equal((await page.evaluate(challengeState)).solved, false);
});

test('renewal only clicks a challenge inside the active modal', async t => {
  const page = await fixture(t, url => url.hostname === 'challenges.cloudflare.com' ? closedShadowFrame
    : widget({ frame: true }) + `<div id="renew-modal">${widget()}</div>`);
  await page.goto(ORIGIN);
  const frame = page.frames().find(frame => frame.url().includes('challenges.cloudflare.com'));
  await frame.evaluate(() => window.showCheckbox());
  assert.equal(await clickChallenge(page, page.locator('#renew-modal')), false);
});

test('login reloads a timed-out challenge before submitting credentials', async t => {
  let visits = 0, submissions = 0;
  const page = await fixture(t, (url, request) => {
    if (request.method() === 'POST') { submissions++; return '<a href="/server/1">See</a>'; }
    visits++;
    return `<form action="/" method="post"><input type="email" name="email"><input type="password" name="password">
      ${widget({ token: visits > 1 ? TOKEN : '' })}<button>Login</button></form>`;
  });
  await login(page, { username: 'test@example.com', password: 'fixture-password' }, {
    challengeTimeout: 300, retryDelay: 0,
  });
  assert.equal(visits, 2);
  assert.equal(submissions, 1);
});

function serverPage(token, warning = '') {
  return `<p>${warning}</p><button onclick="document.getElementById('renew-modal').hidden=false">Renew</button>
    <div id="renew-modal" hidden><form action="/server/1/renew" method="post">
      ${widget({ token })}<button>Renew</button></form></div>`;
}

const fastRenewal = { challengeTimeout: 300, confirmationTimeout: 600, retryDelay: 0 };

test('a renewal challenge timeout reloads and reopens the modal without sending a renewal', async t => {
  let visits = 0, submissions = 0;
  const page = await fixture(t, (_, request) => {
    if (request.method() === 'POST') { submissions++; return 'Your server has been renewed.'; }
    return serverPage(++visits > 1 ? TOKEN : '');
  });
  const result = await renewServer(page, ORIGIN + '/server/1', fastRenewal);
  assert.equal(result.status, 'success');
  assert.equal(visits, 2);
  assert.equal(submissions, 1);
});

test('an explicit captcha rejection opens a fresh modal before retrying', async t => {
  let visits = 0, submissions = 0;
  const page = await fixture(t, (_, request) => {
    if (request.method() === 'POST') {
      return ++submissions === 1 ? serverPage('', 'Please complete the captcha to continue')
        : 'Your server has been renewed.';
    }
    visits++;
    return serverPage(TOKEN);
  });
  const result = await renewServer(page, ORIGIN + '/server/1', fastRenewal);
  assert.equal(result.status, 'success');
  assert.equal(visits, 2);
  assert.equal(submissions, 2);
});

test('a submitted renewal with an unknown outcome is never repeated', async t => {
  let submissions = 0;
  const page = await fixture(t, (_, request) => {
    if (request.method() === 'POST') { submissions++; return '<p>Dashboard</p>'; }
    return serverPage(TOKEN);
  });
  await assert.rejects(renewServer(page, ORIGIN + '/server/1', fastRenewal), error => error.uncertain === true);
  assert.equal(submissions, 1);
});

test('persistent challenge failures stop after three page loads without submitting', async t => {
  let visits = 0, submissions = 0;
  const page = await fixture(t, (_, request) => {
    if (request.method() === 'POST') submissions++;
    visits++;
    return serverPage('');
  });
  await assert.rejects(renewServer(page, ORIGIN + '/server/1', fastRenewal), /连续 3 次超时/);
  assert.equal(visits, 3);
  assert.equal(submissions, 0);
});
