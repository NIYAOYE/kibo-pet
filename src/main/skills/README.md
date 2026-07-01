# src/main/skills — Skill 加载器 + 注册表

借鉴 OpenClaw:每个 skill 是一个目录 + 一份 `SKILL.md`(能力说明/触发/用法)。本模块在启动时**扫描 skill 目录、解析并注册**所有 skill,供 agent 使用。

> 注意:这里是**加载器代码**;实际的 skill 包放在项目根的 [`skills/`](../../../skills/) 目录(如 `skills/web-summary/`)。二者不要混淆。

## 交互
- → 项目根 `skills/*/SKILL.md`:扫描并解析。
- → [agent/](../agent/):把已加载 skill 的说明提供给 agent 决策;按需激活。
- → [tools/](../tools/):skill 在执行时会组合调用底层工具。
