# 窗口/应用焦点感知 — 设计文档

> 2026-07-11 与用户 brainstorming 定下。承接 ROADMAP.md 轨道二"让它活起来"里明确列出但一直拆到独立轮次的**窗口/应用焦点检测**一项（2026-07-07 情境感知 MVP、2026-07-08 桌面控制 MVP 均明确排除本项）。这是"懂我在干嘛"系列的第二块拼图：情境感知（AFK/久坐/问候）看的是"用户在不在、忙不忙"，本 MVP 看的是"用户具体在用哪个软件"。

## 1. 背景与问题

`reactionPlanner` 目前的触发源分三类：环境定时（idle/long_idle）、真实触碰（poke/drag/wake）、主进程情境信号（afk_leave/break_reminder，2026-07-07 落地）。三类都不知道用户前台开着什么窗口——宠物没法在用户切到 IDE 时吐槽"又在写代码"，也没法在切到摸鱼软件时调侃一句。

ROADMAP.md 里这一项之所以被反复拆出去，是因为它比其余情境信号多两个明确的复杂度：
1. 需要真正检测前台窗口（本仓库此前零跨应用窗口检测代码），拿到进程名/窗口标题涉及隐私边界，需要谨慎设计。
2. 需要一层"应用名 → 台词"的映射配置，这本身是个不小的设计决策。

本次 brainstorming 已经把这两个问题谈清楚，本文档定下具体方案。

## 2. 目标与非目标

**目标（本 MVP）**
- 轮询检测当前前台窗口的**进程名 + 窗口标题**（Windows-only，PowerShell + Win32 API，零新增 npm 依赖）。
- 宠物包 `lines.json` 新增 `app_focus` 规则表：`{match: string[], lines: Line[]}[]`，对进程名+标题做不区分大小写的子串匹配，命中即从对应台词池随机选一句。
- 切到白名单命中的应用 → 说台词；带**全局最小间隔**（防止快速 alt-tab 刷屏）+ **同规则冷却**（同一个应用/规则短期内不重复念叨）两层防刷屏。
- 若宠物在睡，切到白名单应用 → 先叫醒再说（与"久坐提醒"手感一致，复用同一套同 tick 叫醒机制）。
- 对话框开着 → 完全静默（与所有既有信号一致）。
- 没有配置 `app_focus` 规则的宠物包（包括缺失 `lines.json`）→ 整个检测**不启动**，不产生任何后台轮询开销，优雅降级为完全不存在此功能。

**非目标（留给以后，YAGNI）**
- ❌ LLM 实时生成吐槽内容——本 MVP 只做预写台词库路径；架构上不为此设计特殊接口，也不刻意堵死，但不在本轮实现。
- ❌ 设置面板 UI（白名单/阈值可视化配置）——规则写在宠物包 `lines.json` 里，阈值是代码常量，跟 `idleWatcher`/`DEFAULT_REACTION_CONFIG` 同款取舍。
- ❌ 跨平台支持（macOS/Linux 前台窗口检测）——项目当前只有 Windows 打包目标。
- ❌ 窗口标题以外的更多信息（如窗口内容截图/OCR）——仅进程名+标题这两个字段。
- ❌ 情绪/养成数值——本项目现在还是纯 category+rng 选词，不引入 mood 变量。

## 3. 架构

**核心难点**：前台窗口检测是 OS 级能力，只能在主进程做；而 `reactionPlanner` 是渲染进程里的纯函数。复用 2026-07-07 情境感知 MVP 已经建好的"主进程判定信号 → `IPC.CONTEXT_SIGNAL` 推送 → 渲染进程消费"管线，不新开一条通道。

