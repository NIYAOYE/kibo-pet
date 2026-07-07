# MVP-13 台词引擎 + 点击反应 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌宠自主在气泡里冒口癖台词（idle/long_idle/wake），并对双击（戳）、拖起做出台词反应，全部本地、零外部依赖。

**Architecture:** Approach A —— 一个纯函数 `reactionPlanner`（`src/shared`，仿 `petBrain` 的 reducer 风格）决定"是否说话、说哪一类 category"；主进程 `linesLoader` 从宠物包 `lines.json` 选词并复用现有跟随气泡窗以瞬态方式显示；渲染层 `petController` 每 tick 驱动 planner，`main.ts` 采集双击/拖拽手势。planner 输出 category 而非文本，文本留在宠物包。

**Tech Stack:** Electron（CJS 主进程/preload）· electron-vite · TypeScript(strict) · Vitest · `@shared/*` 路径别名。

## Global Constraints

- 包管理器 **pnpm**；**绝不**给 `package.json` 加 `"type":"module"`（会让 Electron 主进程崩）。
- 跨进程值一律走 `src/shared` + `@shared/*` 别名；**绝不硬编码 IPC 通道字符串**，只用 `IPC` 常量。
- 新增 IPC 能力要四处同步：`src/shared/ipc.ts`（常量 + 类型）、主进程处理器、`src/preload/index.ts`（暴露）、渲染层调用。
- 所有 `ipcMain.on/handle` 的 payload 必须经 `src/shared/ipcValidation.ts` 校验后再用。
- 纯逻辑 TDD（先写失败测试）；GUI/Electron 接线由真机 `pnpm dev`/`pnpm preview` 肉眼验收（本仓库无 Electron GUI 自动化驱动）。
- 提交粒度：每任务一提交，conventional-commit 风格，**提交信息用中文**。
- `pets/luluka`（含 `lines.json`）被 `.gitignore`，仅在磁盘 —— 读它按路径读；给它加内容需在磁盘副本上做。
- 本 MVP **不碰配音**：`audio` 字段读入但不播放。

---

### Task 1: reactionPlanner（纯函数，shared）

决定"是否说话、说哪一类"。无 I/O、无文本，纯 reducer，可单测。

**Files:**
- Create: `src/shared/reactionPlanner.ts`
- Test: `src/shared/reactionPlanner.test.ts`

**Interfaces:**
- Produces:
  - `type ReactionCategory = 'idle' | 'long_idle' | 'wake' | 'click' | 'drag'`
  - `const REACTION_CATEGORIES: ReactionCategory[]`（运行时校验用，单一真源）
  - `type ReactionTrigger = 'poke' | 'drag' | 'wake'`
  - `interface ReactionConfig`、`const DEFAULT_REACTION_CONFIG: ReactionConfig`
  - `interface ReactionCtx`、`interface ReactionInput`、`interface ReactionOutput { speak?: ReactionCategory }`
  - `function initReaction(config?: Partial<ReactionConfig>): ReactionCtx`
  - `function stepReaction(ctx: ReactionCtx, input: ReactionInput): { ctx: ReactionCtx; output: ReactionOutput }`

- [ ] **Step 1: 写失败测试**

