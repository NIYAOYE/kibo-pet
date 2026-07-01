# skills/web-summary — 内置示例 skill(MVP)

MVP 内置的 1 个简单 skill,用来**验证 skill 机制跑通**。

## 能力
"网页/话题总结":触发后调用 [web_search](../../src/main/tools/) 工具取信息,再由 LLM 总结成简洁结论。

## 计划文件
- `SKILL.md` —— 能力说明 / 触发条件 / 用法(由 [skills 加载器](../../src/main/skills/) 解析)。

## 交互
- ← [src/main/skills](../../src/main/skills/):被加载注册。
- → [src/main/tools](../../src/main/tools/):调用 `web_search`。
- → [src/main/providers](../../src/main/providers/):经 agent 用 LLM 做总结。