| 单元 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `foregroundWindowBridge` | `src/main/context/foregroundWindowBridge.ts`（纯函数，仿 `automation/win32Bridge.ts` 的"脚本构造+输出解析"分层） | 构造 PowerShell 脚本（`GetForegroundWindow`+`GetWindowThreadProcessId`+`GetWindowText`+`Get-Process` 拿进程名）、解析其 stdout | 无（不 import electron/child_process，可单测） |
| `appFocusWatcher` | `src/main/context/appFocusWatcher.ts`（纯核心 + 薄包装，仿 `context/idleWatcher.ts`） | 解析宠物包 `lines.json` 的 `app_focus` 规则、匹配当前前台窗口、边沿检测+双层冷却、决定是否触发；薄包装负责真正轮询执行 PowerShell | `foregroundWindowBridge`（脚本）、注入的 `execFile`（真机执行） |
| `reactionPlanner`（扩展） | `src/shared/reactionPlanner.ts` | 新增 `ReactionTrigger`/`ReactionCategory` 值 `'app_focus'`，优先级链新增一档：与 `break_reminder` 同级处理（调用方已同 tick 叫醒） | 无新依赖 |
| `petController`（扩展） | `src/renderer/petController.ts` | 现有"`break_reminder` 命中且宠物在睡 → 同 tick 强制叫醒"判断条件扩展到同时覆盖 `'app_focus'` | 现有逻辑 |
| `shell/index.ts`（扩展） | `src/main/shell/index.ts` | 挂载/卸载 `appFocusWatcher`（仅当当前宠物包定义了 `app_focus` 规则才挂载）；`PET_SPEAK` 处理器为 `app_focus` 分类增加特判分支，读取轮询阶段已选好的台词文本 | 现有 `pickLine`/`dialog.isOpen()`/`bubble.pushLine` |

**数据流**：`appFocusWatcher`（主进程，每 3s 采样一次前台窗口）→ 边沿检测（前台窗口变了）→ 匹配 `app_focus` 规则 → 双层冷却检查通过 → 选定一句台词、暂存到 `shell/index.ts` 的 `pendingAppFocusText` → `IPC.CONTEXT_SIGNAL` 推 `'app_focus'` 给渲染进程 → `petController`：若宠物在睡，同 tick 强制叫醒 → 喂给 `stepReaction`（trigger=`'app_focus'`）→ `speak:'app_focus'` → `petApi.petSpeak('app_focus')` → 主进程 `PET_SPEAK` 处理器识别出 `'app_focus'` 分类，直接用 `pendingAppFocusText`（而非走 `pickLine(loadLines(...), category)` 的常规查表路径）推气泡显示。

## 4. 前台窗口检测（`foregroundWindowBridge.ts`）

```ts
export function buildForegroundWindowScript(): string   // 纯函数，构造脚本文本
export function parseForegroundWindowOutput(stdout: string): { processName: string; windowTitle: string } | null
```

脚本内容：`Add-Type` 声明 `GetForegroundWindow`/`GetWindowThreadProcessId`/`GetWindowText` 三个 P/Invoke（比 `win32Bridge.ts` 的 `NATIVE_HEADER` 精简得多，因为不需要鼠标/键盘/枚举窗口那一套），进程名用 `Get-Process -Id $pid` 的 `.ProcessName`（.NET 内置，不需要额外 P/Invoke）。输出固定两行 `PROC:<name>` / `TITLE:<title>`，解析时按行前缀取值——避免标题本身包含分隔符导致解析错位。

**继承已验证过的两个 PowerShell 坑**（`win32Bridge.ts` 注释里记录过，同样适用于这个新脚本）：脚本正文只写 ASCII（不写中文注释，避免 Windows PowerShell 5.1 按系统代码页误读 UTF-8 字节破坏解析）；标题文本只读出用于本地匹配，不做任何拼接进后续可执行语句的操作（本脚本不需要，但保持这个纪律）。

真正执行走 `shell/index.ts` 里现成的 `execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })` 模式（`automationControl` 已经建立的注入式执行约定），不重新发明。

## 5. `lines.json` 的 `app_focus` 规则表 + 匹配

新分类，结构与其余扁平台词分类不同（需要一层"匹配规则→台词池"的间接）：

```json
"app_focus": [
  { "match": ["code.exe", "visual studio"], "lines": [{ "text": "又在写代码啦～加油！" }] },
  { "match": ["chrome.exe", "youtube"], "lines": [{ "text": "在看什么好玩的？" }] }
]
```

