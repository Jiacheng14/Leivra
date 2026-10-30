# Leivra

我的目光永远注视着你。

面向 Windows 与 Android 的通用 AI 人格聊天应用本地原型，蕾芙菈是首个默认联系人。默认使用本地 Mock；已实现自然消息调度和本机 Workers → OpenAI Responses API 接入代码。未配置真实密钥、未执行付费调用、未部署云环境。

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

## 手机预览（Mock）
开发服务器绑定 0.0.0.0。同一 Wi-Fi 下，在手机浏览器打开电脑局域网 IP 加端口，例如 http://192.168.1.20:5173。电脑需允许此端口通过专用网络防火墙；项目不会自动修改防火墙。
普通局域网 HTTP 可以验收聊天布局；该环境没有可靠的 Web Locks 时，聊天与人物卡写入会安全降级为只读。Android PWA 安装和 service worker 需要受信任的 HTTPS。localhost 例外仅适用于设备自身，不能把手机上的 localhost 当成电脑。正式 HTTPS 部署尚未执行。

## 已实现
- 桌面侧栏、手机单页聊天，左右气泡、头像、日期与时间。
- 连续消息聚合、会话独立排队、多气泡延迟显示、生成期间继续发送、中文输入法保护。
- Enter 发送、Shift+Enter 换行；触屏 Enter 换行，按钮发送。
- IndexedDB 按角色完整保存聊天记录；用户单条最多 2000 字符，AI 支持长文自然段；存储损坏或不可用时提示。
- 浅色/深色主题（首次跟随系统，此后保存选择）。
- 完整 JSON 备份导出、确认后完整替换恢复；当前角色聊天可确认清空。
- PWA manifest、192/512 图标、生产离线应用壳与新版本更新提示。

## 原型数据边界
IndexedDB 的 leivra-local 数据库是唯一实时写入来源。首次启动会校验并迁移原 leivra.data.v1 或更早的消息键；提交并校验后才启用，原 localStorage 数据始终保留，不再实时写入。已有有效 IndexedDB 数据优先，旧快照不会覆盖它。数据未加密，只存在当前浏览器与当前 origin；共用浏览器的人可查看。更换端口、浏览器或设备不会共享。清理站点数据仍可能丢失记录。无账号、云同步或长期记忆。Web Locks 限定单页写入与调度，其他页面只读；不提供实时多页同步。模拟回复为关键词规则，不能代表最终 AI 体验。

在「聊天设置」中点击「导出完整备份」获得版本化 JSON；它包含全部人物卡、会话、消息、调度状态、聊天设置和主题，不包含 API Key 或 Cloudflare 凭证。JSON 含私人聊天内容，请妥善保存。「从备份恢复」会先校验文件并显示时间和数量，只有点击「确认恢复」才完整替换当前数据；替换前的 IndexedDB 快照保存在同一数据库内供回滚。损坏或不兼容的文件会被拒绝。恢复后中断的生成仅可手动重试，不会自动重发结果未知的请求。浏览器支持时应用会尝试申请持久存储；这不能替代定期导出备份。

导入历史备份后，所有可能产生新请求的待回复队列均暂停，刷新也不会自动发送；需要时点击「重试回复」。已保存的生成内容仍可继续显示。「导出恢复前快照」可在刷新后取回最近一次恢复前的数据，再通过同一确认恢复流程导入；下次恢复会替换该快照，请及时导出。数据库读取失败时禁止普通编辑，仍可尝试导出恢复前快照或从有效备份恢复。

## 角色与头像
在侧栏「联系人」中切换、通过「添加联系人」导入 Leivra v1 或 Character Card V2 JSON，或确认后删除联系人。手机点击标题栏的「打开联系人」使用同一侧栏。聊天设置 → 人物卡保留当前卡的编辑与导出。导入新角色使用不同的稳定 ID，聊天历史随 ID 保存，更名不丢失。详细字段、限制和迁移方式见 docs/CHARACTER_CARDS.md。
默认卡位于 src/characters/leivra.json，通过 defaultLeivra.ts 校验加载。默认 SVG 仍为项目原创插画；图片上传尚未实现。Mock 保持默认联系人的旧回复，其他角色使用中性固定模拟回复，自定义提示词在 Mock 中不生效，Real 会发送当前人物设定。

