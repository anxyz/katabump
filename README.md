Katabump
北京时间05:10续期，TG发送原因和原图。
Secrets：USERS_JSON、TG_BOT_TOKEN、TG_CHAT_ID。
格式见示例，代理可选HTTP_PROXY。

验证码会随页面布局重新定位；登录或续期验证码超时后，最多重新加载验证页面 2 次。
默认采用原生 Chrome，通过浏览器无障碍树识别验证框，不向验证码页面注入脚本。
每个账号使用独立临时配置，结束后关闭浏览器并清理。
Linux 有头环境通过系统鼠标完成验证点击，保持真实的窗口及屏幕坐标；无头环境使用 CDP 点击。
续期提交后仅在站点明确拒绝验证码时重试，结果不明确会报告「待确认」。
Actions 摘要显示匿名结果计数和故障阶段，账号详情、原因及原图仍只发送到 Telegram。
浏览器回归测试在独立的 Checks 工作流执行，定时续期和通知不会等待浏览器自测。

手动运行可选 `diagnose`：仅打开空白登录页，对比旧版注入与当前方式，输出诊断截图和状态，不读取账号或执行续期。
`diagnose_warp` 可额外对比 WARP；正常续期仍使用直连或配置的 `HTTP_PROXY`。

本地检查：`npm run check && npm test && npm run test:browser && npm run test:gui`。
浏览器测试需安装 Chrome/Chromium，GUI 测试另需 `xvfb`、`xdotool`。
