# 窗口/应用焦点感知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宠物能检测当前前台窗口（进程名+标题），按宠物包 `lines.json` 里新增的 `app_focus` 规则表匹配后吐槽一句，带防刷屏冷却，睡眠中会先叫醒。

**Architecture:** 主进程新增两个模块——`foregroundWindowBridge.ts`（纯函数：构造/解析 PowerShell 前台窗口查询脚本）+ `appFocusWatcher.ts`（纯核心状态机做匹配+双层冷却边沿检测 + 薄包装做真实轮询）。命中后复用 2026-07-07 情境感知 MVP 已建好的 `IPC.CONTEXT_SIGNAL` 推送管线：`petController` 同 tick 内叫醒（若在睡）→ `reactionPlanner` 新增 `'app_focus'` 触发/分类 → `petApi.petSpeak('app_focus')` → 主进程 `PET_SPEAK` 处理器特判读取轮询阶段已选好的台词文本。

**Tech Stack:** TypeScript, Electron（主进程 `child_process.execFile` 调 `powershell.exe`）, Vitest。零新增 npm 依赖。

## Global Constraints

- Windows-only；不做跨平台支持（项目当前只打包 Windows）。
- 零新增 npm 依赖。
- 生成的 PowerShell 脚本正文只能是 ASCII 字符（不写中文注释）——Windows PowerShell 5.1 对无 BOM 的 `.ps1`/`-Command` 脚本按系统代码页而非 UTF-8 解码，非 ASCII 字节会破坏解析（`win32Bridge.ts` 已踩过并记录的坑）。
- 不做设置面板 UI；匹配规则写在宠物包 `lines.json` 里，冷却阈值是代码常量（默认 `pollIntervalMs=3000`、`minGapMs=20000`、`ruleCooldownMs=900000`）。
- 宠物包没有配置 `app_focus` 规则时，轮询循环本身不启动（不是"启动了但不说话"）。
- 窗口标题原文只在主进程内存里用于子串匹配，用完即弃——不落盘、不进日志、不经网络、不喂给 LLM。
- 每个任务完成后运行 `pnpm typecheck` 且新增/改动的 Vitest 用例全部通过，再提交。
- `pets/*/lines.json` 被 `.gitignore` 忽略（仅在磁盘），涉及它们的任务不需要（也不能）`git add`/`git commit`。
- 参考 spec：`docs/superpowers/specs/2026-07-11-app-focus-awareness-design.md`。

---

### Task 1: `foregroundWindowBridge`——前台窗口检测脚本（纯函数）

**Files:**
- Create: `src/main/context/foregroundWindowBridge.ts`
- Test: `src/main/context/foregroundWindowBridge.test.ts`

**Interfaces:**
- Produces: `buildForegroundWindowScript(): string`、`parseForegroundWindowOutput(stdout: string): ForegroundWindowSample | null`、`interface ForegroundWindowSample { processName: string; windowTitle: string }`

- [ ] **Step 1: 写失败的测试**

创建 `src/main/context/foregroundWindowBridge.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildForegroundWindowScript, parseForegroundWindowOutput } from './foregroundWindowBridge'

describe('buildForegroundWindowScript', () => {
  it('包含 GetForegroundWindow/GetWindowThreadProcessId/GetWindowText 三个 P/Invoke 声明', () => {
    const s = buildForegroundWindowScript()
    expect(s).toContain('GetForegroundWindow')
    expect(s).toContain('GetWindowThreadProcessId')
    expect(s).toContain('GetWindowText')
  })

  it('脚本正文只含 ASCII 字符(Windows PowerShell 5.1 代码页坑,不写中文)', () => {
    const s = buildForegroundWindowScript()
    expect(/^[\x00-\x7F]*$/.test(s)).toBe(true)
  })

  it('固定输出两行 PROC:/TITLE: 前缀', () => {
    const s = buildForegroundWindowScript()
    expect(s).toContain('Write-Output "PROC:$procName"')
    expect(s).toContain('Write-Output "TITLE:$($sb.ToString())"')
  })
})

describe('parseForegroundWindowOutput', () => {
  it('解析正常两行输出', () => {
    const out = parseForegroundWindowOutput('PROC:Code\nTITLE:main.ts - Visual Studio Code\n')
    expect(out).toEqual({ processName: 'Code', windowTitle: 'main.ts - Visual Studio Code' })
  })

  it('标题为空仍能解析', () => {
    const out = parseForegroundWindowOutput('PROC:explorer\nTITLE:\n')
    expect(out).toEqual({ processName: 'explorer', windowTitle: '' })
  })

  it('缺 PROC 行 → null', () => {
    expect(parseForegroundWindowOutput('TITLE:only title\n')).toBeNull()
  })

  it('缺 TITLE 行时 windowTitle 退化为空串', () => {
    const out = parseForegroundWindowOutput('PROC:Code\n')
    expect(out).toEqual({ processName: 'Code', windowTitle: '' })
  })

  it('行顺序无关(容错乱序)', () => {
    const out = parseForegroundWindowOutput('TITLE:foo\nPROC:bar\n')
    expect(out).toEqual({ processName: 'bar', windowTitle: 'foo' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/context/foregroundWindowBridge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/main/context/foregroundWindowBridge.ts`：