`src/shared/reactionPlanner.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { initReaction, stepReaction, DEFAULT_REACTION_CONFIG, REACTION_CATEGORIES } from './reactionPlanner'

const cfg = { idleChatterMinMs: 1000, idleChatterMaxMs: 1000, longIdleAfterMs: 2000, eventCooldownMs: 500, globalCooldownMs: 3000 }
const rng = (): number => 0 // 确定性：randRange 取下界

describe('reactionPlanner', () => {
  it('REACTION_CATEGORIES 覆盖全部 category', () => {
    expect(REACTION_CATEGORIES).toEqual(['idle', 'long_idle', 'wake', 'click', 'drag'])
  })

  it('idle 闲聊在 chatterTimer 归零那一刻触发并重置', () => {
    let ctx = initReaction(cfg) // chatterTimerMs 初值 = idleChatterMinMs = 1000
    // 分两小步推进跨过阈值，确保"刚到点即触发"（非严格 >0 过滤盲区）
    let r = stepReaction(ctx, { dtMs: 600, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined()
    r = stepReaction(ctx, { dtMs: 600, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('idle')
    expect(ctx.chatterTimerMs).toBe(1000) // 重置
  })

  it('paused 时完全不冒话', () => {
    let ctx = initReaction(cfg)
    const r = stepReaction(ctx, { dtMs: 5000, paused: true, rng })
    expect(r.output.speak).toBeUndefined()
  })

  it('poke → click；冷却内第二次 poke 被吞', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click')
    r = stepReaction(ctx, { dtMs: 100, trigger: 'poke', paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined() // eventCooldown 未过
    r = stepReaction(ctx, { dtMs: 500, trigger: 'poke', paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click') // 冷却已过
  })

  it('drag trigger → drag', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'drag', paused: false, rng })
    expect(r.output.speak).toBe('drag')
  })

  it('long_idle 每段静置只冒一次；trigger 重置后可再冒', () => {
    let ctx = initReaction({ ...cfg, idleChatterMinMs: 100000, idleChatterMaxMs: 100000 }) // 推高 chatter 避免干扰
    let r = stepReaction(ctx, { dtMs: 2000, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('long_idle')
    r = stepReaction(ctx, { dtMs: 2000, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined() // 不重复
    // 一次触碰重置 idle 计时与 long_idle 标志
    r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', paused: false, rng }); ctx = r.ctx
    expect(ctx.idleSinceMs).toBe(0)
    r = stepReaction(ctx, { dtMs: 2000, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('long_idle')
  })

  it('触碰后不会立刻接着冒 idle 闲聊', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click')
    // chatterTimer 被抬到至少 globalCooldownMs=3000；推进原本会触发的 1000ms 不应冒 idle
    r = stepReaction(ctx, { dtMs: 1000, paused: false, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined()
  })

  it('DEFAULT_REACTION_CONFIG 有合理默认', () => {
    expect(DEFAULT_REACTION_CONFIG.globalCooldownMs).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: FAIL（`Cannot find module './reactionPlanner'`）

- [ ] **Step 3: 写实现**

`src/shared/reactionPlanner.ts`：
```ts
export type ReactionCategory = 'idle' | 'long_idle' | 'wake' | 'click' | 'drag'
export const REACTION_CATEGORIES: ReactionCategory[] = ['idle', 'long_idle', 'wake', 'click', 'drag']

/** 用户触碰/唤醒产生的即时触发；idle/long_idle 是环境定时，不走这里 */
export type ReactionTrigger = 'poke' | 'drag' | 'wake'

export interface ReactionConfig {
  globalCooldownMs: number   // 触碰后压制 idle 闲聊的最短间隔
  eventCooldownMs: number    // 两句触碰台词间的最短间隔（防连点刷屏）
  idleChatterMinMs: number   // idle 闲聊间隔下界
  idleChatterMaxMs: number   // idle 闲聊间隔上界
  longIdleAfterMs: number    // 无交互多久后冒一次 long_idle
}

export const DEFAULT_REACTION_CONFIG: ReactionConfig = {
  globalCooldownMs: 25000,
  eventCooldownMs: 4000,
  idleChatterMinMs: 40000,
  idleChatterMaxMs: 90000,
  longIdleAfterMs: 30000
}

export interface ReactionCtx {
  eventCooldownMs: number
  chatterTimerMs: number
  idleSinceMs: number
  longIdleSpoken: boolean
  config: ReactionConfig
}

export interface ReactionInput {
  dtMs: number
  trigger?: ReactionTrigger
  paused: boolean
  rng: () => number
}

export interface ReactionOutput { speak?: ReactionCategory }

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

