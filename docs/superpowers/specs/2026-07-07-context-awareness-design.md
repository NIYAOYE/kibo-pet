# 懂我在干嘛（情境感知）— 设计文档

> 2026-07-07 与用户 brainstorming 定下。承接 ROADMAP.md 轨道二"让它活起来"里的**懂我在干嘛（情境感知）**一项，是 MVP-13（台词引擎+点击反应）之后的第一个后续 MVP。"主动搭话/陪伴深化（性格 SOUL）"依赖本 MVP 的信号先落地，明确留给下一次独立 brainstorming，不在本次范围内。窗口/应用焦点检测（需要新原生依赖 + 应用名→台词映射配置，复杂度明显更高）同样明确拆出，留待后续单独一轮。

## 1. 背景与问题

MVP-13 让 `reactionPlanner` 有了"环境定时"（idle/long_idle）与"触碰事件"（poke/drag/wake）两类触发源，但触发源本质上只看"用户碰没碰宠物"，不看用户在电脑前的真实状态：

- `lines.json` 里 `greet`（4 句）、`farewell`（2 句）、`sleep`（2 句）三个分类写好后从未被任何触发源用过——`greet`/`farewell` 不在 `ReactionCategory` 类型里，`sleep` 在里面但没有触发路径产生它。
- 宠物自己的睡眠计时（`petBrain.idleAccumMs`，45 秒无交互）只看"有没有人碰宠物"，不知道用户是不是真的走开了，也不知道用户是不是一直在忙。
- 戳（双击）睡眠中的宠物目前是**完全静默**（`paused = ctx.paused || sleeping` 在检查触发前就拦截了一切），而拖起睡眠中的宠物会正常触发 `wake`——两种触碰手感不一致，MVP-13 验收时记录为待重新评估的已知行为。

本 MVP 把三类新信号接进来：真闲置离开（AFK）、久坐提醒、当天首次问候（早安/晚安），并顺手把睡眠戳的手感重新设计掉。

## 2. 目标与非目标

**目标（本 MVP）**
- **睡眠戳重设计**：戳睡眠中的宠物 → 说梦话（`sleep` 分类），不叫醒；拖起依旧正常叫醒（不变）。
- **当天首次问候**：当天第一次触碰宠物时，若落在早安/晚安时段窗口，插一句 `greet`/`farewell`，覆盖当次原本会出的 `click`/`drag`/`wake`/`sleep`；一天只触发一次。
- **AFK 离开**：用户真正离开电脑（OS 级闲置，非"没碰宠物"）达到阈值 → 说一句 `farewell`，不改变宠物当前状态（睡着的继续睡）。
- **久坐提醒**：用户持续操作电脑（无明显停顿）达到阈值 → 若宠物在睡则先叫醒，再说一句新增的 `break` 分类台词（睡眠惺忪的吐槽口吻）。
- 零新增运行时依赖（全部基于 Electron 内置 `powerMonitor` + 系统时钟）。

**非目标（留给后续，YAGNI）**
- ❌ 窗口/应用焦点检测（需要 `active-win` 类原生依赖或 PowerShell 前台窗口查询 + 应用名→台词映射配置，另开一轮 brainstorming）。
- ❌ 主动搭话/陪伴深化（"性格 SOUL"，依赖本 MVP 的信号，另开一轮）。
- ❌ 情绪/养成数值系统（本 MVP 依旧不引入 mood 变量，只按 category + rng 选词）。
- ❌ AFK 用户"回来"时的额外反应（离开只说一句，回来不做任何处理）。
- ❌ 阈值可配置的设置面板 UI（阈值是代码里的常量，跟现有 `DEFAULT_REACTION_CONFIG` 风格一致；真机验收时可临时改小常量走查）。

## 3. 架构

**核心难点**：真实 OS 闲置检测（`powerMonitor.getSystemIdleTime()`）只能在主进程调用，而 `reactionPlanner` 是跑在渲染进程的纯函数。需要一条新的主→渲染单向 IPC 通道把信号送过去——复用 MVP-13/MVP-10 已经建立的"主进程推送到渲染进程"模式（`IPC.PET_EVENT`/`IPC.BUBBLE_LINE`），不是新发明。