```ts
/**
 * 纯函数:构造 PowerShell 脚本(GetForegroundWindow + GetWindowThreadProcessId +
 * GetWindowText 拿前台窗口标题,Get-Process 拿进程名),以及解析其 stdout。
 * 不 import child_process/electron,可单测。真正执行脚本在 appFocusWatcher.ts。
 *
 * 脚本正文只写 ASCII(不写中文注释):Windows PowerShell 5.1 对没有 BOM 的脚本按系统
 * 默认代码页(而非 UTF-8)解码,非 ASCII 字节可能破坏后续解析
 * (automation/win32Bridge.ts 已踩过并记录的同款坑)。
 */

export function buildForegroundWindowScript(): string {
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PetAgentContext
{
    public class Native
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    }
}
"@
$hwnd = [PetAgentContext.Native]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[PetAgentContext.Native]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
$procId = 0
[PetAgentContext.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$procName = "unknown"
try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
Write-Output "PROC:$procName"
Write-Output "TITLE:$($sb.ToString())"
`.trim()
}

export interface ForegroundWindowSample { processName: string; windowTitle: string }

export function parseForegroundWindowOutput(stdout: string): ForegroundWindowSample | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim())
  const procLine = lines.find((l) => l.startsWith('PROC:'))
  const titleLine = lines.find((l) => l.startsWith('TITLE:'))
  if (!procLine) return null
  return {
    processName: procLine.slice('PROC:'.length),
    windowTitle: titleLine ? titleLine.slice('TITLE:'.length) : ''
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/context/foregroundWindowBridge.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/context/foregroundWindowBridge.ts src/main/context/foregroundWindowBridge.test.ts
git commit -m "feat(context): 新增前台窗口检测 PowerShell 脚本构造与解析"
```

---

### Task 2: `linesLoader` 重构——抽出 `pickFromPool`

**Files:**
- Modify: `src/main/lines/linesLoader.ts`
- Test: `src/main/lines/linesLoader.test.ts`

**Interfaces:**
- Consumes: 无（纯内部重构）
- Produces: `pickFromPool(lines: Line[], avoidText?: string, rng?: () => number): Line | null`（供 Task 5 的 `appFocusWatcher` 复用；`pickLine` 内部改为委托给它，对外行为不变）

- [ ] **Step 1: 写失败的测试**

在 `src/main/lines/linesLoader.test.ts` 顶部 import 里加入 `pickFromPool`，并在文件末尾追加：

```ts
describe('pickFromPool', () => {
  it('空数组 → null', () => {
    expect(pickFromPool([])).toBeNull()
  })
  it('rng 决定选中项', () => {
    const pool = [{ text: 'a' }, { text: 'b' }]
    expect(pickFromPool(pool, undefined, () => 0)).toEqual({ text: 'a' })
    expect(pickFromPool(pool, undefined, () => 0.99)).toEqual({ text: 'b' })
  })
  it('avoidText 时避开上一句', () => {
    const pool = [{ text: 'a' }, { text: 'b' }]
    expect(pickFromPool(pool, 'a', () => 0)).toEqual({ text: 'b' })
  })
  it('只有一条时即便命中 avoidText 也返回它', () => {
    expect(pickFromPool([{ text: 'a' }], 'a')).toEqual({ text: 'a' })
  })
})
```

第一行 import 改为：
```ts
import { parseLines, pickLine, pickFromPool } from './linesLoader'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: FAIL（`pickFromPool` 未导出）

- [ ] **Step 3: 实现**

编辑 `src/main/lines/linesLoader.ts`，把现有 `pickLine` 函数体替换为：

```ts
export function pickFromPool(
  lines: Line[],
  avoidText?: string,
  rng: () => number = Math.random
): Line | null {
  if (lines.length === 0) return null
  const pool = lines.length > 1 && avoidText ? lines.filter((l) => l.text !== avoidText) : lines
  const candidates = pool.length > 0 ? pool : lines
  return candidates[Math.floor(rng() * candidates.length)] ?? null
}

export function pickLine(
  table: LinesTable,
  category: ReactionCategory,
  avoidText?: string,
  rng: () => number = Math.random
): Line | null {
  const lines = table[category]
  if (!lines) return null
  return pickFromPool(lines, avoidText, rng)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: PASS（新旧用例全部通过——`pickLine` 原有测试是回归检查，确认委托没有改变外部行为）

- [ ] **Step 5: 提交**

```bash
git add src/main/lines/linesLoader.ts src/main/lines/linesLoader.test.ts
git commit -m "refactor(lines): 从 pickLine 抽出 pickFromPool 供应用焦点规则复用"
```

---

### Task 3: `appFocusWatcher`——规则解析与匹配（纯函数）

**Files:**
- Create: `src/main/context/appFocusWatcher.ts`
- Test: `src/main/context/appFocusWatcher.test.ts`

**Interfaces:**
- Consumes: `Line` type from `../lines/linesLoader`
- Produces: `interface AppFocusRule { match: string[]; lines: Line[] }`、`parseAppFocusRules(raw: string): AppFocusRule[]`、`matchAppFocusRule(rules: AppFocusRule[], sample: { processName: string; windowTitle: string }): AppFocusRule | null`

- [ ] **Step 1: 写失败的测试**

创建 `src/main/context/appFocusWatcher.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseAppFocusRules, matchAppFocusRule } from './appFocusWatcher'

