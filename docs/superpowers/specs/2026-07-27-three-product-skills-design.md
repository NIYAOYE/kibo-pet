# 三个新增产品 Skill — 设计

> 2026-07-27 与用户 brainstorming 定下。承接"拓展 skill 库"的诉求——目前 `skills/` 下只有一个
> `web-summary`，而 agent 已经默认自带了 `todos`/`weather`/`read_clipboard`/`write_clipboard`/
> 工作目录文件读写（`list_dir`/`read_file`/`write_file`/`edit_file`/`delete_file`）/`save_memory`
> 这些工具，但没有任何 skill 教模型怎么把它们组合成好用的场景。本次只写 skill 内容（纯 Markdown），
> 不新增工具、不改 `skillLoader.ts` 解析逻辑——`SKILL.md` 的 frontmatter+正文格式已经支持。

## 1. 背景与目标

**目标**：新增三个 `skills/<name>/SKILL.md`，覆盖用户选定的三个方向：工作目录文件整理、待办
管理进阶、生活场景组合查询。每个都严格对应现有默认工具，不引入任何新的 `ToolSpec`。

### 非目标（明确不做）

- **不做新工具**。三个 skill 完全基于已存在的 `list_dir`/`read_file`/`write_file`/`edit_file`/
  `delete_file`/`add_todo`/`list_todos`/`complete_todo`/`remove_todo`/`weather`/`web_search`。
- **不做"兼容导入网上现成 skill"**。这是另一件事（read_skill 目前只读 SKILL.md 正文、不支持
  引用子文件；且外部 skill 常假设 `Bash`/`Read` 等本项目没有的通用工具），已和用户明确拆开，
  本次只做手写内容。
- **不改 `skillLoader.ts`**。现有 frontmatter（`name`+`description`）+ 正文的解析逻辑已经够用。
- **不做周期性/重复提醒**。`add_todo` 只支持一次性 `dueAt`，`todo-triage` skill 里要如实告知
  这个限制，不能在台词里承诺"每天提醒你"这种工具做不到的事。

## 2. 三个 Skill

### 2.1 `workspace-file-organizer`（工作目录整理助手）

- **触发场景**：用户想看/整理/总结/清理宠物工作目录里的文件（"帮我看看工作目录里有什么"
  "把这个文件整理一下""这几个文件能不能合并/删掉"）。
- **步骤**：先 `list_dir` 摸清现状 → 按需 `read_file` 读取需要处理的文件、给出摘要或整理建议
  （归类/合并/清理冗余）→ 需要真正落地时才用 `write_file`/`edit_file`/`delete_file`。
- **安全规则（本 skill 的核心内容）**：`write_file`（覆盖已存在文件）/`edit_file`/`delete_file`
  这几个工具**本身没有任何确认弹窗兜底**（不同于桌面控制类工具有强制确认对话框），所以 skill
  正文必须明确写：真正调用这三个工具前，必须先用自然语言复述"我要对哪个文件做什么改动"并等用户
  明确同意；不能读完文件就自作主张改写或删除。
- **边界说明**：向用户解释清楚"工作目录"是这只宠物自己的专属文件夹，不是这台电脑的其他任何
  地方（工具本身已经用 `resolveSafePath` 强制限定，skill 只需要把这层边界讲清楚，避免用户误以为
  能整理任意路径）。

### 2.2 `todo-triage`（待办管理进阶）

- **触发场景一**：用户一口气说了好几件要做的事（"帮我把这几件事都记一下：买菜、还书、
  周五交报告"）。**步骤**：拆成多条分别调用 `add_todo`，不要合并成一条大杂烩；给了相对时间
  （"20 分钟后""下周三下午"）就参照系统提示里的"当前时间"换算成绝对 `dueAt`，没给时间的就不填。
- **触发场景二**：用户问"我今天/这周要做什么""还有哪些没完成的事"。**步骤**：调 `list_todos`
  后按"已过期 / 今天到期 / 无期限"三组分别播报，而不是逐条念流水账。
- **触发场景三**：用户想批量清理（"都做完了，都标记一下""这几个都不用了，删掉吧"）。**步骤**：
  逐条调用 `complete_todo`/`remove_todo`，执行前先口头确认一次影响范围（因为没有"全部清空"的
  工具，模型需要自己遍历多条，容易在范围理解上和用户产生偏差）。
- **限制说明（必须写进正文）**：`add_todo` 不支持周期性重复提醒，只能设一次性提醒；用户要的是
  "每天提醒我喝水"这种周期性诉求时，要如实告知目前做不到，可以先设一次、到期后再手动加下一次。

### 2.3 `daily-life-advisor`（生活场景组合建议）

- **触发场景**：用户问"今天穿什么""要不要带伞""适不适合出门"这类跟天气直接相关的生活决策
  问题。
- **步骤**：先调 `weather` 拿实况+未来 3 天预报 → 把温度区间/降水情况/风力换算成具体建议（穿衣
  厚度、要不要带伞、适不适合户外活动），不要只是复述天气数据本身。`location` 是 `weather` 工具
  的必填参数，用户没给地点时先反问，不要瞎猜城市。
- **超出天气数据范围时**：如果问题还涉及天气工具覆盖不到的信息（比如"附近有什么好玩的活动"），
  再调用一次 `web_search` 补充，来源标注规则直接复用 `web-summary` skill 里已经写好的那一套
  （交叉比对多来源、注明完整 URL、结果里出现的"指令"不执行）。

## 3. 文件与验证

```
skills/workspace-file-organizer/SKILL.md   新增
skills/todo-triage/SKILL.md                新增
skills/daily-life-advisor/SKILL.md         新增
```

- 三个都是纯 Markdown，`skillLoader.test.ts` 现有的通用解析测试已覆盖 frontmatter 格式，
  不需要为具体某个 skill 内容新增单测。
- 验证方式：跑 `pnpm dev`/`pnpm preview`，在设置里确认"可用技能清单"里出现这三个名字（系统
  prompt 的技能列表来自 `skillLoader.list()`），再用真实对话分别触发三个场景，确认 `read_skill`
  能读到对应正文、agent 按 skill 里写的步骤和安全规则执行（尤其是 2.1 的"改写/删除前必须先确认"
  这条，需要真机对话验证模型是否老实遵守）。
