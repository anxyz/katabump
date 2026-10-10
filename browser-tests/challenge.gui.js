'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launch } = require('../lib/launch');
const { solveChallenge } = require('../lib/challenge');

test('GUI verification sends mouse events with the actual browser screen coordinates', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'katabump-gui-test-'));
  const session = await launch(profile, undefined, { headless: false });
  try {
    const page = session.pages()[0] || await session.newPage();
    await page.context().route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      new URL(route.request().url()).hostname === 'challenges.cloudflare.com'
        ? `<body style="margin:0;min-height:100vh"><script>
          const root = document.body.attachShadow({mode:'closed'});
          root.innerHTML = '<input type="checkbox" style="position:fixed;left:20px;top:20px;width:24px;height:24px;margin:0">';
          window.testCheckbox = root.querySelector('input');
          testCheckbox.addEventListener('pointerdown', event => parent.postMessage({
            screenX:event.screenX, screenY:event.screenY, trusted:event.isTrusted
          }, 'https://dashboard.katabump.com'));
        </script>`
        : `<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response">
          <iframe src="https://challenges.cloudflare.com/widget" style="border:0;width:300px;height:70px"></iframe></div>
          <script>addEventListener('message', event => {
            window.lastPointer = event.data;
            document.querySelector('input').value = 'a-fixture-response-with-more-than-twenty-characters';
          });</script>`,
    }));
    await page.goto('https://dashboard.katabump.com');
    const frame = page.frames().find(frame => frame.url().includes('challenges.cloudflare.com'));
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    await element.dispose();
    const point = { x: box.x + 32, y: box.y + 32 };
    await solveChallenge(page, page, 15000);
    const pointer = await page.evaluate(() => window.lastPointer);
    const expected = await page.evaluate(point => {
      const border = Math.max(0, (outerWidth - innerWidth) / 2);
      return { x: Math.round((screenX + border + point.x) * devicePixelRatio),
        y: Math.round((screenY + outerHeight - innerHeight - border + point.y) * devicePixelRatio) };
    }, point);
    assert.equal(pointer.trusted, true);
    assert.ok(Math.abs(pointer.screenX - expected.x) <= 2);
    assert.ok(Math.abs(pointer.screenY - expected.y) <= 2);
    t.diagnostic(`screenY: GUI=${pointer.screenY}, expected=${expected.y}`);
  } finally {
    await session.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