## 项目结构
- src/App.tsx：聊天和设置交互
- src/models.ts：角色、会话、消息、记忆与模型接口
- src/characters/：人物卡、校验、JSON 操作与默认 Mock 素材
- src/persona/PersonaRenderer.ts：唯一人格渲染入口，角色资料作为低信任上下文
- src/prompt.ts：通用聊天协议和 Prompt Builder
- src/chat.ts、src/providers/：Mock/Real ModelProvider
- src/scheduling/、src/reply.ts：独立会话调度、持久化、输出校验与气泡延迟
- worker/：仅供本机开发的 Workers 后端与 Responses API 适配
- src/storage.ts、src/indexedDb.ts、src/backup.ts：数据校验、事务存储、旧版迁移与备份恢复
- src/useChat.ts：聊天运行状态与角色操作
- src/ContactsSidebar.tsx：桌面/手机共用联系人侧栏与添加、删除确认
- src/CharacterSettings.tsx：当前人物卡编辑与导出
- src/styles.css：Tailwind 引入与主题、响应式样式
- public/：头像及 PWA 图标
- docs/：需求、设计、架构、阶段计划和决策

## 后续部署（未执行）
计划前端 Cloudflare Pages、后端 Workers、数据 D1。正式上线前需明确身份验证、访问边界、数据导出/删除及模型预算。已实现本机 Workers /api/chat 与后端模型适配；D1、生产认证和云部署尚未实现。
默认 Mock 无 API 费用；Real 每次实际模型请求可能产生用量费用，只有用户配置后显式启用。

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
回归脚本自行启动本机预览，结束时关闭测试服务。pnpm test:storage:e2e 覆盖 IndexedDB 迁移、完整备份和恢复；pnpm test:timing:e2e、pnpm test:scheduler:e2e、pnpm test:ownership:e2e 覆盖请求时间、调度和多页面所有权；pnpm test:e2e 覆盖桌面与手机交互。浏览器截图输出到 test-results/。这些测试不等同于 Android 实机验收。

pnpm test:storage-recovery:e2e 使用独立浏览器数据、真实 IndexedDB 事务中止/延迟和拦截的假模型响应，覆盖读取失败写入保护、失败重试、草稿保护、恢复互斥、历史队列暂停、快照取回及恢复期间所有权交接，不启动 Worker 或访问外部模型。


联系人删除会清除该人物卡、专属会话和消息；旧 localStorage 迁移来源保留。最后一名删除后保持空状态，刷新不自动恢复默认联系人；仍可从侧栏添加。
浏览器回归包含桌面/手机联系人切换、添加、删除确认/取消、当前和最后一名删除、空快照刷新及重新添加。

## 自然聊天设置
聊天设置提供“回复等待时间”（默认 5 秒，1–60 秒、滑条步长 1 秒）、“最大等待时间”（默认 5 分钟，1–10 分钟、步长 0.5 分钟，或“不限”）与“正在输入时延后回复”（默认关闭）。已有的半秒设置仍可恢复，重新调节后按整秒保存。从最后一条已发送消息起计时，连续发送会重置计时；开启输入延后后，最近一次输入活动也需经过所设等待时间。有限最大等待时间从本轮第一条已发送消息起计算；“不限”只取消这一上限。请求真正开始前发送的新消息仍合并到当前轮；请求开始后及逐条显示期间的新消息进入下一轮。输入延后关闭时草稿不改变倒计时；草稿不会上传。