- `src/main/context/appFocusWatcher.ts` 新增 `parseAppFocusRules(raw: string): AppFocusRule[]`（`AppFocusRule = { match: string[]; lines: Line[] }`），复用 `linesLoader.ts` 里 `Line` 的解析校验规则（`text` 必须是 string，`audio` 可选），格式不对的规则/台词条目整条跳过，不中断其余解析——与 `parseLines`/`skillLoader`/`personaLoader` 一致的"坏数据跳过而非报错"降级哲学。
- `matchAppFocusRule(rules, sample): AppFocusRule | null`：把 `processName + ' ' + windowTitle` 转小写拼成一个待匹配串，按数组顺序找第一个 `match` 命中的规则（任一 `match` 项是子串即命中）。
- 从命中规则的 `lines` 池里选一句：复用 `linesLoader.ts` 里 `pickLine` 内部"随机选一句、避免与上次相同文本连续重复"的逻辑——把这段逻辑从 `pickLine` 里提成一个不依赖 `ReactionCategory` 的小工具函数（如 `pickFromPool(lines, avoidText, rng)`），`pickLine` 和这里都调它，避免复制一份选词算法。
- 宠物包没有 `app_focus` 分类（或没有 `lines.json`）→ `parseAppFocusRules` 返回空数组 → `shell/index.ts` 侧直接不启动 `appFocusWatcher`（见 §7）。

## 6. `appFocusWatcher` 核心状态机

```ts
export interface AppFocusSample { processName: string; windowTitle: string }
export interface AppFocusRule { match: string[]; lines: Line[] }

export interface AppFocusWatcherConfig {
  pollIntervalMs: number    // 默认 3_000 —— 采样前台窗口的频率
  minGapMs: number          // 默认 20_000 —— 任意两次 app_focus 触发之间的最小间隔，压住快速 alt-tab 刷屏
  ruleCooldownMs: number    // 默认 15*60_000 —— 同一条规则命中后,这么久之内不重复触发
}

export interface AppFocusWatcherState {
  lastSampleKey: string | null       // `${processName} ${windowTitle}`，用于判定"前台真的变了"这个边沿
  msSinceLastFire: number            // 初始设为 >= minGapMs，允许开局第一次匹配立即触发
  ruleLastFiredMsAgo: number[]       // 与 rules 等长，记录每条规则距上次触发过了多久
}

function stepAppFocusWatcher(
  state: AppFocusWatcherState,
  sample: AppFocusSample | null,
  rules: AppFocusRule[],
  cfg: AppFocusWatcherConfig
): { state: AppFocusWatcherState; firedRuleIndex: number | null }
```

判定规则：
1. 所有计时器先按 `cfg.pollIntervalMs` 累加（同 `idleWatcher` 的"按轮询间隔而非实测 dt 推进"做法，避免定时器抖动影响判定）。
2. 采样失败（PowerShell 报错/无前台窗口）→ 视为无事发生，只推进计时器。
3. `sampleKey === lastSampleKey` → 前台没变，不重新匹配（避免同一个窗口停留期间反复判定）。
4. 前台变了 → 更新 `lastSampleKey`，跑 `matchAppFocusRule`；不命中 → 结束（仍更新了 `lastSampleKey`，下次同一窗口不会重复判定）。
5. 命中规则 `i` → 若 `msSinceLastFire < minGapMs` 或 `ruleLastFiredMsAgo[i] < ruleCooldownMs` → 压住不发；否则触发：`msSinceLastFire=0`、`ruleLastFiredMsAgo[i]=0`，返回 `firedRuleIndex=i`。

薄包装 `startAppFocusWatcher(petDir, opts)`：启动时 `parseAppFocusRules` 一次（规则在运行期不变，宠物包切换会重启整个 app，无需热重载顾虑）；若规则为空数组直接返回一个 no-op handle（不设 `setInterval`，不执行任何 PowerShell）。否则 `setInterval(pollIntervalMs)` 里跑 `buildForegroundWindowScript` → 注入的 `execFile` → `parseForegroundWindowOutput` → `stepAppFocusWatcher`；`firedRuleIndex` 非空时用 `pickFromPool` 从命中规则的 `lines` 里选一句，通过 `opts.onMatch(line)` 回调交给调用方（不在本模块直接 `petWin.webContents.send`，由 `shell/index.ts` 统一处理 `dialog.isOpen()` 兜底+`IPC.CONTEXT_SIGNAL` 推送+`pendingAppFocusText` 暂存，和现有 `PET_SPEAK`/`showAmbientLine` 的職責划分一致）。

