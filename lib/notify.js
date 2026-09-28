'use strict';

class Notifier {
  constructor({ token = process.env.TG_BOT_TOKEN, chatId = process.env.TG_CHAT_ID,
    enabled = process.env.SEND_TG !== 'false', fetchImpl = fetch,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { token, chatId, enabled, fetchImpl, sleep });
    this.attempted = 0;
    this.delivered = 0;
    this.photos = 0;
  }

  async request(method, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let delay = 2000;
      try {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', body, signal: AbortSignal.timeout(30000),
        });
        const data = await response.json();
        if (response.ok && data.ok === true) return true;
        if (response.status === 429) {
          delay = Math.min(30000, Math.max(1000, Number(data.parameters?.retry_after || 2) * 1000));
        } else if (response.status >= 400 && response.status < 500) {
          return false;
        }
      } catch {
        // Telegram exceptions may contain the bot token; never log them.
      }
      if (attempt < 2) await this.sleep(delay);
    }
    return false;
  }

  async send(caption, image) {
    if (!this.enabled || !this.token || !this.chatId) return false;
    this.attempted++;
    if (image?.length) {
      const body = new FormData();
      body.set('chat_id', this.chatId);
      body.set('caption', caption.slice(0, 1000));
      body.set('photo', new Blob([image], { type: 'image/png' }), 'result.png');
      if (await this.request('sendPhoto', body)) {
        this.delivered++;
        this.photos++;
        return true;
      }
      caption += '\n图片发送失败，已回退文字通知。';
    } else {
      caption += '\n当前无法获取页面截图。';
    }
    const body = new URLSearchParams({ chat_id: this.chatId, text: caption.slice(0, 4000) });
    const sent = await this.request('sendMessage', body);
    if (sent) this.delivered++;
    return sent;
  }
}

async function report(notifier, { account, server, status = 'failure', reason }, page) {
  const titles = { success: '✅ 续期成功', skipped: '⏳ 暂无需续期', failure: '❌ 续期失败', uncertain: '⚠️ 续期结果待确认' };
  const label = account ? `账号 ${account}${server ? ` · 服务器 ${server}` : ''}` : '任务运行';
  const caption = `Katabump 报告\n${titles[status] || titles.failure}\n${label}\n原因：${reason}`;
  let image;
  if (page && !page.isClosed()) {
    try {
      image = await page.screenshot({ type: 'png', fullPage: true, timeout: 15000 });
    } catch { /* No original screenshot is written to disk. */ }
  }
  return notifier.send(caption, image);
}

module.exports = { Notifier, report };
