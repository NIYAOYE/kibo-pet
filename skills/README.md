# skills — 运行时产品 skill 包(非开发工具)

宠物"大脑"的高层能力包,由 [src/main/skills](../src/main/skills/) 的加载器在启动时扫描加载。每个 skill 是一个目录 + 一份 `SKILL.md`(能力说明 / 触发 / 用法),可组合调用底层 [工具](../src/main/tools/)。

> 区分:
> - **本目录 `skills/`** = 运行时产品能力(宠物用)。
> - **`tools/hatch-desktop-pet/`** = 开发期的美术资产生成工具(给开发者/agent 用),两者无关。

## 现有
- [web-summary/](web-summary/) — MVP 内置 skill,验证机制跑通(联网搜索 + LLM 总结)。

## 交互
- ← [src/main/skills](../src/main/skills/):被扫描/解析/注册。
- → [src/main/tools](../src/main/tools/):执行时组合调用工具(如 web_search)。