## 7. `reactionPlanner` 优先级链（扩展）

- `ReactionCategory` 追加 `'app_focus'`；`ReactionTrigger` 追加 `'app_focus'`。
- 优先级：在现有"3) 久坐提醒"和"4) AFK 离开"之间插入新的一档——`trigger === 'app_focus'` → 直接 `speak: 'app_focus'`（调用方已保证同 tick 内完成叫醒，若原本在睡）。不需要 `reactionPlanner` 自己再做冷却判断——`appFocusWatcher` 在主进程侧已经用 `minGapMs`/`ruleCooldownMs` 过滤过，到达 `reactionPlanner` 的都是"确定要说"的信号，这里只负责走既有的 `pausedByDialog` 静音闸门 + 重置 `idleSinceMs`/`longIdleSpoken`（与其余触发一致）。
- `petController.tick()` 里现有条件
  `if (contextSignal === 'break_reminder' && this.ctx.state === 'sleep') event = 'wake'`
  扩展为 `if ((contextSignal === 'break_reminder' || contextSignal === 'app_focus') && this.ctx.state === 'sleep') event = 'wake'`——复用 2026-07-07 已经验证过的"同 tick 内叫醒避免被 `wokeUp` 派生逻辑覆盖成通用 `wake` 台词"这个时序修正，不重新踩一遍那个坑。

## 8. `PET_SPEAK` 特判（`shell/index.ts`）

`app_focus` 分类不走 `pickLine(loadLines(petDir), category, ...)` 这条常规路径（它的台词池不是 `lines.json` 顶层扁平分类，而是某条 `app_focus` 规则内部的池，且已经在轮询阶段选好），改为：

```ts
let pendingAppFocusText: string | null = null

ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
  const category = validateReactionCategory(raw)
  if (!category) return
  if (dialog.isOpen()) return
  const line = category === 'app_focus'
    ? (pendingAppFocusText ? { text: pendingAppFocusText } : null)
    : pickLine(loadLines(petDir), category, lastLineText ?? undefined)
  if (category === 'app_focus') pendingAppFocusText = null
  if (!line) return
  lastLineText = line.text
  showAmbientLine(line.text)
})
```

`appFocusWatcher` 的 `onMatch` 回调里：`if (dialog.isOpen()) return`（对话框开着不触发，二次兜底，与现有 `showAmbientLine` 的兜底哲学一致）→ `pendingAppFocusText = line.text` → `petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')`。

## 9. 隐私与安全边界

- 采集字段仅限**进程名 + 窗口标题**，不做窗口内容截图/OCR/剪贴板关联。
- 窗口标题原文**只在主进程内存里用于子串匹配**，匹配完立刻丢弃——不落盘、不进日志、不经过任何网络请求、不喂给 LLM。真正显示给用户看的只有宠物包作者预先审过的固定台词文本。
- 检测本身默认"消极启动"：宠物包不定义 `app_focus` 规则时，连轮询循环都不会起来（§6），不是"功能默认开着只是不说话"，而是真的不产生任何后台行为——把"要不要引入这条隐私敏感的能力"的决定权交给宠物包内容本身，与项目现有"缺配置就优雅降级为不存在"的一贯做法一致，不需要额外一层设置面板开关。

## 10. 测试策略

- **`foregroundWindowBridge`**（新 Vitest 文件）：`buildForegroundWindowScript` 只做字符串快照/关键片段断言（不真的跑 PowerShell）；`parseForegroundWindowOutput` 覆盖正常两行输出、缺行、空标题、乱序等边界。
- **`appFocusWatcher`**（新 Vitest 文件）：
  - `parseAppFocusRules`：合法规则、`match`/`lines` 缺失或类型错误的规则被跳过、`_about` 等元数据键被忽略、无 `app_focus` 键返回空数组。
  - `matchAppFocusRule`：大小写不敏感、多规则按顺序取第一个命中、进程名和标题任一命中都算数、都不命中返回 null。
  - `stepAppFocusWatcher`（纯函数注入序列）：同一前台窗口停留期间不重复判定、`minGapMs` 压住紧接着的另一条规则触发、`ruleCooldownMs` 压住同规则短期重复触发、过了冷却期后同规则可再次触发、采样失败(null)只推进计时器不报错。
