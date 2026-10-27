# Leivra · 蕾芙菈

留一处空间，慢慢说。

私人 AI 陪伴应用的第一阶段 UI 原型，面向 Windows 与 Android。当前完全本地模拟，不调用 AI、不上传消息、不连接 Cloudflare。

## 启动
需要 Node.js 22.12+（已用 Node 24 验证）与 pnpm 11。标准 Node 安装包含 npm，可运行 npm install -g pnpm@11 安装 pnpm。

PowerShell：
~~~powershell
cd D:\GCHYL\GAME\Leivra
pnpm install
pnpm dev
~~~
打开终端显示的 localhost 地址（默认 http://localhost:5173）。

本机只检测到 Codex 自带 Node 与 pnpm，没有系统 npm。可直接运行项目附带的启动脚本：
~~~powershell
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
~~~
脚本优先使用系统 pnpm；缺失时使用本机 Codex 自带的 pnpm，不进行全局安装。

构建与生产预览：
~~~powershell
pnpm test
pnpm build
pnpm preview
~~~
生产预览默认 http://localhost:4173。开发模式不启用 service worker，离线/PWA 验证请用生产预览。

## 手机预览
开发服务器绑定 0.0.0.0。同一 Wi-Fi 下，在手机浏览器打开电脑局域网 IP 加端口，例如 http://192.168.1.20:5173。电脑需允许此端口通过专用网络防火墙；项目不会自动修改防火墙。
普通局域网 HTTP 可以验收聊天布局，但 Android PWA 安装和 service worker 需要受信任的 HTTPS。localhost 例外仅适用于设备自身，不能把手机上的 localhost 当成电脑。正式 HTTPS 部署尚未执行。

## 已实现
- 桌面侧栏、手机单页聊天，左右气泡、头像、日期与时间。
- 本地模拟多气泡回复、输入状态、发送防重复、中文输入法保护。
- Enter 发送、Shift+Enter 换行；触屏 Enter 换行，按钮发送。
- localStorage 暂存最近 500 条，单条最多 2000 字符；存储损坏或不可用时提示。
- 浅色/深色主题（首次跟随系统，此后保存选择）。
- JSON 导出、确认后清空，清空时取消尚未完成的模拟回复。
- PWA manifest、192/512 图标、生产离线应用壳与新版本更新提示。

## 原型数据边界
消息未加密，只存在当前浏览器与当前 origin；共用浏览器的人可查看。更换端口、浏览器或设备不会共享。清理浏览器站点数据会丢失记录。无账号、云同步或长期记忆。多标签页并发修改不支持。模拟回复为关键词规则，不能代表最终 AI 体验。

## 角色与头像
修改 src/chat.ts 的 character 配置替换头像地址。默认 public/avatar.svg 和 public/user.svg 为原创占位插画；上传自定义头像尚未实现。

## 项目结构
- src/App.tsx：聊天和设置交互
- src/chat.ts：消息类型、角色配置、ChatProvider 接口和模拟实现
- src/storage.ts：记录校验、版本化存储
- src/styles.css：Tailwind 引入与主题、响应式样式
- public/：头像及 PWA 图标
- docs/：需求、设计、架构、阶段计划和决策

## 后续部署（未执行）
计划前端 Cloudflare Pages、后端 Workers、数据 D1。正式上线前需明确身份验证、访问边界、数据导出/删除及模型预算。未来浏览器仅调用后端 /api/chat，后端持有模型密钥。当前仓库不包含真实 API、Workers 或 D1 配置。
未引入付费第三方服务；未来 OpenAI API 通常涉及用量费用，接入需单独授权。

## 技术参考
- https://tailwindcss.com/docs/installation/using-vite
- https://vite-pwa-org.netlify.app/guide/
- https://vite.dev/guide/
## 浏览器回归
首次准备：
~~~powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\work\browsers"
pnpm exec playwright install chromium --only-shell
pnpm build
pnpm test:e2e
~~~
回归脚本自行启动 127.0.0.1:4180 生产预览，结束时关闭该测试服务。覆盖桌面、360/390/412px 移动视口、发送、刷新、主题、导出、清空取消、IME、离线重载和损坏存储；截图输出到 test-results/。这些测试不等同于 Android 实机验收。