describe('parseAppFocusRules', () => {
  it('解析合法规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
        { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
      ]
    })
    const rules = parseAppFocusRules(raw)
    expect(rules).toEqual([
      { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
      { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
    ])
  })

  it('坏 JSON → 空数组', () => {
    expect(parseAppFocusRules('{ not json')).toEqual([])
  })

  it('没有 app_focus 键 → 空数组', () => {
    expect(parseAppFocusRules(JSON.stringify({ idle: [{ text: 'a' }] }))).toEqual([])
  })

  it('跳过缺 match 或 match 为空数组的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { lines: [{ text: 'a' }] },
        { match: [], lines: [{ text: 'b' }] },
        { match: ['ok.exe'], lines: [{ text: 'c' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['ok.exe'], lines: [{ text: 'c' }] }])
  })

  it('跳过缺 lines 或 lines 全部无效的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['a.exe'] },
        { match: ['b.exe'], lines: [{ nope: 1 }] },
        { match: ['c.exe'], lines: [{ text: 'ok' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['c.exe'], lines: [{ text: 'ok' }] }])
  })
})

describe('matchAppFocusRule', () => {
  const rules = [
    { match: ['code.exe', 'visual studio'], lines: [{ text: 'a' }] },
    { match: ['chrome.exe'], lines: [{ text: 'b' }] }
  ]

  it('按进程名命中(大小写不敏感)', () => {
    expect(matchAppFocusRule(rules, { processName: 'Code.EXE', windowTitle: 'x' })).toEqual(rules[0])
  })

  it('按窗口标题命中', () => {
    expect(matchAppFocusRule(rules, { processName: 'unknown', windowTitle: 'Visual Studio Code - main.ts' })).toEqual(rules[0])
  })

  it('都不命中 → null', () => {
    expect(matchAppFocusRule(rules, { processName: 'notepad.exe', windowTitle: 'Untitled' })).toBeNull()
  })

  it('多规则按顺序取第一个命中', () => {
    const overlapping = [
      { match: ['exe'], lines: [{ text: 'first' }] },
      { match: ['chrome.exe'], lines: [{ text: 'second' }] }
    ]
    expect(matchAppFocusRule(overlapping, { processName: 'chrome.exe', windowTitle: '' })).toEqual(overlapping[0])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/main/context/appFocusWatcher.ts`：

```ts
import type { Line } from '../lines/linesLoader'

export interface AppFocusRule { match: string[]; lines: Line[] }

export function parseAppFocusRules(raw: string): AppFocusRule[] {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return [] }
  if (typeof data !== 'object' || data === null) return []
  const rulesRaw = (data as Record<string, unknown>).app_focus
  if (!Array.isArray(rulesRaw)) return []

  const rules: AppFocusRule[] = []
  for (const item of rulesRaw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>

    if (!Array.isArray(rec.match)) continue
    const match = rec.match.filter((m): m is string => typeof m === 'string' && m.length > 0)
    if (match.length === 0) continue

    if (!Array.isArray(rec.lines)) continue
    const lines: Line[] = []
    for (const lineItem of rec.lines) {
      if (typeof lineItem !== 'object' || lineItem === null) continue
      const lineRec = lineItem as Record<string, unknown>
      if (typeof lineRec.text !== 'string') continue
      const line: Line = { text: lineRec.text }
      if (typeof lineRec.audio === 'string') line.audio = lineRec.audio
      lines.push(line)
    }
    if (lines.length === 0) continue

    rules.push({ match, lines })
  }
  return rules
}

export function matchAppFocusRule(
  rules: AppFocusRule[],
  sample: { processName: string; windowTitle: string }
): AppFocusRule | null {
  const haystack = `${sample.processName} ${sample.windowTitle}`.toLowerCase()
  for (const rule of rules) {
    if (rule.match.some((m) => haystack.includes(m.toLowerCase()))) return rule
  }
  return null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/context/appFocusWatcher.ts src/main/context/appFocusWatcher.test.ts
git commit -m "feat(context): 新增 app_focus 规则解析与匹配纯函数"
```

---

### Task 4: `appFocusWatcher`——边沿检测 + 双层冷却状态机（纯函数）

**Files:**
- Modify: `src/main/context/appFocusWatcher.ts`
- Modify: `src/main/context/appFocusWatcher.test.ts`

**Interfaces:**
- Consumes: `ForegroundWindowSample` from `./foregroundWindowBridge`（Task 1）；`AppFocusRule`/`matchAppFocusRule`（Task 3，同文件内）
- Produces: `interface AppFocusWatcherConfig { pollIntervalMs: number; minGapMs: number; ruleCooldownMs: number }`、`DEFAULT_APP_FOCUS_WATCHER_CONFIG`、`interface AppFocusWatcherState`、`initAppFocusWatcher(ruleCount: number, cfg: AppFocusWatcherConfig): AppFocusWatcherState`、`stepAppFocusWatcher(state, sample, rules, cfg): { state: AppFocusWatcherState; firedRuleIndex: number | null }`（供 Task 5 复用）

- [ ] **Step 1: 写失败的测试**

在 `src/main/context/appFocusWatcher.test.ts` 顶部 import 追加 `initAppFocusWatcher, stepAppFocusWatcher, type AppFocusWatcherConfig`，文件末尾追加：

```ts
describe('stepAppFocusWatcher', () => {
  const cfg: AppFocusWatcherConfig = { pollIntervalMs: 1000, minGapMs: 3000, ruleCooldownMs: 5000 }
  const rules = [
    { match: ['code.exe'], lines: [{ text: 'code' }] },
    { match: ['chrome.exe'], lines: [{ text: 'chrome' }] }
  ]

  it('同一前台窗口停留期间不重复判定', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    const sample = { processName: 'code.exe', windowTitle: 'a.ts' }
    let r = stepAppFocusWatcher(state, sample, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, sample, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
  })

  it('minGapMs 压住紧接着切到另一条规则', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, { processName: 'chrome.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
  })

  it('过了 minGapMs 后切到不同规则可以触发', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: '' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'other' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'other2' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'chrome.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(1)
  })

  it('ruleCooldownMs 压住同规则短期重复触发,过了冷却期后可再次触发', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'a' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'b' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '2' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '3' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'c' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
  })

  it('采样为 null(取窗口失败) → 不报错,只推进计时器', () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const r = stepAppFocusWatcher(state, null, rules, cfg)
    expect(r.firedRuleIndex).toBeNull()
    expect(r.state.msSinceLastFire).toBe(cfg.minGapMs + cfg.pollIntervalMs)
  })

  it('都不命中规则 → 不触发', () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: 'Untitled' }, rules, cfg)
    expect(r.firedRuleIndex).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: FAIL（`initAppFocusWatcher`/`stepAppFocusWatcher` 未导出）

- [ ] **Step 3: 实现**

在 `src/main/context/appFocusWatcher.ts` 顶部（`import type { Line } from '../lines/linesLoader'` 那一行下面）追加一行 import：

```ts
import type { ForegroundWindowSample } from './foregroundWindowBridge'
```

然后在文件末尾追加：

```ts
export interface AppFocusWatcherConfig {
  /** 轮询前台窗口的频率 */
  pollIntervalMs: number
  /** 任意两次 app_focus 触发之间的最小间隔,压住快速 alt-tab 刷屏 */
  minGapMs: number
  /** 同一条规则命中后,这么久之内不重复触发 */
  ruleCooldownMs: number
}

export const DEFAULT_APP_FOCUS_WATCHER_CONFIG: AppFocusWatcherConfig = {
  pollIntervalMs: 3_000,
  minGapMs: 20_000,
  ruleCooldownMs: 15 * 60_000
}

export interface AppFocusWatcherState {
  /** `processName windowTitle`,用于判定"前台真的变了"这个边沿 */
  lastSampleKey: string | null
  msSinceLastFire: number
  /** 与 rules 等长,记录每条规则距上次触发过了多久 */
  ruleLastFiredMsAgo: number[]
}

export function initAppFocusWatcher(ruleCount: number, cfg: AppFocusWatcherConfig): AppFocusWatcherState {
  return {
    lastSampleKey: null,
    msSinceLastFire: cfg.minGapMs, // 允许开局第一次匹配立即触发
    ruleLastFiredMsAgo: new Array(ruleCount).fill(Number.MAX_SAFE_INTEGER)
  }
}

export function stepAppFocusWatcher(
  state: AppFocusWatcherState,
  sample: ForegroundWindowSample | null,
  rules: AppFocusRule[],
  cfg: AppFocusWatcherConfig
): { state: AppFocusWatcherState; firedRuleIndex: number | null } {
  let next: AppFocusWatcherState = {
    ...state,
    msSinceLastFire: state.msSinceLastFire + cfg.pollIntervalMs,
    ruleLastFiredMsAgo: state.ruleLastFiredMsAgo.map((ms) => ms + cfg.pollIntervalMs)
  }

  if (!sample) return { state: next, firedRuleIndex: null }

  const sampleKey = `${sample.processName} ${sample.windowTitle}`
  if (sampleKey === next.lastSampleKey) return { state: next, firedRuleIndex: null }
  next = { ...next, lastSampleKey: sampleKey }

  const matched = matchAppFocusRule(rules, sample)
  if (!matched) return { state: next, firedRuleIndex: null }
  const matchedIndex = rules.indexOf(matched)

  if (next.msSinceLastFire < cfg.minGapMs) return { state: next, firedRuleIndex: null }
  if (next.ruleLastFiredMsAgo[matchedIndex] < cfg.ruleCooldownMs) return { state: next, firedRuleIndex: null }

  const ruleLastFiredMsAgo = [...next.ruleLastFiredMsAgo]
  ruleLastFiredMsAgo[matchedIndex] = 0
  next = { ...next, msSinceLastFire: 0, ruleLastFiredMsAgo }
  return { state: next, firedRuleIndex: matchedIndex }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: PASS（全部用例，包括 Task 3 留下的）

- [ ] **Step 5: 提交**

```bash
git add src/main/context/appFocusWatcher.ts src/main/context/appFocusWatcher.test.ts
git commit -m "feat(context): appFocusWatcher 新增边沿检测与双层冷却状态机"
```

---

### Task 5: `appFocusWatcher`——真实轮询薄包装

**Files:**
- Modify: `src/main/context/appFocusWatcher.ts`

**Interfaces:**
- Consumes: `buildForegroundWindowScript`/`parseForegroundWindowOutput`（Task 1）、`pickFromPool`/`type Line`（Task 2, from `../lines/linesLoader`）、`parseAppFocusRules`/`stepAppFocusWatcher`/`initAppFocusWatcher`/`DEFAULT_APP_FOCUS_WATCHER_CONFIG`（同文件）
- Produces: `interface AppFocusWatcherHandle { stop: () => void }`、`startAppFocusWatcher(petDir: string, opts: { execFile: (script: string) => Promise<{ stdout: string; stderr: string }>; onMatch: (line: Line) => void; config?: Partial<AppFocusWatcherConfig> }): AppFocusWatcherHandle`（Task 9 的 `shell/index.ts` 直接调用）

薄包装做真实 I/O（`fs.readFileSync`/注入的 `execFile`/`setInterval`），仿 `context/idleWatcher.ts` 里 `startIdleWatcher` 的既有取舍——不单测，靠 `pnpm typecheck` + 真机验收确认。

- [ ] **Step 1: 实现**

把 `src/main/context/appFocusWatcher.ts` 顶部 Task 3 留下的

```ts
import type { Line } from '../lines/linesLoader'
```

改为（合并成一条 import，避免同一模块两条 import 语句）：

```ts
import { pickFromPool, type Line } from '../lines/linesLoader'
```

再把 Task 4 加的

```ts
import type { ForegroundWindowSample } from './foregroundWindowBridge'
```

改为（同样合并成一条 import）：

```ts
import { buildForegroundWindowScript, parseForegroundWindowOutput, type ForegroundWindowSample } from './foregroundWindowBridge'
```

再追加两条新 import，然后在文件末尾追加实现：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppFocusWatcherHandle { stop: () => void }

/**
 * 薄包装:读取宠物包 lines.json 的 app_focus 规则(没有规则/没有该文件 → 空数组);
 * 若规则为空,直接返回 no-op handle,不起轮询——不启动的检测就是零隐私/性能开销,
 * 而不是"启动了但恰好不触发"。
 */
export function startAppFocusWatcher(
  petDir: string,
  opts: {
    execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
    onMatch: (line: Line) => void
    config?: Partial<AppFocusWatcherConfig>
  }
): AppFocusWatcherHandle {
  let rules: AppFocusRule[]
  try { rules = parseAppFocusRules(readFileSync(join(petDir, 'lines.json'), 'utf-8')) }
  catch { rules = [] }

  if (rules.length === 0) return { stop: (): void => {} }

  const cfg = { ...DEFAULT_APP_FOCUS_WATCHER_CONFIG, ...opts.config }
  let state = initAppFocusWatcher(rules.length, cfg)
  let lastFiredText: string | null = null

  const handle = setInterval(() => {
    void opts.execFile(buildForegroundWindowScript())
      .then((r) => parseForegroundWindowOutput(r.stdout))
      .catch(() => null)
      .then((sample) => {
        const result = stepAppFocusWatcher(state, sample, rules, cfg)
        state = result.state
        if (result.firedRuleIndex === null) return
        const line = pickFromPool(rules[result.firedRuleIndex].lines, lastFiredText ?? undefined)
        if (!line) return
        lastFiredText = line.text
        opts.onMatch(line)
      })
  }, cfg.pollIntervalMs)

  return { stop: (): void => clearInterval(handle) }
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无报错

- [ ] **Step 3: 跑一遍全量测试确认没有破坏既有用例**

Run: `pnpm vitest run src/main/context/`
Expected: PASS（Task 1/3/4 的用例仍然全绿；本任务本身不新增用例，薄包装靠真机验收）

- [ ] **Step 4: 提交**

```bash
git add src/main/context/appFocusWatcher.ts
git commit -m "feat(context): 新增 startAppFocusWatcher 真实轮询薄包装"
```

---

### Task 6: `reactionPlanner` 扩展——新增 `app_focus`

**Files:**
- Modify: `src/shared/reactionPlanner.ts`
- Modify: `src/shared/reactionPlanner.test.ts`

**Interfaces:**
- Produces: `ReactionCategory`/`ReactionTrigger` 新增 `'app_focus'`；`stepReaction` 对 `trigger:'app_focus'` 返回 `{ speak: 'app_focus' }`（供 Task 8 `petController.ts` 与 Task 9 `shell/index.ts` 使用）

- [ ] **Step 1: 写失败的测试**

编辑 `src/shared/reactionPlanner.test.ts`，把第 13-17 行的既有用例改为：

```ts
  it('REACTION_CATEGORIES 覆盖全部 category', () => {
    expect(REACTION_CATEGORIES).toEqual(
      ['idle', 'long_idle', 'wake', 'click', 'drag', 'greet', 'farewell', 'sleep', 'break', 'app_focus']
    )
  })
```

并在文件末尾（`afk_leave`/`break_reminder` 用例之后、`})` 之前）追加：

```ts
  it('app_focus → app_focus category', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'app_focus', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('app_focus')
  })

  it('pausedByDialog 时 app_focus 也静音', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'app_focus', pausedByDialog: true, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBeUndefined()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: FAIL（`REACTION_CATEGORIES` 缺 `'app_focus'`，`trigger:'app_focus'` 走不到任何分支返回 `{}`）

- [ ] **Step 3: 实现**

编辑 `src/shared/reactionPlanner.ts`：

第 1-6 行改为：
```ts
export type ReactionCategory =
  | 'idle' | 'long_idle' | 'wake' | 'click' | 'drag'
  | 'greet' | 'farewell' | 'sleep' | 'break' | 'app_focus'
export const REACTION_CATEGORIES: ReactionCategory[] = [
  'idle', 'long_idle', 'wake', 'click', 'drag', 'greet', 'farewell', 'sleep', 'break', 'app_focus'
]
```

第 9 行改为：
```ts
export type ReactionTrigger = 'poke' | 'drag' | 'wake' | 'afk_leave' | 'break_reminder' | 'app_focus'
```

在现有"2) 久坐提醒"分支（`if (input.trigger === 'break_reminder') { ... }`）之后、"3) AFK 离开"分支之前插入：
```ts
  // 2.5) 应用焦点感知：主进程已完成匹配+双层冷却过滤，到这里的都是"确定要说"；
  // 调用方已在同一 tick 内叫醒宠物（若需要），同 break_reminder
  if (input.trigger === 'app_focus') {
    next = { ...next, chatterTimerMs: Math.max(next.chatterTimerMs, cfg.globalCooldownMs) }
    return { ctx: next, output: { speak: 'app_focus' } }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: PASS（全部用例，含既有回归）

- [ ] **Step 5: 提交**

```bash
git add src/shared/reactionPlanner.ts src/shared/reactionPlanner.test.ts
git commit -m "feat(reaction): reactionPlanner 新增 app_focus 触发与分类"
```

---

### Task 7: IPC 契约扩展——`ContextSignalKind` 新增 `'app_focus'`

**Files:**
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Produces: `ContextSignalKind = 'afk_leave' | 'break_reminder' | 'app_focus'`（供 Task 8/9 使用）

- [ ] **Step 1: 实现**

编辑 `src/shared/ipc.ts` 第 76-77 行：

```ts
/** 主进程情境信号(main→renderer 推送):AFK 离开 / 久坐提醒 / 应用焦点感知，均为一次性边沿事件 */
export type ContextSignalKind = 'afk_leave' | 'break_reminder' | 'app_focus'
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无报错（这是纯类型扩展，联合类型加宽，不会破坏任何现有 `switch`/判等代码——项目里目前只有 `petController.ts` 对具体值做判等，Task 8 会更新它）

- [ ] **Step 3: 提交**

```bash
git add src/shared/ipc.ts
git commit -m "feat(ipc): ContextSignalKind 新增 app_focus"
```

---

### Task 8: `petController` 扩展——`app_focus` 命中睡眠中的宠物时同 tick 叫醒

**Files:**
- Modify: `src/renderer/petController.ts:68`

**Interfaces:**
- Consumes: `ContextSignalKind`（Task 7，含 `'app_focus'`）、`stepReaction` 对 `trigger:'app_focus'` 的处理（Task 6）

**说明**：本文件目前没有对应的 Vitest 测试文件（`tick()` 依赖 `window.setInterval`/`performance.now()`，历史上一直靠 `pnpm dev`/`pnpm preview` 真机验收，未建单测基建——与仓库里"无 Electron GUI 自动化驱动"的既有惯例一致，本任务不新增测试基建，沿用现状）。

- [ ] **Step 1: 实现**

编辑 `src/renderer/petController.ts` 第 66-68 行，把：

```ts
    // 久坐提醒命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的 wokeUp 派生
    // 把更具体的 break 台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if (contextSignal === 'break_reminder' && this.ctx.state === 'sleep') event = 'wake'
```

改为：

```ts
    // 久坐提醒/应用焦点感知命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的
    // wokeUp 派生把更具体的台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if ((contextSignal === 'break_reminder' || contextSignal === 'app_focus') && this.ctx.state === 'sleep') event = 'wake'
```

- [ ] **Step 2: 类型检查与构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无报错

- [ ] **Step 3: 提交**

```bash
git add src/renderer/petController.ts
git commit -m "feat(pet): app_focus 命中睡眠中的宠物时同 tick 内先叫醒"
```

---

### Task 9: `shell/index.ts` 接线——挂载 `appFocusWatcher` + `PET_SPEAK` 特判

**Files:**
- Modify: `src/main/shell/index.ts:40`（import）
- Modify: `src/main/shell/index.ts:210`（新增状态变量）
- Modify: `src/main/shell/index.ts:294`（挂载）
- Modify: `src/main/shell/index.ts:641-649`（`PET_SPEAK` 处理器）
- Modify: `src/main/shell/index.ts:920`（`will-quit` 清理）

**Interfaces:**
- Consumes: `startAppFocusWatcher`（Task 5）、`ContextSignalKind`（Task 7，`IPC.CONTEXT_SIGNAL` 推送 `'app_focus'`）

**说明**：`shell/index.ts` 是一个大的接线文件，没有针对其内部逻辑的 Vitest（其余 IPC 处理器同样如此），靠 `pnpm typecheck`/`pnpm build` + `pnpm preview` 真机验收，与既有惯例一致。

- [ ] **Step 1: 新增 import**

编辑 `src/main/shell/index.ts` 第 40 行，在 `import { startIdleWatcher } from '../context/idleWatcher'` 之后追加：

```ts
import { startAppFocusWatcher } from '../context/appFocusWatcher'
```

- [ ] **Step 2: 新增状态变量**

编辑第 210 行附近，把：

```ts
  let lastLineText: string | null = null // 供 pickLine 避免连续复读
```

改为：

```ts
  let lastLineText: string | null = null // 供 pickLine 避免连续复读
  let pendingAppFocusText: string | null = null // appFocusWatcher 已选好的台词，PET_SPEAK('app_focus') 特判读取
```

- [ ] **Step 3: 挂载 `appFocusWatcher`**

编辑第 294 行附近（`createAutomationControl({...})` 调用的闭合 `})` 之后），追加：

```ts
  const appFocusWatcher = startAppFocusWatcher(petDir, {
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    onMatch: (line) => {
      if (dialog.isOpen()) return // 对话框开着不触发，与 showAmbientLine 的兜底一致
      pendingAppFocusText = line.text
      petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')
    }
  })
```

- [ ] **Step 4: `PET_SPEAK` 处理器新增特判**

编辑第 641-649 行，把：

```ts
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = pickLine(loadLines(petDir), category, lastLineText ?? undefined)
    if (!line) return // lines.json 缺失或该 category 为空 → 静默降级
    lastLineText = line.text
    showAmbientLine(line.text)
  })
```

改为：

```ts
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = category === 'app_focus'
      ? (pendingAppFocusText ? { text: pendingAppFocusText } : null)
      : pickLine(loadLines(petDir), category, lastLineText ?? undefined)
    if (category === 'app_focus') pendingAppFocusText = null
    if (!line) return // lines.json 缺失/该 category 为空/app_focus 无暂存台词 → 静默降级
    lastLineText = line.text
    showAmbientLine(line.text)
  })
```

- [ ] **Step 5: `will-quit` 清理**

编辑第 920 行，把：

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close(); voiceSidecarInstance?.stop() })
```

改为：

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); appFocusWatcher.stop(); void browserControl.close(); voiceSidecarInstance?.stop() })
```