刷新后恢复收集队列与剩余气泡；中断的生成不会自动重试，点击“重试回复”才重新提交。模式切换提示可点击 X 忽略目标会话的待回复任务：消息留在本地记录中并显示红色感叹号，后续模型上下文不包含这些消息；已生成但未显示的回复继续显示。生成状态的 IndexedDB 事务提交前不会发起模型请求，保存失败会暂停回复并保留未提交的草稿。切换联系人不取消原会话；清空/删除只取消目标会话。取消连接不能保证已开始的模型请求不计费。Mock/Real 共用历史。

## 启用本机 Real 模式（用户自行配置）
1. 先停止占用 5173/8787 的本地开发服务。
2. 将 worker/.dev.vars.example 复制为 worker/.dev.vars，仅在本地编辑：填写 OPENAI_API_KEY 和账号可用、支持 Responses 与 Structured Outputs 的 OPENAI_MODEL。不要把密钥发到聊天中、填进人物卡或使用 VITE_ 前缀。该文件已被 Git 忽略；Vite 开发服务会拒绝访问 .dev.vars、.env 和常见密钥文件，并拒绝 public/ 内的同类文件。项目不会读取你的真实凭据用于自动测试。
3. 启动：

~~~powershell
cd D:\GCHYL\GAME\Leivra
powershell -ExecutionPolicy Bypass -File .\start-local.ps1 -Real
~~~

有系统 pnpm 时可使用 pnpm dev:real。打开 http://127.0.0.1:5173。Real 设置说明会明确标识 OpenAI 和用量费用；缺少配置时显示明确错误。普通 start-local.ps1、pnpm dev、生产预览继续使用 Mock。修改后端配置需重启。

本阶段真实模式只绑定本机，尚未加入账号认证，不能直接向公网或局域网暴露。Android 布局可用 Mock 验收；手机真实模型访问要等后续身份验证和安全部署阶段。

### 真实调用验收（尚未执行）
配置完成且接受用量费用后，由你亲自在 Real 页面连续发送三条短消息，观察它们作为一组得到回复；等回复结束再发送一条依赖上文的问题，检查多轮上下文。也可切换其他联系人验证独立历史。请先使用不敏感的测试内容；普通测试命令不会自动运行这些步骤。

### 自动化验证（不产生模型费用）
~~~powershell
pnpm typecheck
pnpm test
pnpm build
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\work\browsers"
pnpm test:e2e
pnpm test:scheduler:e2e
pnpm test:timing:e2e
~~~

项目尚未配置 ESLint，因此没有 lint 命令。专项测试启动强制空配置的本地 Worker；假回复通过浏览器拦截提供，不会读取真实密钥，也不能调用 OpenAI。计时专项测试用浏览器伪时钟记录实际 `/api/chat` 请求时点。Windows 沙箱可能阻止 Wrangler 写入用户配置目录，需要允许本地测试运行时访问该目录。

结构化输出参考 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/structured-outputs)；本地后端变量参考 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/local-development/environment-variables/)。


## Persona Engine 第一阶段

人物卡导入支持 Leivra v1 与 Character Card V2 JSON，使用原有联系人入口，不新增页面。V2 的世界书、暂不支持字段和未知扩展保留于源卡；仅允许的人格资料参与请求。system_prompt 与 post_history_instructions 保留但不执行。数据往返保持 JSON 值，详见 docs/CHARACTER_CARDS.md。

默认蕾芙菈文本精确迁移到 JSON，不覆盖浏览器中已保存的人物卡。共享 PersonaRenderer 是唯一人格渲染实现，前端只提交角色快照，Worker 独立校验并构建最终请求；不新增记忆、情绪、主动消息或思考模式控制。

补充回归：`pnpm test:persona:e2e`（先设置 PLAYWRIGHT_BROWSERS_PATH，同上）。该脚本只使用本机前端和拦截假回复。固定的六类人格对照场景、离线验证范围及待授权的 Real 验收见 docs/PERSONA_ACCEPTANCE.md。