| 单元 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `idleWatcher` | `src/main/context/idleWatcher.ts`（纯函数核心 + 薄包装，仿 `weather.ts`/`firecrawlClient.ts` 的可注入 I/O 套路） | 每 30s 轮询 `powerMonitor.getSystemIdleTime()`，判定 AFK 离开 / 久坐提醒两个一次性边沿信号，通过新 IPC 推给渲染进程 | `powerMonitor`（Electron 内置，零新依赖） |
| `reactionPlanner`（扩展） | `src/shared/reactionPlanner.ts` | 优先级链新增：睡眠戳→`sleep`、当天首问候→`greet`/`farewell`、`afk_leave`→`farewell`、`break_reminder`→`break`（并可能要求叫醒） | 无新依赖 |
| `petController`（扩展） | `src/renderer/petController.ts` | 订阅新 IPC 信号，转成 `reactionPlanner` 的新触发类型；`break_reminder` 命中时若宠物正在睡，**同一 tick 内**强制把 `wake` 事件喂给 `petBrain.step()`（不经过 `pending` 队列的下一 tick 延迟，见 §7） | 现有手势层 |

**数据流**：`idleWatcher`（主进程，每 30s 采样）→ 边沿检测出 `afk_leave`/`break_reminder` → `IPC.CONTEXT_SIGNAL` 推给渲染进程 → `petController` 存入待处理信号槽位 → 下一 tick：若为 `break_reminder` 且宠物在睡则先同 tick 内叫醒 `petBrain`，再喂给 `stepReaction` → 若 `output.speak` → `petApi.petSpeak(category)`（复用 MVP-13 既有链路，不变）。

## 4. `reactionPlanner` 优先级链（重写）

**类型扩展**
- `ReactionCategory`：`'idle' | 'long_idle' | 'wake' | 'click' | 'drag'` → 新增 `'greet' | 'farewell' | 'sleep' | 'break'`（前三个复用 `lines.json` 里已写好但从未接线的分类；`break` 是全新分类，见 §6）。
- `ReactionTrigger`：`'poke' | 'drag' | 'wake'` → 新增 `'afk_leave' | 'break_reminder'`。
- `ReactionInput`：原来合并的 `paused: boolean` 拆成 `pausedByDialog: boolean`（对话框开着，等价于原 `ctx.paused`）+ `sleeping: boolean`（宠物动画上在睡）；新增 `nowMs: number`（墙钟时间戳，用于当天首问候的日期/时段判定，注入以保持纯函数可测）。
- `ReactionOutput`：不变，仍是 `{ speak?: ReactionCategory }`——叫醒逻辑不在 `reactionPlanner` 里判定，由调用方（`petController`）在喂给 `stepReaction` **之前**就决定好（见 §7 时序说明），`reactionPlanner` 只管"这一 tick 该说哪句"。
- `ReactionCtx`：新增 `lastGreetDateKey: string | null`（记录当天首问候上次触发的本地日期，如 `"2026-07-07"`，跨天后重新可触发）。

**优先级（从高到低，每 tick 只走一条）**
1. `pausedByDialog` → 静音（不变）。
2. `trigger ∈ {poke, drag, wake}`（真实触碰/唤醒）：
   a. 若今天还没问候过，且当前小时落在早安窗口（5:00–10:00）或晚安窗口（23:00–次日2:00）→ 说 `greet`/`farewell`，记录 `lastGreetDateKey`（覆盖本次原本的 click/drag/wake/sleep 输出，一天只此一次）。
   b. 否则若 `trigger === 'poke' && sleeping` → 说 `sleep`（梦话），**不**叫醒（petBrain 状态不受影响，因为 `poke()` 本来就不产生 `PetEvent`）。
   c. 否则沿用现状：`poke→click`、`drag→drag`、`wake→wake`。
   （事件冷却 `eventCooldownMs` 防连点刷屏逻辑不变，套用在 a/b/c 全部分支上。）
3. `trigger === 'break_reminder'` → 说 `break`（若采样时宠物正在睡，调用方已在喂给 `stepReaction` 之前的同一 tick 内把它叫醒，见 §7；到这里 `sleeping` 恒为 false，故 `break` 分类无需依赖 `sleeping` 判定）。
4. `trigger === 'afk_leave'` → 说 `farewell`；不产生 `wake`（宠物当前状态不受影响——离开不该叫醒它）。
5. `long_idle`（不变）。
6. `idle` 闲聊（不变）。

任意非空 `trigger`（包括新的 `afk_leave`/`break_reminder`）仍会重置 `idleSinceMs`/`longIdleSpoken`（复用现有无条件重置逻辑），避免叫醒/离开信号后紧接着又立刻冒一句 `long_idle`。

**已知边界情况（接受，不特殊处理）**：晚安窗口跨零点，若用户在 23:xx 触发了 `farewell`、又在次日 00:xx 再次触碰，因为日期已跨天会再触发一次 `farewell`——同一个"深夜时段"里可能问候两次。影响轻微（不算错误，只是稍微多话），不为此引入"夜间会话"概念。

