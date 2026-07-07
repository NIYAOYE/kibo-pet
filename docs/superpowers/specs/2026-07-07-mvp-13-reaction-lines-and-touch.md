# MVP-13 台词引擎 + 点击反应 — 设计文档

> 2026-07-07 与用户 brainstorming 定下。承接 PROGRESS.md §6"更远期"里的**情绪/事件驱动行为、口癖台词触发**，以及 ROADMAP 之外的"桌宠创造物层"。这是"让宠物作为一只生物活起来"系列的**第一个 MVP（脊柱）**，后续"懂我在干嘛（情境感知）"与"听得到声音（配音）"各自单独成 MVP。

## 1. 背景与问题

当前"互动"的现状：**Agent 大脑成熟**（工具/记忆/搜索/天气/firecrawl/提醒），但**宠物作为生物的一面很薄**：

- `lines.json`（露露卡完整口癖库：greet/wake/idle/long_idle/click/drag，含 voice 槽位与人设）**已写好但没接任何地方** —— `src/main/lines/`、`src/renderer/voice/` 只有 README 桩。宠物**从不自主说话**。
- `src/renderer/main.ts` **没有点击/双击反应** —— 单击只是开对话框，宠物对触碰无反馈。
- `src/shared/petBrain.ts` 用纯随机 idle/walk/sleep 驱动，**无情绪、无情境反应**。

结论：宠物现在本质是"一个沉默精灵 + 一个聊天框"。本 MVP 让它变成**会自己冒话、能对触碰有反馈的生物**。

## 2. 目标与非目标

**目标（本 MVP）**
- 激活 `lines.json`：宠物按状态/时间自主在气泡里冒口癖台词（idle/long_idle/wake）。
- 触碰反馈：双击=戳（`click` 台词 + 快速反应动画）、拖起=`drag` 台词。
- 一套"不烦人"护栏：全局冷却、暂停抑制、不复读。
- 纯本地、零外部依赖、零新权限、低风险。

**非目标（留给后续 MVP，YAGNI）**
- ❌ 配音播放（读 `audio` 字段但不播 —— 下一个 MVP"听得到声音"）。
- ❌ 情境感知（时间/专注时长/窗口焦点驱动 —— 下一个 MVP"懂我在干嘛"）。
- ❌ 情绪/养成数值系统（本 MVP 不引入 mood 变量；台词选择只按 category + rng）。
- ❌ 改动单击=开对话框的主交互。

## 3. 架构（Approach A：独立纯 planner + 主进程供词）

四个边界清晰的单元：

| 单元 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `reactionPlanner` | `src/shared`（纯函数，可测） | 输入触发事件 + dt + rng + 冷却配置 → 决定**是否说话、说哪一类（category）**；不含文本、不做 I/O | 无 |
| `linesLoader` | `src/main`（仿 `personaLoader`） | 读宠物包 `lines.json` → 解析成 `{category: {text,audio?}[]}` → `pickLine(category, avoidLast)` | 宠物包路径 |
| 手势层 | `src/renderer/main.ts` + `petController.ts` | 采集触点（双击/拖拽）+ 状态派生触发 → 喂 planner；planner 决定说话时通知主进程 | `isPetPixel` 命中测试 |
| 气泡瞬态模式 | `src/main/shell/bubbleWindow.ts` + `src/renderer/bubble.ts` | 复用跟随气泡窗，新增 `pushLine(text, ttl)`：定格纯文本 + N 秒后自动隐藏 | 现有气泡窗 |

**数据流**：`petController.tick()` → `reactionPlanner.step()` → 若 `{speak: category}` → `window.petApi.petSpeak(category)` → 主进程 `linesLoader.pickLine` → `bubbleController.pushLine(text)` → 瞬态气泡自动隐藏。

设计理由：planner 独立于 `petBrain`（不折进去），是因为"运动"与"说话节奏/冷却"生命周期不同、混在一起会让 reducer 职责发散。planner 输出 **category 而非文本**，文本留在宠物包，换皮肤即换台词。

## 4. reactionPlanner 细节（纯函数）

**输入**（每 tick）：`{ dtMs, trigger?: ReactionTrigger, paused: boolean, rng: () => number }`

**触发分两类**
- **事件触发**（立即反应）：`poke`（双击）、`drag`（拖起）、`wake`（睡→醒）
- **环境定时**（自己冒话）：`idle` 闲聊（均值间隔 ~60s，带抖动）、`long_idle`（长时间无交互）

**内部状态**：全局冷却剩余时间、上次 category、闲聊定时器、long_idle 累计。

**三条不烦人护栏**（全在 planner 内、可单测）
1. **全局冷却**：任意两句自主台词间至少 ~25s；事件触发受一个更短冷却（避免连点刷屏）。
2. **暂停抑制**：`paused=true`（对话框打开）或回复流式中，planner 不冒话（主进程再兜一道）。
3. **不复读**：同一句不连续出现 —— 具体避重在 `pickLine(category, avoidLast)` 里做（planner 只管 category）。

**输出**：`{ speak?: ReactionCategory }`。

**冷却/间隔配置**（默认值，集中在一个 config 常量，便于调）
- 全局冷却 `globalCooldownMs = 25000`
- 事件触发冷却 `eventCooldownMs`（较短，如 4000）
- 闲聊均值间隔 `idleChatterMeanMs ≈ 60000`（带 rng 抖动）
- `long_idle` 阈值：复用/参考 petBrain 的 idle 语义

