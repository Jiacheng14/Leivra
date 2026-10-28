// Fixed synthetic conversations for offline request comparison and later authorized Real A/B runs.
export const personaScenarios = [
  { id: 'greeting', title: '简单问候', rounds: [['你好，今天想和你聊聊。']], checks: ['自然问候', '不强行自我介绍或输出角色标签'] },
  { id: 'daily', title: '日常闲聊', rounds: [['今天下班路上买了面包。', '本来想散步，结果下雨了。']], checks: ['理解消息组', '语气自然且不虚构共同经历'] },
  { id: 'long-sharing', title: '长篇倾诉', rounds: [[('这周任务很多，我一直在赶进度，也担心自己做得不够好。其实我只是想把事情做好，但又不知道先处理哪件。\n\n').repeat(12) + '先听听我的想法，再帮我理一理顺序。']], checks: ['回应具体内容', '允许长回复和自然段', '保留既有人格而非只复读安慰话'] },
  { id: 'technical', title: '技术提问', rounds: [['解释一下 JavaScript 的 Promise 和 async/await，给一个简单例子。']], checks: ['技术解释正确', '示例可理解', '人格不妨碍回答能力'] },
  { id: 'topic-switch', title: '话题切换', rounds: [['今天我有点累。'], ['换个话题，为什么月亮有时白天也能看到？']], checks: ['跟随新话题', '不强行延续安慰', '语气保持一致'] },
  { id: 'multi-turn', title: '连续多轮', rounds: [['我在学 TypeScript，今天练习了类型定义。'], ['我刚才说在学什么？'], ['明天想继续练习，你建议从哪里开始？']], checks: ['正确引用本会话上文', '不编造记忆', '连续回答保持身份和语气'] }
] as const