## 5. `idleWatcher`（主进程新模块）

纯逻辑核心（可单测，注入采样值，不直接依赖 `powerMonitor`）：

```ts
interface IdleWatcherConfig {
  pollIntervalMs: number      // 默认 30_000
  afkThresholdMs: number      // 默认 5*60_000
  breakThresholdMs: number    // 默认 45*60_000
  activeResetIdleMs: number   // 默认 60_000 —— 采样时闲置 ≥ 此值视为"歇了一下"，久坐累加器清零
}
interface IdleWatcherState { activeAccumMs: number; afkArmed: boolean }
type IdleWatcherEvent = 'afk_leave' | 'break_reminder'

function stepIdleWatcher(state, idleMs, cfg): { state; events: IdleWatcherEvent[] }
```

判定规则：
- **AFK**：`idleMs >= afkThresholdMs && state.afkArmed` → 发 `afk_leave`，`afkArmed=false`；`idleMs < afkThresholdMs` → `afkArmed=true`（重新武装，用户回来后下次再离开又能触发）。
- **久坐**：`idleMs < activeResetIdleMs` → `activeAccumMs += pollIntervalMs`；否则清零。`activeAccumMs >= breakThresholdMs` → 发 `break_reminder`，`activeAccumMs=0`。

薄包装：`startIdleWatcher(petWin, getIdleMs = () => powerMonitor.getSystemIdleTime()*1000)`，`setInterval(pollIntervalMs)` 调 `stepIdleWatcher`，把 `events` 逐个 `petWin.webContents.send(IPC.CONTEXT_SIGNAL, {kind})` 推给渲染进程；返回 `stop()` 供 app 退出时 `clearInterval`。挂载时机：`petWin` 创建完成之后（跟随窗口生命周期，不早于 `app.whenReady`）。

## 6. `break` 分类台词（新增内容）

四个宠物包（`luluka`/`youka`/`shiraishi-mio`/`juwang`）各自 `lines.json` 新增 `break` 分类，每个至少 2 句，口吻是"刚被叫醒、带着困意吐槽用户坐太久"，延续各自人设。写 spec 阶段先起草 `luluka`（冰淇淋侦探人设）供确认：

```json
"break": [
  { "text": "……唔。你坐这么久，我都睡了一觉了。" },
  { "text": "起来走走。线索又不会跑。" }
]
```

其余三个宠物包照各自人设摹写（写计划/实现阶段完成，非本文档阻塞项）。四个 `lines.json` 均被 `.gitignore`（仅在磁盘，参见 MVP-13 spec 同款注意事项），改动直接落在磁盘副本上，不会出现在 git diff 里。

## 7. IPC 契约（四文件同步，新增单向通道 `CONTEXT_SIGNAL`）

主→渲染推送，仿 `PET_EVENT`：
1. `src/shared/ipc.ts`：`IPC.CONTEXT_SIGNAL` 常量 + `PetApi.onContextSignal(cb: (kind: 'afk_leave' | 'break_reminder') => void): void` 类型。
2. `src/main/shell/index.ts`：挂载/卸载 `idleWatcher`（`petWin` 就绪后 `startIdleWatcher`，app 退出前 `stop()`）。
3. `src/preload/index.ts`：`onContextSignal` 监听器暴露（`ipcRenderer.on` 包装，同 `onPetEvent`/`onBubbleLine` 的既有写法）。
4. `src/renderer/petController.ts`（或 `main.ts` 初始化处，仿 `onPetEvent` 的接线位置）：订阅 → 存入**独立于 `pendingReaction` 的新槽位字段**（如 `pendingContextSignal: ContextSignalKind | null`）→ 下一 tick 消费。

**时序陷阱与修正**：最初设想"`break_reminder` 命中时调用 `this.send('wake')` 把 `PetEvent` 排进 `pending`、下一 tick 由 `petBrain` 处理"——但这样"叫醒"会晚一 tick 才真正发生，而**那一 tick** 现有的 `wokeUp = prevState==='sleep' && ctx.state!=='sleep'` 检测也会为真，于是当 tick 的 `trigger` 会被派生成通用 `wake`，把上一 tick 刚出的更具体的 `break` 台词气泡立刻覆盖成通用唤醒台词——`break` 分类实际上永远不会被用户看见。