## 5. 手势映射（UX 决定，已与用户确认）

| 手势 | 现状 | MVP 后 |
|---|---|---|
| 单击 | 开/关对话框 | **不变**（主交互不动） |
| 双击 | 无 | **戳一下** → `click` 台词 + 快速反应动画 |
| 拖起/放下 | pickup/drop 事件已存在 | 拖起时冒 `drag` 台词 |
| 自主 idle/长闲/睡醒 | 无 | 对应 `idle`/`long_idle`/`wake` 台词 |

选双击而非单击做"戳"，是为不破坏"单击=开聊"的既有主交互（开聊另有全局热键入口）。双击检测在 `main.ts` 里基于两次 mouseup 的时间窗 + 均落在 `isPetPixel` 命中区实现，避免误触透明区。

## 6. 瞬态气泡 & 抑制

气泡窗当前只服务聊天回复（`pushStream/pushDone/...`）。新增：
- `bubbleController.pushLine(text, ttlMs≈3500)`：清空 → 定格纯文本（**非流式、非 Markdown 富渲染**，就是一句口癖）→ 定时 `hide()`。
- **防竞态 token**：若自动隐藏定时器等待期间聊天回复开始（`pushStream` 到达），取消该定时器、让位给回复。
- **主进程抑制兜底**：主进程持有"聊天是否活跃"状态；`petSpeak` 到达时若聊天活跃则**直接丢弃**（planner 的 paused 抑制之外的第二道）。
- **优雅降级**：`lines.json` 缺失或某 category 为空 → `pickLine` 返回 `null` → 不冒泡、不报错。
- `bubble.ts` 渲染层新增 `onLine` 处理器：渲染纯文本一句（复用现有气泡样式/尾巴定位）。

## 7. IPC 契约（四文件同步）

新增单向通道 `PET_SPEAK`（renderer→main）：
1. `src/shared/ipc.ts`：`IPC.PET_SPEAK` 常量 + `PetApi.petSpeak(category: ReactionCategory)` 类型。
2. `src/main/...`（shell 注册）：`ipcMain.on(PET_SPEAK)` 处理器 —— 经现有 `ipcValidation` 校验 payload（category 为受限字符串集合）→ 聊天活跃则丢弃 → 否则 `linesLoader.pickLine` → `bubbleController.pushLine`。
3. `src/preload/index.ts`：`petApi.petSpeak` 暴露。
4. `src/renderer/petController.ts`：planner 出 `speak` 时调用。

`ReactionCategory` 类型 `'idle'|'long_idle'|'wake'|'click'|'drag'` 放 `src/shared`，主/渲染共用。注：`lines.json` 里还有 `greet` 类别，但本 MVP 无触发源会用到它（开对话框即 `paused`，气泡让位给聊天），故 `greet` 暂不进 `ReactionCategory`，保留在宠物包里给后续 MVP。

## 8. 测试策略

- `reactionPlanner`（Vitest 纯函数）：冷却生效、事件触发、环境定时到点触发、`paused` 抑制、不复读的 category 交替。**用推进注入时钟写判别性测试**（呼应记忆 [[scheduler-frozen-clock-test-blindspot]]：冻结时钟测不出"刚到点即触发"，需在 arm 与 fire 间推进注入时钟）。
- `linesLoader`（仿 `personaLoader.test.ts`）：正常解析、文件缺失退化空、坏 JSON 跳过、`pickLine` 避重与空 category 返回 null。
- 手势层 + 气泡瞬态 + 双击检测：**GUI 真机 `pnpm dev`/`pnpm preview` 肉眼验收**（项目既定约定，无 Electron GUI 自动化驱动）。验收清单：双击冒 click 台词、拖起冒 drag 台词、静置后自主冒 idle/long_idle、单击仍正常开对话框、对话框开着时不冒话、连点不刷屏、`lines.json` 缺失不崩。

## 9. 风险与遗留

- **风险**：冷却/间隔手感需真机调 —— 数值集中在 config 常量，便于迭代。
- **风险**：双击与单击的时间窗判定在不同机器/DPI 上的手感 —— 真机验收确认阈值。
- **遗留/后续**：`audio` 字段本 MVP 读而不播（下个 MVP 配音接上）；情境感知触发源（时间/焦点）在"懂我在干嘛"MVP 补入 planner 的 trigger 源；情绪数值系统按需再议。
- **注意**：`pets/luluka`（含 `lines.json`）被 `.gitignore`，仅在磁盘 —— 若给 `lines.json` 补新 category，需在 main 的磁盘副本上应用（承接项目既有 persona.md 同款约定）。

## 10. 涉及文件清单

**新增**
- `src/shared/reactionPlanner.ts` + `reactionPlanner.test.ts`
- `src/main/lines/linesLoader.ts` + `linesLoader.test.ts`

**修改**
- `src/shared/ipc.ts`（`PET_SPEAK` 常量 + 类型 + `ReactionCategory`）
- `src/main/shell/bubbleWindow.ts`（`pushLine` + 防竞态 token）
- `src/main/shell/index.ts`（`PET_SPEAK` 处理器 + 聊天活跃抑制接线）
- `src/preload/index.ts`（`petApi.petSpeak`）
- `src/renderer/petController.ts`（驱动 planner + 状态派生触发）
- `src/renderer/main.ts`（双击/拖拽手势 → 触发）
- `src/renderer/bubble.ts` + `bubble.html`（`onLine` 瞬态渲染）
