# src/main/agent — Agent 循环(编排中枢)

内核的心脏。实现完整的 agent 循环:**理解意图 → 决定是否调工具 → 调用工具 → 整合结果 → 生成回复**,支持多轮工具调用(结果回灌后再决策)。

本模块**不自己实现能力**,而是编排其他模块。

## 交互
- → [providers/](../providers/):调用 LLM 生成 completion / 决策。
- → [tools/](../tools/):按模型决策调用注册的工具(如 web_search)。
- → [skills/](../skills/):把已加载 skill 的说明注入决策,按需激活某个 skill。
- → [persona/](../persona/):在每轮开始时取组装好的 system prompt(人设 + 记忆)。
- → [memory/](../memory/):读取召回的记忆;回合结束后写入新的长期记忆/更新工作记忆摘要。
- ← [ipc/](../ipc/):接收用户输入;流式把回复 token / 状态(thinking/talk)推给渲染层。
- → [lines/](../lines/):非对话类事件(打招呼、任务完成)可交给台词库而非自己生成。
