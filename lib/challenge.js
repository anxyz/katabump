'use strict';

const { RenewalError } = require('./config');

class ChallengeError extends RenewalError {}

function challengeObserver() {
  const roots = new Set();
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = original.call(this, init);
    roots.add(root);
    return root;
  };

  // Re-read layout when clicking: the widget can render hidden, resize or reset.
  Object.defineProperty(window, '__turnstile_data', {
    configurable: true,
    get() {
      for (const root of [document, ...roots]) {
        if (root.host && !root.host.isConnected) continue;
        for (const checkbox of root.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) {
          if (!checkbox.isConnected || checkbox.checked || checkbox.disabled
            || checkbox.getAttribute('aria-checked') === 'true'
            || checkbox.getAttribute('aria-disabled') === 'true') continue;
          const rect = checkbox.getBoundingClientRect();
          const style = getComputedStyle(checkbox);
          if (!rect.width || !rect.height || style.visibility === 'hidden'
            || !innerWidth || !innerHeight) continue;
          const xRatio = (rect.left + rect.width / 2) / innerWidth;
          const yRatio = (rect.top + rect.height / 2) / innerHeight;
          if (xRatio >= 0 && xRatio <= 1 && yRatio >= 0 && yRatio <= 1) return { xRatio, yRatio };
        }
      }
      return null;
    },
  });
}

function challengeState(root) {
  const node = root?.querySelector ? root : document;
  const active = element => {
    for (let el = element; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (el.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const hasToken = input => typeof input?.value === 'string' && input.value.length > 20;
  const selector = 'input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"]';
  const widgets = [...node.querySelectorAll('.cf-turnstile')].filter(active);
  const inputs = [...node.querySelectorAll(selector)].filter(input => active(input.parentElement));
  const frames = [...node.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')].filter(active);
  const solved = widgets.length ? widgets.every(widget => {
    const fields = [...widget.querySelectorAll(selector)];
    if (fields.length) return fields.every(hasToken);
    // Some integrations disable or rename the hidden response field.
    try { return window.turnstile?.getResponse(widget)?.length > 20; }
    catch { return false; }
  }) : inputs.length > 0 && inputs.every(hasToken);
  return { present: !!(widgets.length || inputs.length || frames.length), solved: !!solved };
}

async function clickChallenge(page, scope = page, clicked = new WeakMap()) {
  for (const frame of page.frames()) {
    let session, element;
    try {
      const host = new URL(frame.url()).hostname;
      if (host !== 'challenges.cloudflare.com' && !host.endsWith('.challenges.cloudflare.com')) continue;
      if (Date.now() - (clicked.get(frame) || 0) < 5000) continue;
      element = await frame.frameElement();
      if (scope !== page && !await scope.evaluate((root, el) => {
        for (let current = el; current; current = current.parentElement || current.getRootNode().host) {
          if (current === root) return true;
        }
        return false;
      }, element)) continue;
      if (!await element.isVisible()) continue;
      await element.scrollIntoViewIfNeeded({ timeout: 1500 });
      const data = await frame.evaluate(() => window.__turnstile_data);
      if (!data || !Number.isFinite(data.xRatio) || !Number.isFinite(data.yRatio)) continue;
      const box = await element.boundingBox();
      if (!box?.width || !box.height) continue;
      const point = { x: box.x + box.width * data.xRatio, y: box.y + box.height * data.yRatio };
      session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1,
      });
      await page.waitForTimeout(80);
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1,
      });
      clicked.set(frame, Date.now());
      return true;
    } catch {
      // A reset can detach a challenge frame between locating it and clicking it.
    } finally {
      if (session) await session.detach().catch(() => {});
      if (element) await element.dispose().catch(() => {});
    }
  }
  return false;
}

async function solveChallenge(page, scope = page, timeout = 45000) {
  const deadline = Date.now() + timeout;
  const clicked = new WeakMap();
  while (Date.now() < deadline) {
    const state = await scope.evaluate(challengeState);
    if (!state.present || state.solved) return;
    await clickChallenge(page, scope, clicked);
    await page.waitForTimeout(Math.max(0, Math.min(500, deadline - Date.now())));
  }
  // Do not miss a token received during the final polling interval.
  if ((await scope.evaluate(challengeState)).solved) return;
  throw new ChallengeError('验证码：Turnstile 验证超时');
}

module.exports = { ChallengeError, challengeObserver, challengeState, clickChallenge, solveChallenge };
