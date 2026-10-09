'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const net = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');
const { RenewalError } = require('./config');
const { challengeObserver } = require('./challenge');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
  });
}

async function launch(profile, proxy, {
  executablePath, headless = process.env.HEADLESS === 'true', startupTimeout = 60000,
} = {}) {
  const { chromium } = require('playwright-extra');
  chromium.use(require('puppeteer-extra-plugin-stealth')());
  executablePath ||= process.env.CHROME_PATH
    || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync)
    || chromium.executablePath();
  const port = await availablePort();
  // CDP is local even when the browser itself uses a proxy.
  for (const key of ['NO_PROXY', 'no_proxy']) {
    process.env[key] = [...new Set((process.env[key] || '').split(',').filter(Boolean)
      .concat(['localhost', '127.0.0.1', '[::1]']))].join(',');
  }
  const args = [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720',
  ];
  if (headless) args.push('--headless=new');
  if (proxy) args.push(`--proxy-server=${proxy.server}`);
  args.push('about:blank');
  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchFailed = false, browser, closing, endpoint, startupOutput = '';
  child.once('error', () => { launchFailed = true; });
  child.stderr.on('data', chunk => {
    // Keep startup output in memory only; Chrome announces its actual CDP endpoint here.
    startupOutput = (startupOutput + chunk.toString()).slice(-8192);
    const match = startupOutput.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
    if (match && new URL(match[1]).port === String(port)) endpoint = match[1];
  });
  const close = () => closing ||= (async () => {
    try { if (browser) await browser.close().catch(() => {}); }
    finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        if (!await waitForExit(child, 3000)) {
          child.kill('SIGKILL');
          await waitForExit(child, 1000);
        }
      }
    }
  })();

  try {
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      if (launchFailed || child.exitCode !== null || child.signalCode !== null) break;
      if (endpoint) break;
      await sleep(200);
    }
    if (!endpoint) throw new RenewalError('浏览器初始化：原生 Chrome 启动失败或调试端口未就绪');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000, noDefaults: true });
    const context = browser.contexts()[0];
    if (proxy?.username) await context.setHTTPCredentials({ username: proxy.username, password: proxy.password || '' });
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(45000);
    await context.addInitScript(challengeObserver);
    // Closing the CDP connection alone leaves a separately launched Chrome running.
    return { pages: () => context.pages(), newPage: () => context.newPage(), close };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { launch };
