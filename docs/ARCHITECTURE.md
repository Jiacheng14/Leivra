# 技术架构

## 已实现
纯前端 React + TypeScript + Vite；Tailwind v4 使用官方 Vite 插件，结合 CSS 变量定义主题。
App -> ChatProvider.reply(messages, AbortSignal) -> mockProvider。
App -> storage -> localStorage（leivra.prototype.messages.v1）。
角色头像和姓名由 src/chat.ts 配置。UI 不持有模型密钥。所有素材随站点本地加载，无第三方字体或追踪。

消息为 id、role、text、createdAt。最近 500 条截断策略作用于内存和持久化；单条 2000 字符。
存储读取进行结构校验；损坏时进入临时会话并避免覆盖原记录。用户清空后恢复存储。写入失败会提示。
请求可取消，清空和卸载取消挂起回复。PWA 只缓存静态应用壳，/api 路径不做导航回退，无 API 运行时缓存。

## 计划中
浏览器 -> Workers /api/chat -> 可切换模型适配器；Workers -> D1。
后端验证身份、请求体、限流、模型额度和数据归属。任何真实 Key 只存在后端环境变量，禁止 VITE_*。
长期记忆、推送和语音分别独立模块。Cloudflare 正式配置尚未创建。

## 待讨论与边界
真实消息协议/流式方案、登录方式和数据库 schema 将在下一阶段确认。当前 ChatProvider 仅定义非流式多文本返回契约，不声称已完成网络适配。
无跨标签页同步、跨设备同步或本地加密。正式上线前须完成威胁模型、身份隔离、数据导出/删除验证。