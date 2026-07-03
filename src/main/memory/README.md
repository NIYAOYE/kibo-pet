# src/main/memory — 分层记忆系统

给宠物"记性":管理短期(对话窗口/工作摘要)与长期(事实库/向量索引)记忆,纯本地存储,整个记忆目录**可被用户拷走**备份/迁移。**设计原则**:权威源是 `facts.json`(人类可读、可编辑),索引(`vector-index.json`)可随时删除、自动重建;双重保障一致性与容错性。

## 核心文件
- `facts.json` — 结构化事实库(用户画像/偏好/关键事件,唯一权威源)
- `vector-index.json` — 本地向量索引(可重建,删除无损)
- `summary.json` — 滚动对话摘要(防上下文爆炸)
- `transcript.json` — 最近对话历史(短期记忆窗口)

## 模块清单
- **factStore.ts** — 事实持久化与 CRUD(facts.json 读写 + 去重)
- **vectorIndex.ts** — 本地向量库(vector-index.json 管理 + 增量维护 + 容错重建)
- **transcriptStore.ts** — 对话历史窗口(transcript.json 读写 + 滚动截断)
- **workingSummary.ts** — 工作摘要(summary.json 生成/更新 + 防爆炸)
- **memoryManager.ts** — 模块编排(对外口合,每轮驱动 fact 追加/索引重建/摘要更新)

## 交互
- ← [agent/](../agent/):每轮结束写入新事实 / 更新摘要;每轮开始被召回。
- → [providers/](../providers/):调用 Embedding Provider 做向量化与召回。
- → [persona/](../persona/):把召回结果(facts + summary)交给 system prompt 组装。
- → 用户数据目录:落盘于可移植的 `memory/` 目录(卸载不删)。
