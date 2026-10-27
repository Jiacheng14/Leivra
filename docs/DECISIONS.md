# 产品与技术决策
日期：2026-10-26（用户时区）

## 已确定
1. 项目名 Leivra（蕾芙菈），目录按用户指定 D:\GCHYL\GAME\Leivra，包名 leivra。
2. 第一阶段仅本地原型，不部署、不调用真实模型、不实现记忆/推送/语音。
3. React + TypeScript + Vite + Tailwind v4 + vite-plugin-pwa；使用 pnpm 锁定依赖。
4. 本机有 Codex 自带 Node/pnpm、无系统 npm。提供启动脚本，依赖布局使用 hoisted 兼容 Windows，pnpm 配置保存在 pnpm-workspace.yaml。
5. 私人陪伴聊天风格：自然短消息、温柔成熟且有主见，不使用小说旁白。
6. localStorage 仅为原型临时存储，最多 500 条、单条 2000 字符，未加密。明确提示限制，提供导出与确认清空。
7. 默认原创 SVG 头像，可替换配置；不引入外部素材与付费服务。
8. PWA 生产模式缓存应用壳，更新须用户点击刷新，避免输入时自动刷新。

## 计划中
Cloudflare Pages + Workers + D1；后端模型适配层；身份验证与云端数据操作。上线前再次确认费用与部署授权。

## 待讨论
模型、成本上限、身份认证、记忆策略、主动消息边界、通知权限、语音供应商和角色上传体验。