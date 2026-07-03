# Pet-Agent · 桌面宠物 Agent

Shimeji 风格的桌面宠物(Electron + TypeScript),内置自研 agent 内核:可插拔 LLM Provider、Markdown 技能、分层记忆。

## 快速开始

```bash
pnpm install
pnpm dev          # 开发模式
pnpm build && pnpm preview   # 构建后预览
```

首次启动会弹出设置窗:选择 Provider(Claude / OpenAI 兼容端点)、填入 API Key 即可对话。

## 记忆与隐私(重要)

宠物拥有分层记忆,数据存在用户目录的 `memory/` 文件夹(设置窗有「打开记忆文件夹」按钮):

- `facts.json` —— 宠物记住的关于你的事实(唯一权威源,人类可读,可手动编辑/删除)
- `vector-index.json` —— 由事实生成的向量索引,可随时删除,会自动重建
- `summary.json` / `transcript.json` —— 对话摘要与最近对话历史

**Embedding 隐私告知**:如果你在设置的「记忆」小节配置了 embedding 端点,被记住的事实文本会发送到该端点做向量化(用于按话题召回)。**留空即完全本地**(按最近记忆召回),功能照常可用。对话本身始终会发送给你配置的聊天 Provider。

备份/迁移:整个 `memory/` 目录直接拷走即可;卸载应用不会删除它。
