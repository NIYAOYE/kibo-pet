# src/main/tools — 工具(底层原子能力)

Agent 可调用的**原子能力**,每个工具有明确的输入/输出 schema。工具系统支持注册多个,**MVP 只实现 1 个:`web_search`(联网搜索)**。

工具 vs skill:工具是底层原子能力;[skills/](../skills/) 是"组合工具 + 提示词"的高层能力包。

## 交互
- ← [agent/](../agent/):agent 循环按模型决策调用工具,拿回结构化结果。
- → 外部:`web_search` 走网络(需联网);未来的工具可能触达文件系统/OS(桌面自动化,Phase 未来)。
- → [providers/](../providers/):部分工具可能间接用到 LLM(一般不直接,交由 agent 编排)。