export function initReaction(config: Partial<ReactionConfig> = {}): ReactionCtx {
  const cfg = { ...DEFAULT_REACTION_CONFIG, ...config }
  return {
    eventCooldownMs: 0,
    // 首个闲聊间隔用下界（确定、无需 rng）；之后每次重置带抖动
    chatterTimerMs: cfg.idleChatterMinMs,
    idleSinceMs: 0,
    longIdleSpoken: false,
    config: cfg
  }
}

export function stepReaction(
  ctx: ReactionCtx,
  input: ReactionInput
): { ctx: ReactionCtx; output: ReactionOutput } {
  const cfg = ctx.config
  let next: ReactionCtx = {
    ...ctx,
    eventCooldownMs: Math.max(0, ctx.eventCooldownMs - input.dtMs),
    chatterTimerMs: Math.max(0, ctx.chatterTimerMs - input.dtMs),
    idleSinceMs: ctx.idleSinceMs + input.dtMs
  }

  // 任何触碰都重置 idle 计时并重新武装 long_idle
  if (input.trigger) next = { ...next, idleSinceMs: 0, longIdleSpoken: false }

  // 对话框打开（paused）：闭嘴，跟随气泡让位给聊天回复
  if (input.paused) return { ctx: next, output: {} }

  // 1) 触碰/唤醒：最高优先级，短冷却防连点刷屏
  if (input.trigger) {
    if (next.eventCooldownMs > 0) return { ctx: next, output: {} }
    const cat: ReactionCategory = input.trigger === 'poke' ? 'click' : input.trigger
    next = {
      ...next,
      eventCooldownMs: cfg.eventCooldownMs,
      // 触碰后别紧接着冒 idle 闲聊
      chatterTimerMs: Math.max(next.chatterTimerMs, cfg.globalCooldownMs)
    }
    return { ctx: next, output: { speak: cat } }
  }

  // 2) 长时间静置：每段只冒一次
  if (!next.longIdleSpoken && next.idleSinceMs >= cfg.longIdleAfterMs) {
    next = {
      ...next,
      longIdleSpoken: true,
      chatterTimerMs: randRange(input.rng, cfg.idleChatterMinMs, cfg.idleChatterMaxMs)
    }
    return { ctx: next, output: { speak: 'long_idle' } }
  }

  // 3) idle 闲聊：定时冒话
  if (next.chatterTimerMs <= 0) {
    next = { ...next, chatterTimerMs: randRange(input.rng, cfg.idleChatterMinMs, cfg.idleChatterMaxMs) }
    return { ctx: next, output: { speak: 'idle' } }
  }

  return { ctx: next, output: {} }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: 提交**

```bash
git add src/shared/reactionPlanner.ts src/shared/reactionPlanner.test.ts
git commit -m "feat(reaction): 新增纯函数台词反应规划器 reactionPlanner"
```

---

### Task 2: linesLoader（主进程读宠物包 lines.json）

解析 `lines.json` 成 `{category: Line[]}` 并按 category 随机选词（可避重）。仿 `personaLoader` 的缓存 + 容错风格。

**Files:**
- Create: `src/main/lines/linesLoader.ts`
- Test: `src/main/lines/linesLoader.test.ts`

**Interfaces:**
- Consumes: `ReactionCategory` from `@shared/reactionPlanner`（Task 1）
- Produces:
  - `interface Line { text: string; audio?: string }`
  - `type LinesTable = Partial<Record<ReactionCategory, Line[]>> & { greet?: Line[] }`
  - `function parseLines(raw: string): LinesTable`
  - `function loadLines(petDir: string): LinesTable`（缓存）
  - `function pickLine(table: LinesTable, category: ReactionCategory, avoidText?: string, rng?: () => number): Line | null`

- [ ] **Step 1: 写失败测试**

`src/main/lines/linesLoader.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { parseLines, pickLine } from './linesLoader'

describe('parseLines', () => {
  it('解析合法台词表并跳过 _about 元数据', () => {
    const raw = JSON.stringify({
      _about: '说明',
      idle: [{ text: 'a' }, { text: 'b', audio: 'voice/b.wav' }],
      click: [{ text: 'c' }]
    })
    const t = parseLines(raw)
    expect(t.idle).toEqual([{ text: 'a' }, { text: 'b', audio: 'voice/b.wav' }])
    expect(t.click).toEqual([{ text: 'c' }])
    expect((t as Record<string, unknown>)._about).toBeUndefined()
  })

  it('坏 JSON → 空表', () => {
    expect(parseLines('{ not json')).toEqual({})
  })

  it('跳过非数组值与缺 text 的条目', () => {
    const raw = JSON.stringify({ idle: 'x', wake: [{ nope: 1 }, { text: 'ok' }] })
    const t = parseLines(raw)
    expect(t.idle).toBeUndefined()
    expect(t.wake).toEqual([{ text: 'ok' }])
  })
})

describe('pickLine', () => {
  const table = { idle: [{ text: 'a' }, { text: 'b' }] }
  it('空/缺 category → null', () => {
    expect(pickLine({}, 'idle')).toBeNull()
    expect(pickLine(table, 'click')).toBeNull()
  })
  it('rng 决定选中项', () => {
    expect(pickLine(table, 'idle', undefined, () => 0)).toEqual({ text: 'a' })
    expect(pickLine(table, 'idle', undefined, () => 0.99)).toEqual({ text: 'b' })
  })
  it('avoidText 时避开上一句', () => {
    expect(pickLine(table, 'idle', 'a', () => 0)).toEqual({ text: 'b' })
  })
  it('只有一条时即便命中 avoidText 也返回它', () => {
    expect(pickLine({ idle: [{ text: 'a' }] }, 'idle', 'a')).toEqual({ text: 'a' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: FAIL（`Cannot find module './linesLoader'`）

- [ ] **Step 3: 写实现**

`src/main/lines/linesLoader.ts`：
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactionCategory } from '@shared/reactionPlanner'

export interface Line { text: string; audio?: string }
export type LinesTable = Partial<Record<ReactionCategory, Line[]>> & { greet?: Line[] }

export function parseLines(raw: string): LinesTable {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return {} }
  if (typeof data !== 'object' || data === null) return {}
  const out: Record<string, Line[]> = {}
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith('_')) continue // 跳过 _about 等元数据键
    if (!Array.isArray(val)) continue
    const lines: Line[] = []
    for (const item of val) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec.text !== 'string') continue
      const line: Line = { text: rec.text }
      if (typeof rec.audio === 'string') line.audio = rec.audio
      lines.push(line)
    }
    if (lines.length > 0) out[key] = lines
  }
  return out as LinesTable
}

const cache = new Map<string, LinesTable>()

export function loadLines(petDir: string): LinesTable {
  const cached = cache.get(petDir)
  if (cached) return cached
  let table: LinesTable
  try { table = parseLines(readFileSync(join(petDir, 'lines.json'), 'utf-8')) }
  catch { table = {} }
  cache.set(petDir, table)
  return table
}

export function pickLine(
  table: LinesTable,
  category: ReactionCategory,
  avoidText?: string,
  rng: () => number = Math.random
): Line | null {
  const lines = table[category]
  if (!lines || lines.length === 0) return null
  const pool = lines.length > 1 && avoidText ? lines.filter((l) => l.text !== avoidText) : lines
  const candidates = pool.length > 0 ? pool : lines
  return candidates[Math.floor(rng() * candidates.length)] ?? null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/lines/linesLoader.ts src/main/lines/linesLoader.test.ts
git commit -m "feat(lines): 新增宠物包 lines.json 加载与选词 linesLoader"
```

---

### Task 3: IPC 契约 + payload 校验

新增 `PET_SPEAK`（renderer→main，携带 category）与 `BUBBLE_LINE`（main→bubble 渲染层，携带纯文本一句）两个通道，接好类型、preload 暴露、校验函数。

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcValidation.ts`
- Modify: `src/preload/index.ts`
- Test: `src/shared/ipcValidation.test.ts`（若不存在则新建）

**Interfaces:**
- Consumes: `REACTION_CATEGORIES`, `ReactionCategory` from `@shared/reactionPlanner`（Task 1）
- Produces:
  - `IPC.PET_SPEAK = 'pet:speak'`、`IPC.BUBBLE_LINE = 'bubble:line'`
  - `PetApi.petSpeak(category: ReactionCategory): void`
  - `BubbleApi.onLine(cb: (text: string) => void): void`
  - `validateReactionCategory(v: unknown): ReactionCategory | null`

- [ ] **Step 1: 写失败测试（校验函数）**

若 `src/shared/ipcValidation.test.ts` 不存在则新建；存在则追加此 describe：
```ts
import { describe, it, expect } from 'vitest'
import { validateReactionCategory } from './ipcValidation'

describe('validateReactionCategory', () => {
  it('接受合法 category', () => {
    expect(validateReactionCategory('idle')).toBe('idle')
    expect(validateReactionCategory('click')).toBe('click')
  })
  it('拒绝非法/非字符串', () => {
    expect(validateReactionCategory('nope')).toBeNull()
    expect(validateReactionCategory(123)).toBeNull()
    expect(validateReactionCategory(null)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL（`validateReactionCategory is not a function`）

- [ ] **Step 3a: 改 `src/shared/ipc.ts`**

在 `import type { TodoItem } from './todo'` 下方加一行导入：
```ts
import type { ReactionCategory } from './reactionPlanner'
```
在 `IPC` 常量对象里（`BUBBLE_PLACE` 之后）加两个通道：
```ts
  BUBBLE_PLACE: 'bubble:place',
  BUBBLE_LINE: 'bubble:line',
  PET_SPEAK: 'pet:speak'
```
（注意把原本 `BUBBLE_PLACE` 行尾补逗号）
在 `PetApi` 接口里，`quit(): void` 之前加：
```ts
  /** 自主/触碰反应：请求主进程按 category 选一句台词，用瞬态气泡显示 */
  petSpeak(category: ReactionCategory): void
```
在 `BubbleApi` 接口里，`onPlace` 之后加：
```ts
  onLine(cb: (text: string) => void): void
```
在文件末尾的 `export type { PetEvent, Bounds }` 附近补一行再导出，供消费方引用：
```ts
export type { ReactionCategory } from './reactionPlanner'
```

- [ ] **Step 3b: 改 `src/shared/ipcValidation.ts`**

顶部加导入：
```ts
import { REACTION_CATEGORIES, type ReactionCategory } from './reactionPlanner'
```
文件末尾加：
```ts
export function validateReactionCategory(v: unknown): ReactionCategory | null {
  return typeof v === 'string' && (REACTION_CATEGORIES as string[]).includes(v)
    ? (v as ReactionCategory)
    : null
}
```

- [ ] **Step 3c: 改 `src/preload/index.ts`**

在 `petApi` 对象里 `quit` 之前加：
```ts
  petSpeak: (category): void => ipcRenderer.send(IPC.PET_SPEAK, category),
```
（`category` 的类型由 `PetApi` 推断，无需显式标注；若 strict 报错则写 `(category: import('@shared/ipc').ReactionCategory)`。）
在 `bubbleApi` 对象里 `onPlace` 之后加：
```ts
  ,
  onLine: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_LINE)
    ipcRenderer.on(IPC.BUBBLE_LINE, (_e, text: string) => cb(text))
  }
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts && pnpm typecheck`
Expected: 测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts src/preload/index.ts
git commit -m "feat(ipc): 新增 PET_SPEAK/BUBBLE_LINE 通道与 category 校验"
```

---

### Task 4: 气泡瞬态显示模式

给跟随气泡窗加 `pushLine`（定格纯文本一句），渲染层加 `onLine` 处理器。auto-hide 定时器由主进程持有（Task 5），本任务只做"能显示一句纯文本"。

**Files:**
- Modify: `src/main/shell/bubbleWindow.ts`
- Modify: `src/renderer/bubble.ts`

**Interfaces:**
- Consumes: `IPC.BUBBLE_LINE`（Task 3）、`bubbleApi.onLine`（Task 3）
- Produces: `BubbleController.pushLine(text: string): void`（加进 `BubbleController` 接口 + 实现）

- [ ] **Step 1: 改 `src/main/shell/bubbleWindow.ts`**

在 `BubbleController` 接口里，`clear(): void` 之后加：
```ts
  pushLine(text: string): void
```
在 `return { ... }` 里，`clear:` 之后加：
```ts
    clear: () => win.webContents.send(IPC.BUBBLE_CLEAR),
    pushLine: (t) => win.webContents.send(IPC.BUBBLE_LINE, t)
```
（把原本 `clear:` 行尾补逗号。）

- [ ] **Step 2: 改 `src/renderer/bubble.ts`**

在 `window.bubbleApi.onClear(() => clear())` 之后加：
```ts
// 自主/触碰台词：定格一句纯文本（非流式、非 Markdown 富渲染），auto-hide 由主进程控
window.bubbleApi.onLine((text) => {
  clear()
  box.textContent = text
})
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误（`pushLine` 已在接口与实现中；`bubble.html` 的 `#box` 用 `textContent` 即可显示，无需改 html）。

- [ ] **Step 4: 提交**

```bash
git add src/main/shell/bubbleWindow.ts src/renderer/bubble.ts
git commit -m "feat(bubble): 气泡窗新增 pushLine 瞬态纯文本显示"
```

---

### Task 5: 主进程接线 —— PET_SPEAK 处理器 + 瞬态气泡生命周期

收到 `PET_SPEAK` → 对话框开着则丢弃 → 否则选词 → 显示瞬态气泡 + 定时隐藏；聊天开始时取消该定时器。

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `loadLines`, `pickLine` from `../lines/linesLoader`（Task 2）；`validateReactionCategory` from `@shared/ipcValidation`（Task 3）；`IPC.PET_SPEAK`（Task 3）；`bubble.pushLine`（Task 4）；已存在的 `bubble`, `dialog`, `petBoundsFull`, `petWorkArea`, `emitPetEvent`。

- [ ] **Step 1: 加导入**

在 `import { listPets, importPetFolder } from '../pets/petCatalog'` 之后加：
```ts
import { loadLines, pickLine } from '../lines/linesLoader'
```
在 `ipcValidation` 的解构导入里追加 `validateReactionCategory`：
```ts
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS,
  validateReactionCategory
} from '@shared/ipcValidation'
```

- [ ] **Step 2: 加瞬态气泡状态与函数**

在 `let bubbleHasContent = false` 之后加：
```ts
  const AMBIENT_TTL_MS = 3500
  let ambientHideTimer: NodeJS.Timeout | null = null
  let lastLineText: string | null = null // 供 pickLine 避免连续复读

  function clearAmbientLine(): void {
    if (ambientHideTimer) { clearTimeout(ambientHideTimer); ambientHideTimer = null }
  }
  function showAmbientLine(text: string): void {
    if (dialog.isOpen()) return // 对话框开着：气泡让位给聊天（planner 已抑制，这里再兜一道）
    clearAmbientLine()
    bubble.clear()
    bubble.pushLine(text)
    bubble.show(petBoundsFull(), petWorkArea())
    ambientHideTimer = setTimeout(() => { ambientHideTimer = null; bubble.hide() }, AMBIENT_TTL_MS)
  }
```

- [ ] **Step 3: 聊天开始时取消瞬态气泡定时器**

在 `emitPetEvent` 函数体里，`if (event === 'messageSent') { ... }` 那行改为先取消瞬态定时器：
```ts
  function emitPetEvent(event: PetEvent): void {
    petWin.webContents.send(IPC.PET_EVENT, event)
    if (event === 'messageSent') { clearAmbientLine(); bubbleHasContent = false; bubble.clear(); bubble.hide() }
  }
```
在 `dialog` 的 `onOpened` 回调里，最前面加一行 `clearAmbientLine()`：
```ts
    onOpened: () => {
      clearAmbientLine()
      emitPetEvent('dialogOpen')
      dialog.pushUpdate(chat.messages())
      refreshBubble()
    },
```

- [ ] **Step 4: 注册 PET_SPEAK 处理器**

在 `ipcMain.on(IPC.CANCEL_CHAT, () => chat.cancel())` 之后加：
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

- [ ] **Step 5: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 接线 PET_SPEAK 与瞬态气泡生命周期"
```

---

### Task 6: 渲染层驱动 —— planner 接入 + 双击/拖拽手势

`petController` 每 tick 驱动 `reactionPlanner` 并在 `speak` 时调 `petApi.petSpeak`；`main.ts` 加双击判别（单击仍开对话框，双击=戳）。拖起复用现有 `pickup` 事件映射为 `drag` 触发。

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `initReaction`, `stepReaction`, `ReactionCtx`, `ReactionTrigger` from `@shared/reactionPlanner`（Task 1）；`petApi.petSpeak`（Task 3）
- Produces: `PetController.poke(): void`

- [ ] **Step 1: 改 `src/renderer/petController.ts`**

顶部导入改为：
```ts
import { SpritePlayer } from './spritePlayer'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
```
在类字段区（`private currentAnim = ''` 之后）加：
```ts
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null
```
加公有方法（放在 `send` 方法附近）：
```ts
  /** 双击=戳：下一 tick 喂给反应规划器 */
  poke(): void { this.pendingReaction = 'poke' }
```
把 `tick()` 改为（在原有动画/移动逻辑后追加反应驱动）：
```ts
  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now
    const event = this.pending.shift()
    if (event === 'pickup') this.pendingReaction = 'drag' // 拖起 → drag 台词
    const prevState = this.ctx.state
    const { ctx, effects } = step(this.ctx, {
      dtMs,
      event,
      bounds: this.workArea,
      windowX: this.windowX,
      windowWidth: this.windowWidth,
      rng: Math.random
    })
    this.ctx = ctx
    if (effects.animation !== this.currentAnim) {
      const startedWalking = effects.animation.startsWith('walk') && !this.currentAnim.startsWith('walk')
      this.player.play(effects.animation)
      this.currentAnim = effects.animation
      if (startedWalking) void this.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    }
    if (effects.move !== 0) {
      window.petApi.moveWindow({ dx: effects.move, dy: 0, clamp: true })
      this.windowX += effects.move
    }

    // 反应规划器:每 tick 一个触发,睡→醒(wake)优先于本 tick 的触碰
    const wokeUp = prevState === 'sleep' && this.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined = wokeUp ? 'wake' : (this.pendingReaction ?? undefined)
    this.pendingReaction = null
    const r = stepReaction(this.reactionCtx, { dtMs, trigger, paused: this.ctx.paused, rng: Math.random })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
```

- [ ] **Step 2: 改 `src/renderer/main.ts`（双击判别）**

在 `const DRAG_THRESHOLD = 4` 之后加：
```ts
const DBLCLICK_MS = 280
```
在 `boot()` 里的拖拽状态变量区（`let downY = 0` 之后）加：
```ts
  let clickTimer: number | null = null
```
把 `mouseup` 监听器里的 `else` 分支（原为 `window.petApi.toggleDialog()`）改为双击判别：
```ts
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved) {
      controller.send('drop')
      controller.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    } else {
      // 单击 → 开/关对话框;双击 → 戳(poke)。用短延时判别,双击时撤销开框
      if (clickTimer !== null) {
        clearTimeout(clickTimer); clickTimer = null
        controller.poke()
      } else {
        clickTimer = window.setTimeout(() => { clickTimer = null; window.petApi.toggleDialog() }, DBLCLICK_MS)
      }
    }
  })
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 4: 全量测试回归**

Run: `pnpm test`
Expected: 全绿（Task 1/2/3 新增用例 + 既有全部通过）。

- [ ] **Step 5: 真机 GUI 肉眼验收（人工）**

Run: `pnpm dev`（或 `pnpm build && pnpm preview`）。逐条确认：
- [ ] 静置约 40s 后,宠物在气泡里自主冒一句 idle 台词,约 3.5s 后气泡消失。
- [ ] 更长时间无交互会冒一次 long_idle 台词（如"……你还在吗?"）。
- [ ] 双击宠物 → 冒一句 click 台词（如"戳我也没冰淇淋。"）;快速连点不刷屏（受 4s 冷却）。
- [ ] 拖起宠物 → 冒一句 drag 台词（如"别晃,会洒的。"）。
- [ ] **单击仍正常开/关对话框**（约 280ms 后打开,可接受的判别延迟）。
- [ ] 对话框打开期间不冒任何自主台词;关掉后恢复。
- [ ] 发消息、回复流式期间,自主台词不会抢占/顶掉回复气泡。
- [ ] 临时把磁盘上 `pets/luluka/lines.json` 改名再启动 → 不冒台词、不报错、不崩（优雅降级）;验收后改回。
- [ ] （最终整支审查追加,UX 手感确认非阻塞项）宠物进入 sleep 后是否仍会冒 idle 闲聊 —— reactionPlanner 与 petBrain 故意解耦,sleep 不置 paused,当前设计下会冒;按感觉决定是否留后续 MVP 接入抑制。
- [ ] （同上追加）戳/拖起睡眠中的宠物,冒出的是 wake 台词而非 click/drag —— 代码内注释已声明为有意行为（睡醒优先级最高）;确认这符合预期。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/petController.ts src/renderer/main.ts
git commit -m "feat(pet): 接入台词反应规划器与双击戳/拖起手势"
```

---

## 完成后

- 更新 `PROGRESS.md` 与 `ROADMAP.md`:标注 MVP-13 代码完成、待真机验收（承接"让它活起来"系列脊柱）。
- 用 superpowers:finishing-a-development-branch 收尾（合并/PR 决策）。
- 后续 MVP:配音播放（`audio` 字段）、情境感知触发源（时间/焦点）、情绪数值 —— 各自独立 brainstorming→plan。

## Self-Review

**Spec 覆盖**（对照 `2026-07-07-mvp-13-reaction-lines-and-touch.md`）
- §3 四单元:reactionPlanner=Task1、linesLoader=Task2、手势层=Task6、气泡瞬态=Task4+5 ✅
- §4 planner 三护栏(全局冷却/暂停抑制/不复读):冷却+paused 在 Task1 planner；不复读在 Task2 `pickLine` avoidText + Task5 `lastLineText` ✅
- §5 手势映射(单击不变/双击戳/拖起 drag/自主 idle·long_idle·wake):Task6 ✅
- §6 瞬态气泡+抑制+降级+防竞态:Task4(pushLine/onLine)+Task5(showAmbientLine/clearAmbientLine/dialog.isOpen 抑制/lines 缺失 null 降级) ✅
- §7 IPC 四文件:Task3(ipc/validation/preload)+Task5(main 处理器) ✅
- §8 测试:planner/linesLoader 单测(Task1/2)、validation 单测(Task3)、GUI 验收清单(Task6 Step5) ✅
- §2 非目标(不碰配音):`audio` 读入不播,全程无播放代码 ✅

**占位符扫描**:无 TBD/TODO;每个 code step 都有完整代码。

**类型一致性**:`ReactionCategory`/`ReactionTrigger`/`stepReaction`/`initReaction`/`pickLine`/`loadLines`/`pushLine`/`petSpeak`/`onLine`/`validateReactionCategory` 在定义任务与消费任务间签名一致;`ReactionCategory` 单一定义于 `reactionPlanner.ts`,`ipc.ts` 与 `linesLoader.ts` 均 import 它。`'poke'` 映射到 category `'click'`,其余 trigger('drag'/'wake')本身即合法 category,TS 安全。