修正为**同一 tick 内**完成叫醒：`tick()` 读到 `pendingContextSignal === 'break_reminder'` 且当前 `this.ctx.state === 'sleep'` 时，**在本 tick 调用 `petBrain.step()` 之前**就把要喂给它的 `event` 强制设为 `'wake'`（覆盖 `this.pending.shift()` 取到的值，理论上两者不会同时非空）。这样 `wokeUp` 与 `pendingContextSignal` 在**同一 tick**内一起为真，`trigger` 优先级取 `pendingContextSignal ?? (wokeUp ? 'wake' : (pendingReaction ?? undefined))`——**`pendingContextSignal` 优先于 `wokeUp` 派生**，`stepReaction` 收到的 `sleeping` 此时已经是 `false`（本 tick 内已醒），直接映射到 `break` 分类。`wokeUp` 相对于既有 `pendingReaction`（poke/拖拽）的优先级**保持不变**，不影响 MVP-13 已验收的"拖起睡眠中的宠物出 `wake` 而非 `drag`"手感。`afk_leave` 不涉及叫醒，直接走 `pendingContextSignal` 优先级即可。

## 8. 测试策略

- **`reactionPlanner`**（Vitest 纯函数，扩展现有测试文件）：新增用例覆盖睡眠戳→`sleep`、当天首问候的早安/晚安窗口判定与跨天重置、`afk_leave`→`farewell`（`sleeping:true` 时也触发）、`break_reminder`→`break`（`sleeping:false`——调用方已保证叫醒发生在 `stepReaction` 之前）、`pausedByDialog` 依旧对新信号生效。日期/时段判定需要注入固定 `nowMs` 做判别性测试。
- **`idleWatcher`**（新 Vitest 文件）：`stepIdleWatcher` 纯函数注入一串 `idleMs` 采样序列，验证 AFK 边沿触发+重新武装、久坐累加器清零/累加/触发+重置。`startIdleWatcher` 的 `powerMonitor` 薄包装部分不单测（同 weather/firecrawl 工具的既有取舍）。
- **真机验收**（`pnpm dev`/`pnpm preview`，项目既有约定，无 Electron GUI 自动化驱动）：
  - 戳睡眠中的宠物 → 说梦话不醒来；拖起 → 正常叫醒（不变）。
  - 当天第一次触碰若在早安/晚安时段窗口内 → 出 `greet`/`farewell`，同一天不再重复。
  - AFK/久坐两个阈值（默认 5 分钟/45 分钟）真等太久不现实——验收时临时把 `idleWatcher` 的构造阈值改小（如 10 秒/30 秒）走查一遍行为，再改回默认值。
  - 久坐提醒命中时若宠物在睡 → 先醒来再出 `break` 台词；AFK 离开命中时宠物状态不变（睡的继续睡）。
  - 对话框开着时，以上新信号均不出气泡（`pausedByDialog` 抑制）。

## 9. 风险与遗留

- **风险**：AFK/久坐阈值手感需要真机长时间使用才能判断是否烦人，默认值（5min/45min）是合理猜测，非最终定论——集中在 `IdleWatcherConfig` 常量，便于后续调。
- **风险**：`powerMonitor.getSystemIdleTime()` 的精度/行为在部分系统配置下可能有差异（如远程桌面会话），未做特殊适配，出问题时按需再议。
- **遗留/后续**：窗口/应用焦点检测、主动搭话/陪伴深化，均明确留给各自独立的下一轮 brainstorming（详见 ROADMAP.md）。

## 10. 涉及文件清单

**新增**
- `src/main/context/idleWatcher.ts` + `idleWatcher.test.ts`

**修改**
- `src/shared/reactionPlanner.ts` + `reactionPlanner.test.ts`（`ReactionCategory`/`ReactionTrigger`/`ReactionInput`/`ReactionOutput`/`ReactionCtx` 扩展 + 优先级链重写）
- `src/shared/ipc.ts`（`IPC.CONTEXT_SIGNAL` 常量 + `PetApi.onContextSignal` 类型）
- `src/preload/index.ts`（`onContextSignal` 暴露）
- `src/main/shell/index.ts`（挂载/卸载 `idleWatcher`）
- `src/renderer/petController.ts`（订阅 `onContextSignal`、`break_reminder` 命中且睡眠中时同 tick 强制注入 `wake` `PetEvent`、`stepReaction` 调用点传入 `sleeping`/`pausedByDialog`/`nowMs`）
- `pets/luluka/lines.json`、`pets/youka/lines.json`、`pets/shiraishi-mio/lines.json`、`pets/juwang/lines.json`（新增 `break` 分类，磁盘直改，`.gitignore` 覆盖不影响 git diff）