- [ ] **Step 6: 类型检查与构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无报错

- [ ] **Step 7: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 接入 appFocusWatcher，PET_SPEAK 新增 app_focus 特判"
```

---

### Task 10: `luluka` 宠物包起草 `app_focus` 示例规则

**Files:**
- Modify: `pets/luluka/lines.json`（磁盘直改，`.gitignore` 覆盖，**不要** `git add`/`git commit` 这个文件）

**说明**：这是设计文档 §12 里提到的"先在设计/计划阶段为 luluka 起草几条示例规则供确认"。其余宠物包（alice/alice_0/juwang/shiraishi-mio/youka）照各自人设摹写留给后续（非本计划阻塞项，可在真机验收时按需追加）。

- [ ] **Step 1: 编辑 `pets/luluka/lines.json`**

在现有 `"farewell": [...]` 数组（文件倒数第二个分类）后面追加一个新分类 `app_focus`。把文件末尾的：

```json
  "farewell": [
    { "text": "……去吧。我等你回来。" },
    { "text": "记得带冰淇淋。" }
  ]
}
```

改为：

```json
  "farewell": [
    { "text": "……去吧。我等你回来。" },
    { "text": "记得带冰淇淋。" }
  ],

  "app_focus": [
    {
      "match": ["code.exe", "visual studio code"],
      "lines": [
        { "text": "……又在写代码。线索都在 bug 里。" },
        { "text": "键盘敲这么响,遇到麻烦了?" }
      ]
    },
    {
      "match": ["chrome.exe", "msedge.exe"],
      "lines": [
        { "text": "……在查什么案子?" },
        { "text": "别看太久,眼睛会花。" }
      ]
    }
  ]
}
```

- [ ] **Step 2: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('pets/luluka/lines.json','utf-8')); console.log('valid')"`
Expected: 输出 `valid`

