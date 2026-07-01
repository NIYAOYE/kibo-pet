# src/main/persona — 人设加载 + System Prompt 组装

加载当前宠物包内的 `persona.md`(分块结构:Persona / Voice / Behavior / Tools),并在每次对话开始时**组装 system prompt**。

## System Prompt 组装顺序
```
[人设各分块] + [召回的长期记忆/用户事实] + [工作记忆摘要] + [当前对话窗口]
```

## 交互
- → 当前宠物包 `pets/<id>/persona.md`:读取人设(跟随宠物包,换皮即换性格)。
- ← [memory/](../memory/):取召回的长期记忆与工作记忆摘要拼接。
- → [agent/](../agent/):把组装好的 system prompt 提供给 agent 循环。