- **`reactionPlanner`**（扩展现有测试文件）：`trigger:'app_focus'` → `speak:'app_focus'`；`pausedByDialog` 时静音；触发后正确重置 `idleSinceMs`/`longIdleSpoken`。
- **`petController`**：扩展现有"久坐提醒同 tick 叫醒"测试用例，覆盖 `app_focus` 信号命中且宠物在睡时同样同 tick 叫醒（而非等下一 tick 被 `wokeUp` 派生覆盖）。
- **真机验收**（`pnpm dev`/`pnpm preview`，项目既有约定，无 Electron GUI 自动化驱动，需要真实 Windows 前台窗口切换）：
  - 切到 `lines.json` 里配置了 `app_focus` 规则的应用（如真实打开 VS Code）→ 冒出对应台词。
  - 快速 alt-tab 在多个白名单应用间切换 → 不刷屏（`minGapMs` 生效）。
  - 反复切回同一个应用 → 短期内不重复念叨（`ruleCooldownMs` 生效），过了冷却期后再切回会重新触发。
  - 宠物睡着时切到白名单应用 → 先醒来再吐槽（同"久坐提醒"手感）。
  - 对话框开着时切应用 → 静默。
  - 当前宠物包没配置 `app_focus` 规则时 → 确认任务管理器里看不到额外的 `powershell.exe` 高频进程（验证"没配置就不启动轮询"生效，而非只是不说话）。

## 11. 风险与遗留

- **风险**：`minGapMs`/`ruleCooldownMs` 的默认值（20s / 15min）是合理猜测，真机长期使用后可能需要调整——集中在 `AppFocusWatcherConfig` 常量里，便于后续改。
- **风险**：每 3s 起一个 `powershell.exe` 子进程有一定系统开销（虽然 `automationControl` 已经验证过这个模式真机可用），如果真机验收发现明显卡顿/资源占用，需要考虑把轮询间隔调大或改造成常驻 PowerShell 进程（属于后续优化，本 MVP 先用最简单的"每次新起进程"方案）。
- **遗留/后续**：LLM 实时生成吐槽（本文档 §2 非目标）、设置面板可配置白名单/阈值、"主动搭话/陪伴深化"（性格 SOUL，依赖本 MVP 的信号，仍留给独立下一轮 brainstorming）。

## 12. 涉及文件清单

**新增**
- `src/main/context/foregroundWindowBridge.ts` + `foregroundWindowBridge.test.ts`
- `src/main/context/appFocusWatcher.ts` + `appFocusWatcher.test.ts`

**修改**
- `src/shared/reactionPlanner.ts` + `reactionPlanner.test.ts`（`ReactionCategory`/`ReactionTrigger` 新增 `'app_focus'` + 优先级链新增一档）
- `src/main/lines/linesLoader.ts`（把 `pickLine` 内部"随机选一句避免连续重复"逻辑提成 `pickFromPool` 供 `appFocusWatcher` 复用）
- `src/renderer/petController.ts` + 对应测试（同 tick 叫醒条件扩展到 `'app_focus'`）
- `src/main/shell/index.ts`（挂载/卸载 `appFocusWatcher`；`PET_SPEAK` 处理器新增 `app_focus` 特判分支 + `pendingAppFocusText` 状态）
- 各宠物包 `lines.json`（`alice`/`alice_0`/`juwang`/`luluka`/`shiraishi-mio`/`youka`，磁盘直改，`.gitignore` 覆盖不影响 git diff）：新增 `app_focus` 规则，先在设计/计划阶段为 `luluka` 起草几条示例规则供确认，其余宠物包在实现阶段照各自人设摹写。
