'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { RenewalError, loadUsers, proxyConfig } = require('./lib/config');
const { Notifier, report } = require('./lib/notify');
const automation = require('./lib/browser');

async function launch(profile, proxy) {
  const { chromium } = require('playwright-extra');
  chromium.use(require('puppeteer-extra-plugin-stealth')());
  const executablePath = process.env.CHROME_PATH
    || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync);
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath && { executablePath }), proxy, headless: process.env.HEADLESS === 'true',
    viewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
  });
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(45000);
  await context.addInitScript(automation.challengeObserver);
  return context;
}

async function processAccount(user, proxy, notifier, { launchBrowser = launch, flow = automation, sendReport = report } = {}) {
  let profile, context, page;
  let stage = '浏览器初始化';
  const label = { account: user.index };
  const outcomes = [];
  try {
    if (!user.valid) throw new RenewalError('账号配置：username 或 password 为空或类型错误');
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'katabump-'));
    context = await launchBrowser(profile, proxy);
    page = context.pages()[0] || await context.newPage();
    stage = '登录';
    await flow.login(page, user);
    stage = '读取服务器列表';
    const servers = await flow.getServers(page);
    for (let index = 0; index < servers.length; index++) {
      const item = { ...label, server: index + 1 };
      try {
        const result = await flow.renewServer(page, servers[index]);
        outcomes.push(result.status);
        await sendReport(notifier, { ...item, ...result }, page);
      } catch (error) {
        const status = error instanceof RenewalError && error.uncertain ? 'uncertain' : 'failure';
        outcomes.push(status);
        await sendReport(notifier, { ...item, status, reason: error instanceof RenewalError
          ? error.message : '续期：页面或网络操作异常，请检查站点状态' }, page);
      }
    }
  } catch (error) {
    outcomes.push('failure');
    await sendReport(notifier, { ...label, reason: error instanceof RenewalError
      ? error.message : `${stage}：操作异常，请检查配置、网络或站点状态` }, page);
  } finally {
    if (context) await context.close().catch(() => {});
    if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  return outcomes;
}

async function main({ notifier = new Notifier(), processUser = processAccount } = {}) {
  const outcomes = { success: 0, skipped: 0, failure: 0, uncertain: 0 };
  try {
    if (process.env.SETUP_FAILED === 'true') throw new RenewalError('运行环境：依赖或浏览器安装失败，本次未执行续期');
    const users = loadUsers(process.env.USERS_JSON);
    const proxy = proxyConfig(process.env.HTTP_PROXY);
    for (const user of users) {
      try {
        for (const status of await processUser(user, proxy, notifier) || []) {
          if (Object.hasOwn(outcomes, status)) outcomes[status]++;
        }
      } catch {
        outcomes.failure++;
        await report(notifier, { account: user.index, reason: '账号处理异常，本次未完成' });
      }
    }
  } catch (error) {
    outcomes.failure++;
    await report(notifier, { reason: error instanceof RenewalError ? error.message : '运行异常，请检查配置和运行环境' });
  }
  const summary = `任务已结束：续期成功 ${outcomes.success}，暂无需续期 ${outcomes.skipped}，失败 ${outcomes.failure}，待确认 ${outcomes.uncertain}。\n`
    + `Telegram 已送达 ${notifier.delivered}/${notifier.attempted} 条通知（图片 ${notifier.photos} 条）。账号详情、原因及截图请查看私密通知。\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.writeFile(process.env.GITHUB_STEP_SUMMARY, summary).catch(() => {});
  }
  return 0;
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 0; });
}
module.exports = { main, processAccount };
