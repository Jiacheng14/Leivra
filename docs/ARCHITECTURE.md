# 技术架构

更新：2026-10-27

## 模块边界
React + TypeScript + Vite + Tailwind + PWA 保持不变。新增最小 Workers 本地后端，开发依赖仅增加 Wrangler；OpenAI 使用原生 fetch，不引入 SDK 或其他供应商。

| 模块 | 职责 |
|---|---|
| src/models.ts、characters/ | 人物卡、稳定角色/会话/消息 ID；原生 v1 格式和蕾芙菈人格保持不变 |
| src/scheduling/MessageScheduler.ts | 每会话独立状态机、收集计时、请求排队、取消、手动重试、逐条派发 |
| src/scheduling/ConversationManager.ts | 管理会话调度器，按角色读取上下文，原子提交消息和调度快照 |
| src/scheduling/settings.ts、persistence.ts | 设置范围、调度快照校验和兼容读取 |
| src/prompt.ts | 唯一通用协议与 Prompt Builder；组装人格及当前消息组 |
| src/reply.ts | 共用输出校验、独立可测试的气泡延迟函数 |
| src/chat.ts、providers/ | Mock 与 Real ModelProvider；区别仅在生成来源 |
| src/apiContract.ts | 前后端公共请求校验和安全错误码 |
| worker/index.ts、http.ts | 本机访问边界、请求大小/并发/频率/超时限制、安全 JSON 响应 |
| worker/openai.ts | 后端重建提示词，调用 Responses API，解析结构化输出，不输出密钥或聊天日志 |
| src/storage.ts、useChat.ts | 浏览器数据持久化、生命周期和现有角色操作 |

## 会话调度
每会话各有一个调度器，状态为 Idle → Collecting → Generating → Dispatching → Idle/Collecting。默认从最后一条已发送消息开始等待 3500ms；新消息重置计时。设置允许 1000–15000ms、步长 500ms。

“正在输入时延后回复”默认关闭。开启后只记录内存中的输入活动时间，以最近输入后 1500ms 为参考，最多延长到正常截止时间之后 10000ms；草稿从不进入请求或持久化。浏览器后台计时器可能被系统节流，调度不承诺后台精确送达。

生成/派发期间的新消息进下一轮队列，不取消当前请求；同会话最多一个生成请求。当前回复全部显示后，根据下一组最后发送时间继续计时，已过截止时间则立即进入下一轮。其他角色独立推进，切换联系人只切换视图并清空草稿。清空/删除只取消目标会话的计时器和请求。

待处理组最多 100 条、64000 个 UTF-16 字符，超出时明确拒绝新发送，保留输入草稿；此上限用于异常积压保护。单条用户输入仍为 2000 字符。

## 回复派发与恢复
模型返回 `{ "messages": ["文本"] }`，前后端均验证：非空数组、非空字符串、无多余字段。异常安全上限为 32 条、单条 32000 字符、合计 64000 字符；不作为模型的目标长度/条数，不按标点拆分、不截断有效消息、不去掉自然段或首尾空白。旧卡 preferences.maxReplyMessages 保留读写兼容，但不控制运行时条数；temperature 暂不发送，避免不同模型参数兼容问题。

第一条在完成生成后立即提交；后续按即将显示的消息计算 `1000 * min(4, 1 + sqrt(Unicode字符数 / 50))` 毫秒。无逐字动画。

同一 localStorage 快照保存已显示消息和 active.nextIndex；气泡 ID 为轮次 ID 加索引，重复写入被去重。刷新后：
- Collecting 恢复未发送消息和截止时间。
- Dispatching 继续未显示的已生成消息，不重新调用模型；当前剩余气泡延迟重新计时。
- Generating 转为明确中断错误，只能手动重试；不自动重放可能已计费的请求。
- 切换 Mock/Real 来源时，旧的待处理轮次需要手动确认重试；已生成的气泡仍可完成显示。

