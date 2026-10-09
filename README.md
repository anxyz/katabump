Katabump
北京时间05:10续期，TG发送原因和原图。
Secrets：USERS_JSON、TG_BOT_TOKEN、TG_CHAT_ID。
格式见示例，代理可选HTTP_PROXY。

验证码会随页面布局重新定位；登录或续期验证码超时后，最多重新加载验证页面 2 次。
浏览器采用上游的原生 Chrome + CDP 连接方式，每个账号使用独立临时配置，结束后关闭浏览器并清理。
续期提交后仅在站点明确拒绝验证码时重试，结果不明确会报告「待确认」。
Actions 摘要显示匿名结果计数和故障阶段，账号详情、原因及原图仍只发送到 Telegram。

本地检查：`npm run check && npm test && npm run test:browser`（浏览器测试需安装 Chrome/Chromium）。
