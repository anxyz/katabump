'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { launch } = require('../lib/launch');

test('native Chrome closes completely so its profile can be reused', async t => {
  const previousBypass = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  t.after(() => {
    for (const [key, value] of Object.entries(previousBypass)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.NO_PROXY = 'upper-proxy-bypass.invalid';
  process.env.no_proxy = 'lower-proxy-bypass.invalid';
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'katabump-native-test-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await launch(profile, undefined, { headless: true, startupTimeout: 30000 });
    for (const key of ['NO_PROXY', 'no_proxy']) {
      assert.ok(process.env[key].split(',').includes('upper-proxy-bypass.invalid'));
      assert.ok(process.env[key].split(',').includes('lower-proxy-bypass.invalid'));
      assert.ok(process.env[key].split(',').includes('127.0.0.1'));
    }
    const page = session.pages()[0] || await session.newPage();
    const browser = page.context().browser();
    try {
      await page.goto('data:text/html,<p>Native Chrome ready</p>');
      assert.equal(await page.locator('p').innerText(), 'Native Chrome ready');
    } finally { await session.close(); }
    assert.equal(browser.isConnected(), false);
    await session.close();
  }
});

test('native Chrome supports authenticated HTTP proxies without placing credentials in the proxy URL', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'katabump-proxy-test-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const expected = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
  let authenticated = false;
  const proxy = http.createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== expected) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test proxy"' });
      response.end();
      return;
    }
    authenticated = true;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<p>Authenticated proxy ready</p>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve)); });
  const session = await launch(profile, { server: `http://127.0.0.1:${proxy.address().port}`,
    username: 'fixture-user', password: 'fixture-password' }, { headless: true, startupTimeout: 30000 });
  try {
    const page = session.pages()[0] || await session.newPage();
    await page.goto('http://katabump-fixture.invalid');
    assert.equal(await page.locator('p').innerText(), 'Authenticated proxy ready');
    assert.equal(authenticated, true);
  } finally { await session.close(); }
});