- [ ] **Step 3: 不提交**

此文件被 `.gitignore` 忽略，`git status` 里看不到它——确认 `git status` 输出中不包含 `pets/luluka/lines.json` 即可，无需（也无法）提交。

---

### Task 11: 全量回归 + 真机验收清单

**Files:** 无新增/修改（验证性任务）

- [ ] **Step 1: 全量类型检查/测试/构建**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 三者均通过；`pnpm test` 应比 Task 1 开始前多出 Task 1/2/3/4/6 新增的用例且全绿

- [ ] **Step 2: 冒烟启动**

Run: `pnpm preview`
Expected: 窗口正常显示宠物 idle 动画，无崩溃

- [ ] **Step 3: 真机验收清单（需要真实 Windows 前台窗口切换，人工完成）**

- [ ] 切到 `pets/luluka/lines.json` 里配置了 `app_focus` 规则的应用（真实打开 VS Code / Chrome）→ 冒出对应台词
- [ ] 快速 alt-tab 在多个白名单应用间切换 → 不刷屏（`minGapMs=20s` 生效）
- [ ] 反复切回同一个应用 → 短期内（15 分钟内）不重复念叨；等冷却过了再切回会重新触发
- [ ] 宠物睡着时切到白名单应用 → 先醒来再吐槽（同"久坐提醒"手感）
- [ ] 对话框开着时切应用 → 静默
- [ ] 把当前宠物切换成没有配置 `app_focus` 规则的宠物包 → 任务管理器里确认没有额外的高频 `powershell.exe` 进程（验证"没配置就不启动轮询"）

- [ ] **Step 4: 如验收中发现问题，修复后重新提交；全部通过后本计划完成**
