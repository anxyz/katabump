'use strict';

// This probe never loads credentials, submits a form, or sends notifications.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { launch } = require('../lib/launch');
const { challengeState, clickChallenge } = require('../lib/challenge');

async function main() {
  const mode = ['direct', 'warp', 'native', 'native-dom'].includes(process.argv[2]) ? process.argv[2] : 'direct';
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'katabump-probe-'));
  const directory = path.resolve('.diagnostics');
  const codes = new Set(), network = new Set();
  const result = { mode, solved: false, clicks: 0 };
  let session, page;
  await fs.mkdir(directory, { recursive: true });
  try {
    session = await launch(profile, mode === 'warp' ? { server: 'socks5://127.0.0.1:40000' } : undefined, {
      stealth: !mode.startsWith('native'), observeChallenge: mode !== 'native-dom',
    });
    page = session.pages()[0] || await session.newPage();
    if (mode !== 'native-dom') await page.context().addInitScript(() => {
      const roots = [];
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = original.call(this, init);
        roots.push(root);
        return root;
      };
      window.__probeRoots = roots;
    });
    page.on('console', message => {
      const text = message.text();
      if (/cloudflare|turnstile/i.test(text)) {
        for (const code of text.match(/\b\d{6}\b/g) || []) codes.add(code);
      }
    });
    page.on('requestfailed', request => {
      const host = new URL(request.url()).hostname;
      const code = request.failure()?.errorText.match(/net::[A-Z0-9_]+/)?.[0];
      if (host.endsWith('.cloudflare.com') && code) network.add(`${host} ${code}`);
    });
    page.on('response', response => {
      const host = new URL(response.url()).hostname;
      if (host.endsWith('.cloudflare.com') && response.status() >= 400) network.add(`${host} HTTP ${response.status()}`);
    });
    const response = await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
    result.httpStatus = response.status();
    result.browserVersion = page.context().browser().version();
    result.environment = await page.evaluate(() => ({
      userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver,
    }));
    await page.locator('input[type="email"]').waitFor({ state: 'visible' });
    const deadline = Date.now() + 45000;
    const clicked = new WeakMap();
    while (Date.now() < deadline) {
      const state = await page.evaluate(challengeState);
      if (state.solved) { result.solved = true; break; }
      if (await clickChallenge(page, page, clicked)) result.clicks++;
      await page.waitForTimeout(1000);
    }
    result.frames = [];
    for (const frame of page.frames()) {
      const host = new URL(frame.url()).hostname;
      if (!host.endsWith('.cloudflare.com')) continue;
      if (mode === 'native-dom') {
        const client = await page.context().newCDPSession(frame);
        try {
          const { nodes } = await client.send('Accessibility.getFullAXTree');
          result.frames.push({ host, text: [...new Set(nodes.filter(node => !node.ignored && node.name?.value)
            .map(node => node.name.value))].slice(0, 20) });
        } finally { await client.detach().catch(() => {}); }
        continue;
      }
      const details = await frame.evaluate(() => {
        const roots = [document, ...(window.__probeRoots || [])];
        const checkboxes = roots.flatMap(root => [...root.querySelectorAll('input[type="checkbox"],[role="checkbox"]')])
          .map(el => ({ type: el.type, checked: el.checked, disabled: el.disabled, rect: el.getBoundingClientRect().toJSON() }));
        const text = [...new Set(roots.flatMap(root => [...root.querySelectorAll('label,span,p,[role="alert"]')])
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .map(el => el.textContent.trim()).filter(text => text && text.length < 300))].slice(0, 20);
        return { point: window.__turnstile_data, checkboxes, text };
      }).catch(() => ({ unavailable: true }));
      result.frames.push({ host, ...details });
    }
  } catch (error) {
    result.error = error.name;
  } finally {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, `${mode}.png`), fullPage: true }).catch(() => {});
    result.codes = [...codes];
    result.network = [...network];
    await fs.writeFile(path.join(directory, `${mode}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (session) await session.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch(() => { process.exitCode = 1; });