pagehide/卸载取消本页定时器和请求，pageshow 可重建管理器。中止连接不能保证供应商停止已开始的生成或免除费用。多标签页并发协调、后台可靠运行、跨设备同步不在本阶段内。

## 提示词顺序和上下文隔离
1. 通用聊天协议：唯一 system 段，自然即时聊天，无旁白、动作、角色名前缀或默认报告格式，不强制固定字数/条数。
2. 当前人物卡人格：独立 context 数据，不能设置 system 角色。
3. 用户明确授权共享的信息（当前运行流程为空）。
4. 当前角色专属记忆，按 ID/版本筛选（只有接口，当前为空）。
5. 当前会话近期历史：按角色和会话 ID 筛选、去重，最多 50 条且总长度不超过 64000 字符；不截断单条消息。
6. 当前已发送消息组：按顺序编码为带 id、text、createdAt 的数组，只注入一次。

下一轮尚待处理的消息不混入当前生成。前端提交已校验的 GenerationInput；后端再次检查 ID 归属、长度、版本及重复消息，然后使用同一个 Prompt Builder 重建协议，不接收客户端自定义 system/sections。Responses 将 context 映射为带种类的 user 数据，保留历史 user/assistant 边界，协议优先级最高。结构测试不能替代真实模型遵循测试。

## 本地后端边界
`pnpm dev:real` 启动本机 127.0.0.1:5173 的 Vite 和 127.0.0.1:8787 的 Workers，浏览器只请求同源 `/api/chat`。默认 `pnpm dev/build/preview` 均为 Mock。原型没有认证，真实模式暂不向局域网或公网开放。

后端要求 loopback Host、明确允许的 Origin、JSON 和 X-Leivra-Client 请求头，不开放 CORS。每运行时最多 2 个并发请求，每会话 1 个、每分钟 10 个生成请求，最近 5 分钟轮次 ID 拒绝重复。限制在内存中，重启会重置，不是生产配额/计费上限。

请求和上游 JSON 最多 1 MiB；上游生成超时 60 秒，前端总等待 65 秒；无自动重试。密钥/权限、余额配额、限流、配置、网络、超时、拒答和格式异常只返回受控错误码/说明，不透传上游错误文本。前端失败保留消息，显示“重试回复”，不静默切为 Mock。

仅后端读取 worker/.dev.vars 的 OPENAI_API_KEY、OPENAI_MODEL、可选 OPENAI_MAX_OUTPUT_TOKENS（默认 8192，异常保护范围 256–32768）。使用 Responses 的 text.format JSON Schema，store:false；不缓存 API 响应。store:false 不等于承诺供应商完全不保留数据。未配置真实凭据、未执行付费调用、未部署云服务。

## 本地数据与兼容
leivra.data.v1 仍为统一快照，原有 characters/conversations/messages/activeCharacterId 不变；新增可选 chatSettings、schedulerSnapshots。旧快照直接兼容，人物卡 schemaVersion 不变。消息、调度和会话均按稳定 ID 隔离，更名不改变历史关联。

每会话保留最近 500 条已显示消息，调度另保存未完成轮次。数据未加密；同步写入失败时提示当前仅临时可用。加载损坏/未知版本不覆盖原数据、不回退旧键；临时会话不允许修改原人物卡。

旧键 leivra.prototype.messages.v1 只在新快照缺失时迁移，默认角色清空/删除会清理旧备份。删除先验证并保存新的完整快照，再同步取消目标任务和提交 UI；事件循环不会在这组同步操作之间派发消息。空联系人集合合法，刷新不重建默认人物。联系人侧栏及人物卡编辑复用现有 UI。

## 验证与后续
Vitest 用假时钟和伪造 fetch 验证，不请求外部模型。浏览器专项测试使用强制空 bindings 的测试 Worker 验证真实本地运行时/代理，再拦截响应验证队列及长文；即使机器配置了密钥也不能触发付费请求。

后续生产部署仍需身份认证、分布式限制、私有云端数据和部署授权。D1、记忆提取、群聊、推送、语音没有实现。
