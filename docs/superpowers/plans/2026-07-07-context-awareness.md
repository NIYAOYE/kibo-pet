# 懂我在干嘛（情境感知）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `reactionPlanner` 接入三类新情境信号(睡眠戳梦话、当天首次问候、AFK 离开、久坐提醒),把 `lines.json` 里 `greet`/`farewell`/`sleep` 三个从未接线的分类真正用起来,并新增 `break` 分类。

**Architecture:** 主进程新增 `idleWatcher` 模块轮询 `powerMonitor.getSystemIdleTime()`,通过新 IPC 通道 `CONTEXT_SIGNAL` 把 `afk_leave`/`break_reminder` 边沿信号推给渲染进程;渲染进程的 `petController` 把它们转成 `reactionPlanner` 的新触发类型,`reactionPlanner` 的优先级链决定最终说哪一句。

**Tech Stack:** TypeScript + Electron(`powerMonitor`)+ Vitest。零新增运行时依赖。

## Global Constraints

- 零新增运行时依赖(`powerMonitor` 是 Electron 内置 API)。
- 阈值不做设置面板 UI,全部是代码常量(默认:AFK 5 分钟、久坐 45 分钟、轮询 30 秒、久坐清零阈值 60 秒)。
- 睡眠中戳(poke)宠物 → 说 `sleep` 分类,**不**叫醒;拖起(drag)睡眠中的宠物依旧正常叫醒(不变,不能破坏这个既有手感)。
- 久坐提醒命中且宠物在睡时,必须在**同一 tick 内**完成叫醒(不能经过下一 tick 的 `pending` 队列),否则会被既有 `wokeUp` 派生逻辑把 `break` 台词覆盖成通用 `wake` 台词。
- AFK 离开不改变宠物当前状态(不叫醒、不哄睡)。
- 当天首次问候(早安 5:00–10:00 / 晚安 23:00–次日2:00)每天只触发一次,覆盖当次原本的 `click`/`drag`/`wake`/`sleep` 输出。
- 对话框打开(`pausedByDialog`)时,所有新信号(包括 `afk_leave`/`break_reminder`)都必须静音,不产生气泡。
- `pets/luluka`、`pets/youka`、`pets/shiraishi-mio`、`pets/juwang` 四个目录均被 `.gitignore`,`lines.json` 改动只落在磁盘,不会出现在 git diff 里(参照既有约定)。
- 详细设计依据:`docs/superpowers/specs/2026-07-07-context-awareness-design.md`。

---

## Task 1: `idleWatcher` 纯逻辑核心

**Files:**
- Create: `src/main/context/idleWatcher.ts`
- Test: `src/main/context/idleWatcher.test.ts`

**Interfaces:**
- Produces: `IdleWatcherConfig`(`pollIntervalMs`/`afkThresholdMs`/`breakThresholdMs`/`activeResetIdleMs`)、`DEFAULT_IDLE_WATCHER_CONFIG`、`IdleWatcherState`(`activeAccumMs`/`afkArmed`)、`initIdleWatcher(): IdleWatcherState`、`IdleWatcherEvent = 'afk_leave' | 'break_reminder'`、`stepIdleWatcher(state, idleMs, cfg): { state: IdleWatcherState; events: IdleWatcherEvent[] }`。Task 4 会在同一文件里追加依赖 Electron 的薄包装。

- [ ] **Step 1: 写失败测试**

创建 `src/main/context/idleWatcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { initIdleWatcher, stepIdleWatcher, type IdleWatcherConfig } from './idleWatcher'

const cfg: IdleWatcherConfig = {
  pollIntervalMs: 1000,
  afkThresholdMs: 3000,
  breakThresholdMs: 5000,
  activeResetIdleMs: 2000
}

describe('idleWatcher', () => {
  it('AFK:闲置跨过阈值触发一次,持续闲置不重复,回落后重新武装才能再触发', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 1000, cfg); state = r.state
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 3500, cfg); state = r.state // 跨过 3000 阈值
    expect(r.events).toEqual(['afk_leave'])
    r = stepIdleWatcher(state, 4000, cfg); state = r.state // 仍然闲置,不重复
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // 用户回来,回落
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 3500, cfg); state = r.state // 再次跨过阈值
    expect(r.events).toEqual(['afk_leave'])
  })

  it('久坐:持续活跃累加到阈值触发一次并清零', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=1000
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=2000
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=3000
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=4000
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=5000,触发
    expect(r.events).toEqual(['break_reminder'])
    expect(state.activeAccumMs).toBe(0)
  })

  it('久坐:采样闲置达到 activeResetIdleMs 时累加器清零(歇了一下不算数)', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 0, cfg); state = r.state
    r = stepIdleWatcher(state, 0, cfg); state = r.state
    expect(state.activeAccumMs).toBe(2000)
    r = stepIdleWatcher(state, 2000, cfg); state = r.state // 闲置达到 activeResetIdleMs,清零
    expect(state.activeAccumMs).toBe(0)
    expect(r.events).toEqual([])
  })

  it('AFK 触发的同时,久坐累加器按闲置值独立判定(不是因为 AFK 才清零)', () => {
    const state = initIdleWatcher()
    const r = stepIdleWatcher(state, 3500, cfg) // 3500 既 >= afkThresholdMs 也 >= activeResetIdleMs
    expect(r.events).toEqual(['afk_leave'])
    expect(r.state.activeAccumMs).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试,确认因文件不存在而失败**

Run: `pnpm vitest run src/main/context/idleWatcher.test.ts`
Expected: FAIL(找不到模块 `./idleWatcher`)

- [ ] **Step 3: 写最小实现**

创建 `src/main/context/idleWatcher.ts`:

```ts
export interface IdleWatcherConfig {
  /** 轮询间隔 */
  pollIntervalMs: number
  /** 闲置超过此值判定为 AFK 离开 */
  afkThresholdMs: number
  /** 持续活跃(无长间隔)累计超过此值判定为久坐 */
  breakThresholdMs: number
  /** 单次采样闲置 ≥ 此值视为"歇了一下",久坐累加器清零 */
  activeResetIdleMs: number
}

export const DEFAULT_IDLE_WATCHER_CONFIG: IdleWatcherConfig = {
  pollIntervalMs: 30_000,
  afkThresholdMs: 5 * 60_000,
  breakThresholdMs: 45 * 60_000,
  activeResetIdleMs: 60_000
}

export interface IdleWatcherState {
  activeAccumMs: number
  afkArmed: boolean
}

export function initIdleWatcher(): IdleWatcherState {
  return { activeAccumMs: 0, afkArmed: true }
}

export type IdleWatcherEvent = 'afk_leave' | 'break_reminder'

/**
 * 纯函数核心:注入一次 OS 闲置采样(ms),返回下一状态 + 本次触发的事件。
 */
export function stepIdleWatcher(
  state: IdleWatcherState,
  idleMs: number,
  cfg: IdleWatcherConfig
): { state: IdleWatcherState; events: IdleWatcherEvent[] } {
  const events: IdleWatcherEvent[] = []
  let next: IdleWatcherState = { ...state }

  // AFK:边沿触发,闲置回落后重新武装
  if (idleMs >= cfg.afkThresholdMs) {
    if (next.afkArmed) {
      events.push('afk_leave')
      next = { ...next, afkArmed: false }
    }
  } else {
    next = { ...next, afkArmed: true }
  }

  // 久坐:持续活跃累加,遇到像样的闲置间隔就清零
  if (idleMs < cfg.activeResetIdleMs) {
    next = { ...next, activeAccumMs: next.activeAccumMs + cfg.pollIntervalMs }
  } else {
    next = { ...next, activeAccumMs: 0 }
  }
  if (next.activeAccumMs >= cfg.breakThresholdMs) {
    events.push('break_reminder')
    next = { ...next, activeAccumMs: 0 }
  }

  return { state: next, events }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm vitest run src/main/context/idleWatcher.test.ts`
Expected: PASS(4 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add src/main/context/idleWatcher.ts src/main/context/idleWatcher.test.ts
git commit -m "feat(context): idleWatcher 纯逻辑核心(AFK/久坐边沿判定)"
```

---

## Task 2: `reactionPlanner` 优先级链扩展

**Files:**
- Modify: `src/shared/reactionPlanner.ts`
- Modify: `src/shared/reactionPlanner.test.ts`

**Interfaces:**
- Consumes: 无(纯函数,无新依赖)
- Produces: `ReactionCategory`(新增 `'greet' | 'farewell' | 'sleep' | 'break'`)、`ReactionTrigger`(新增 `'afk_leave' | 'break_reminder'`)、`ReactionInput`(字段变化:`paused` → `pausedByDialog`,新增 `sleeping: boolean`、`nowMs: number`)、`ReactionCtx`(新增 `lastGreetDateKey: string | null`)。Task 5(`petController.ts`)依赖这些确切类型名。

- [ ] **Step 1: 改测试(先改到会编译失败/断言失败的状态)**

用以下内容整体替换 `src/shared/reactionPlanner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { initReaction, stepReaction, DEFAULT_REACTION_CONFIG, REACTION_CATEGORIES } from './reactionPlanner'

const cfg = { idleChatterMinMs: 1000, idleChatterMaxMs: 1000, longIdleAfterMs: 2000, eventCooldownMs: 500, globalCooldownMs: 3000 }
const rng = (): number => 0 // 确定性：randRange 取下界
// 中午 14:00,落在早安(5-10)/晚安(23-2)两个窗口之外,避免无关用例被日问候逻辑打扰
const NOON_MS = new Date(2026, 0, 1, 14, 0, 0).getTime()
const MORNING_MS = new Date(2026, 0, 1, 7, 0, 0).getTime()      // 早安窗口内
const NIGHT_MS = new Date(2026, 0, 1, 23, 30, 0).getTime()      // 晚安窗口内(1 月 1 日)
const NEXT_NIGHT_MS = new Date(2026, 0, 2, 0, 30, 0).getTime()  // 次日 0:30,仍在晚安窗口,但日期已跨天

describe('reactionPlanner', () => {
  it('REACTION_CATEGORIES 覆盖全部 category', () => {
    expect(REACTION_CATEGORIES).toEqual(
      ['idle', 'long_idle', 'wake', 'click', 'drag', 'greet', 'farewell', 'sleep', 'break']
    )
  })

  it('idle 闲聊在 chatterTimer 归零那一刻触发并重置', () => {
    let ctx = initReaction(cfg) // chatterTimerMs 初值 = idleChatterMinMs = 1000
    let r = stepReaction(ctx, { dtMs: 600, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined()
    r = stepReaction(ctx, { dtMs: 600, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('idle')
    expect(ctx.chatterTimerMs).toBe(1000) // 重置
  })

  it('pausedByDialog 时完全不冒话', () => {
    const ctx = initReaction(cfg)
    const r = stepReaction(ctx, { dtMs: 5000, pausedByDialog: true, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBeUndefined()
  })

  it('poke → click；冷却内第二次 poke 被吞', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click')
    r = stepReaction(ctx, { dtMs: 100, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined() // eventCooldown 未过
    r = stepReaction(ctx, { dtMs: 500, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click') // 冷却已过
  })

  it('drag trigger → drag', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'drag', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('drag')
  })

  it('long_idle 每段静置只冒一次；trigger 重置后可再冒', () => {
    let ctx = initReaction({ ...cfg, idleChatterMinMs: 100000, idleChatterMaxMs: 100000 })
    let r = stepReaction(ctx, { dtMs: 2000, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('long_idle')
    r = stepReaction(ctx, { dtMs: 2000, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined() // 不重复
    r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(ctx.idleSinceMs).toBe(0)
    r = stepReaction(ctx, { dtMs: 2000, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('long_idle')
  })

  it('触碰后不会立刻接着冒 idle 闲聊', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click')
    r = stepReaction(ctx, { dtMs: 1000, pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBeUndefined()
  })

  it('DEFAULT_REACTION_CONFIG 有合理默认', () => {
    expect(DEFAULT_REACTION_CONFIG.globalCooldownMs).toBeGreaterThan(0)
  })

  // ---- 情境感知新增用例 ----

  it('戳睡眠中的宠物 → sleep 梦话,不是 click', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: true, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('sleep')
  })

  it('拖起睡眠中的宠物依旧是 drag(sleeping 不影响 drag/wake 映射)', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'drag', pausedByDialog: false, sleeping: true, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('drag')
  })

  it('当天首次触碰落在早安窗口 → greet,覆盖 click', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: MORNING_MS, rng })
    expect(r.output.speak).toBe('greet')
  })

  it('当天首次触碰落在晚安窗口 → farewell,同一天不再重复', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NIGHT_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('farewell')
    r = stepReaction(ctx, { dtMs: 600, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NIGHT_MS + 1000, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('click') // 同一天第二次:不再是 farewell
  })

  it('晚安窗口跨零点:次日再次触碰因日期变了会再触发一次(已知边界情况)', () => {
    let ctx = initReaction(cfg)
    let r = stepReaction(ctx, { dtMs: 16, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NIGHT_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('farewell')
    r = stepReaction(ctx, { dtMs: 600, trigger: 'poke', pausedByDialog: false, sleeping: false, nowMs: NEXT_NIGHT_MS, rng }); ctx = r.ctx
    expect(r.output.speak).toBe('farewell')
  })

  it('afk_leave → farewell,睡眠中也照常触发', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'afk_leave', pausedByDialog: false, sleeping: true, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('farewell')
  })

  it('break_reminder → break', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'break_reminder', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('break')
  })

  it('pausedByDialog 时 afk_leave/break_reminder 也静音', () => {
    let r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'afk_leave', pausedByDialog: true, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBeUndefined()
    r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'break_reminder', pausedByDialog: true, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败(旧实现的 `paused` 字段与新测试的 `pausedByDialog`/`sleeping`/`nowMs` 不匹配,会是 TS 编译错误)**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: FAIL(类型错误:`ReactionInput` 上不存在 `pausedByDialog`/`sleeping`/`nowMs`,或 `paused` 缺失)

- [ ] **Step 3: 用以下内容整体替换 `src/shared/reactionPlanner.ts`**

```ts
export type ReactionCategory =
  | 'idle' | 'long_idle' | 'wake' | 'click' | 'drag'
  | 'greet' | 'farewell' | 'sleep' | 'break'
export const REACTION_CATEGORIES: ReactionCategory[] = [
  'idle', 'long_idle', 'wake', 'click', 'drag', 'greet', 'farewell', 'sleep', 'break'
]

/** 用户触碰/唤醒产生的即时触发,或主进程情境信号(afk_leave/break_reminder);idle/long_idle 是环境定时,不走这里 */
export type ReactionTrigger = 'poke' | 'drag' | 'wake' | 'afk_leave' | 'break_reminder'

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
  /** 当天首次问候(greet/farewell)上次触发的本地日期键,如 "2026-7-7";跨天后可再次触发 */
  lastGreetDateKey: string | null
  config: ReactionConfig
}

export interface ReactionInput {
  dtMs: number
  trigger?: ReactionTrigger
  /** 对话框开着:完全静音 */
  pausedByDialog: boolean
  /** 宠物动画上是否在睡:决定戳它是 sleep 梦话还是 click */
  sleeping: boolean
  /** 墙钟时间戳(ms),用于当天首问候的日期/时段判定 */
  nowMs: number
  rng: () => number
}

export interface ReactionOutput { speak?: ReactionCategory }

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

const GREET_START_HOUR = 5
const GREET_END_HOUR = 10        // [5, 10) 早安
const FAREWELL_START_HOUR = 23   // [23, 24) ∪ [0, 2) 晚安,跨零点
const FAREWELL_END_HOUR = 2

function localDateKey(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function dailyGreetCategory(nowMs: number): 'greet' | 'farewell' | null {
  const hour = new Date(nowMs).getHours()
  if (hour >= GREET_START_HOUR && hour < GREET_END_HOUR) return 'greet'
  if (hour >= FAREWELL_START_HOUR || hour < FAREWELL_END_HOUR) return 'farewell'
  return null
}

export function initReaction(config: Partial<ReactionConfig> = {}): ReactionCtx {
  const cfg = { ...DEFAULT_REACTION_CONFIG, ...config }
  return {
    eventCooldownMs: 0,
    // 首个闲聊间隔用下界（确定、无需 rng）；之后每次重置带抖动
    chatterTimerMs: cfg.idleChatterMinMs,
    idleSinceMs: 0,
    longIdleSpoken: false,
    lastGreetDateKey: null,
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

  // 任何触发（含 afk_leave/break_reminder）都重置 idle 计时并重新武装 long_idle
  if (input.trigger) next = { ...next, idleSinceMs: 0, longIdleSpoken: false }

  // 对话框打开：闭嘴，跟随气泡让位给聊天回复
  if (input.pausedByDialog) return { ctx: next, output: {} }

  // 1) 真实触碰/唤醒：poke/drag/wake，最高优先级，短冷却防连点刷屏
  if (input.trigger === 'poke' || input.trigger === 'drag' || input.trigger === 'wake') {
    if (next.eventCooldownMs > 0) return { ctx: next, output: {} }

    const dateKey = localDateKey(input.nowMs)
    const dailyCat = next.lastGreetDateKey !== dateKey ? dailyGreetCategory(input.nowMs) : null

    let cat: ReactionCategory
    if (dailyCat) {
      cat = dailyCat
      next = { ...next, lastGreetDateKey: dateKey }
    } else if (input.trigger === 'poke' && input.sleeping) {
      cat = 'sleep'
    } else {
      cat = input.trigger === 'poke' ? 'click' : input.trigger
    }

    next = {
      ...next,
      eventCooldownMs: cfg.eventCooldownMs,
      chatterTimerMs: Math.max(next.chatterTimerMs, cfg.globalCooldownMs)
    }
    return { ctx: next, output: { speak: cat } }
  }

  // 2) 久坐提醒：主进程边沿信号；调用方已在同一 tick 内叫醒宠物（若需要），这里 sleeping 恒为 false
  if (input.trigger === 'break_reminder') {
    next = { ...next, chatterTimerMs: Math.max(next.chatterTimerMs, cfg.globalCooldownMs) }
    return { ctx: next, output: { speak: 'break' } }
  }

  // 3) AFK 离开：主进程边沿信号，不改变宠物状态
  if (input.trigger === 'afk_leave') {
    next = { ...next, chatterTimerMs: Math.max(next.chatterTimerMs, cfg.globalCooldownMs) }
    return { ctx: next, output: { speak: 'farewell' } }
  }

  // 4) 长时间静置：每段只冒一次
  if (!next.longIdleSpoken && next.idleSinceMs >= cfg.longIdleAfterMs) {
    next = {
      ...next,
      longIdleSpoken: true,
      chatterTimerMs: randRange(input.rng, cfg.idleChatterMinMs, cfg.idleChatterMaxMs)
    }
    return { ctx: next, output: { speak: 'long_idle' } }
  }

  // 5) idle 闲聊：定时冒话
  if (next.chatterTimerMs <= 0) {
    next = { ...next, chatterTimerMs: randRange(input.rng, cfg.idleChatterMinMs, cfg.idleChatterMaxMs) }
    return { ctx: next, output: { speak: 'idle' } }
  }

  return { ctx: next, output: {} }
}
```

- [ ] **Step 4: 运行测试,确认全部通过**

Run: `pnpm vitest run src/shared/reactionPlanner.test.ts`
Expected: PASS(18 个用例全绿)

- [ ] **Step 5: 全量 typecheck(其他文件此时会因签名变化报错,属预期——Task 5 会修)**

Run: `pnpm typecheck`
Expected: `src/renderer/petController.ts` 报 `paused` 不存在等错误——**这是预期的**,记下报错文件但不在本任务修，留给 Task 5。

- [ ] **Step 6: 提交**

```bash
git add src/shared/reactionPlanner.ts src/shared/reactionPlanner.test.ts
git commit -m "feat(reaction): 优先级链接入睡眠戳/当天问候/AFK/久坐信号"
```

---

## Task 3: `CONTEXT_SIGNAL` IPC 契约(类型 + preload)

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `IPC.CONTEXT_SIGNAL` 常量、`ContextSignalKind = 'afk_leave' | 'break_reminder'`、`PetApi.onContextSignal(cb): void`。Task 4(主进程发送端)与 Task 5(渲染进程订阅端)依赖这些。

- [ ] **Step 1: 修改 `src/shared/ipc.ts`**

在 `PET_SPEAK: 'pet:speak'` 后追加新常量（注意原本这是对象最后一项、无尾随逗号，需要先补逗号）：

```ts
  BUBBLE_LINE: 'bubble:line',
  BUBBLE_RESIZE: 'bubble:resize',
  PET_SPEAK: 'pet:speak',
  CONTEXT_SIGNAL: 'context:signal'
} as const
```

在 `export interface LoadedPet {` 之前新增类型：

```ts
/** 主进程情境信号(main→renderer 推送):AFK 离开 / 久坐提醒，均为一次性边沿事件 */
export type ContextSignalKind = 'afk_leave' | 'break_reminder'

export interface LoadedPet {
```

在 `PetApi` 接口的 `petSpeak` 之后新增方法：

```ts
  /** 自主/触碰反应：请求主进程按 category 选一句台词，用瞬态气泡显示 */
  petSpeak(category: ReactionCategory): void
  /** 主进程情境信号(AFK 离开/久坐提醒):main→renderer 推送 */
  onContextSignal(cb: (kind: ContextSignalKind) => void): void
  quit(): void
```

- [ ] **Step 2: 修改 `src/preload/index.ts`**

导入列表加 `type ContextSignalKind`：

```ts
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace, type ContextSignalKind
} from '@shared/ipc'
```

`petApi` 对象里 `petSpeak` 之后新增：

```ts
  petSpeak: (category): void => ipcRenderer.send(IPC.PET_SPEAK, category),
  onContextSignal: (cb: (kind: ContextSignalKind) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CONTEXT_SIGNAL)
    ipcRenderer.on(IPC.CONTEXT_SIGNAL, (_e, kind: ContextSignalKind) => cb(kind))
  },
  quit: (): void => ipcRenderer.send(IPC.QUIT)
```

- [ ] **Step 3: typecheck(预期仍会因 `petController.ts`/`idleWatcher.ts` 未更新而报旧错误,只确认本任务改动的两个文件本身没有新增错误)**

Run: `pnpm typecheck`
Expected: 无新增的 `ipc.ts`/`preload/index.ts` 相关报错(`petController.ts` 的 `paused` 报错、`idleWatcher.ts` 尚不存在 `startIdleWatcher` 的报错属预期,留给后续任务)

- [ ] **Step 4: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(ipc): 新增 CONTEXT_SIGNAL 单向通道(main→renderer)"
```

---

## Task 4: `idleWatcher` 主进程接线

**Files:**
- Modify: `src/main/context/idleWatcher.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `DEFAULT_IDLE_WATCHER_CONFIG`/`IdleWatcherConfig`/`initIdleWatcher`/`stepIdleWatcher`；Task 3 的 `IPC.CONTEXT_SIGNAL`。
- Produces: `IdleWatcherHandle`(`{ stop(): void }`)、`startIdleWatcher(petWin, opts?): IdleWatcherHandle`。

- [ ] **Step 1: 在 `src/main/context/idleWatcher.ts` 顶部追加 import,文件末尾追加薄包装**

在文件最顶部（`export interface IdleWatcherConfig {` 之前）加：

```ts
import { powerMonitor, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'

```

在文件末尾（`stepIdleWatcher` 函数之后）追加：

```ts

export interface IdleWatcherHandle { stop: () => void }

/**
 * 薄包装:每 pollIntervalMs 轮询一次真实 OS 闲置时间，把 stepIdleWatcher 判定的事件推给渲染进程。
 * 核心判定逻辑（stepIdleWatcher）不依赖本函数，保持可单测。
 */
export function startIdleWatcher(
  petWin: BrowserWindow,
  opts: { config?: Partial<IdleWatcherConfig>; getIdleMs?: () => number } = {}
): IdleWatcherHandle {
  const cfg = { ...DEFAULT_IDLE_WATCHER_CONFIG, ...opts.config }
  const getIdleMs = opts.getIdleMs ?? ((): number => powerMonitor.getSystemIdleTime() * 1000)
  let state = initIdleWatcher()

  const handle = setInterval(() => {
    const r = stepIdleWatcher(state, getIdleMs(), cfg)
    state = r.state
    // IdleWatcherEvent('afk_leave'|'break_reminder')与 ContextSignalKind 结构相同,
    // webContents.send 的 channel 参数外类型是 any,故无需在此转换类型。
    for (const kind of r.events) petWin.webContents.send(IPC.CONTEXT_SIGNAL, kind)
  }, cfg.pollIntervalMs)

  return { stop: (): void => clearInterval(handle) }
}
```

- [ ] **Step 2: 接线 `src/main/shell/index.ts`**

在现有 import 区（`import { createTray } from './tray'` 附近）加一行：

```ts
import { startIdleWatcher } from '../context/idleWatcher'
```

在 `const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })` 之后加：

```ts
  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })
  const idleWatcher = startIdleWatcher(petWin)
```

把现有的：

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop() })
```

改成：

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop() })
```

- [ ] **Step 3: 运行既有单测,确认 Task 1 的纯函数测试不受影响**

Run: `pnpm vitest run src/main/context/idleWatcher.test.ts`
Expected: PASS(不变,薄包装未被测试覆盖,属预期——同 weather/firecrawl 工具的既有取舍)

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: `idleWatcher.ts`/`shell/index.ts` 相关报错清零(`petController.ts` 的报错留给 Task 5)

- [ ] **Step 5: 提交**

```bash
git add src/main/context/idleWatcher.ts src/main/shell/index.ts
git commit -m "feat(context): idleWatcher 接线到主窗口生命周期"
```

---

## Task 5: `petController` 接线新触发类型

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: Task 2 的 `ReactionTrigger`/`ReactionCtx`/`initReaction`/`stepReaction`；Task 3 的 `ContextSignalKind`/`PetApi.onContextSignal`。
- Produces: `PetController.receiveContextSignal(kind: ContextSignalKind): void`（新公开方法，供 `main.ts` 调用）。

- [ ] **Step 1: 用以下内容整体替换 `src/renderer/petController.ts`**

```ts
import { SpritePlayer } from './spritePlayer'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
import type { ContextSignalKind } from '@shared/ipc'

const TICK_MS = 33

export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private currentAnim = ''
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null
  private pendingContextSignal: ContextSignalKind | null = null

  constructor(private player: SpritePlayer) {}

  async start(): Promise<void> {
    try {
      await this.syncBounds()
    } catch (err) {
      console.warn('initial syncBounds failed; using default bounds', err)
    }
    this.lastTs = performance.now()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
  }

  send(event: PetEvent): void { this.pending.push(event) }

  /** 双击=戳：下一 tick 喂给反应规划器 */
  poke(): void { this.pendingReaction = 'poke' }

  /** 主进程情境信号(AFK 离开/久坐提醒)：下一 tick 消费 */
  receiveContextSignal(kind: ContextSignalKind): void { this.pendingContextSignal = kind }

  async syncBounds(): Promise<void> {
    const b = await window.petApi.getWindowBounds()
    this.workArea = b.workArea
    this.windowX = b.window.x
    this.windowWidth = b.window.width
  }

  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now

    const contextSignal = this.pendingContextSignal
    this.pendingContextSignal = null

    let event = this.pending.shift()
    if (event === 'pickup') this.pendingReaction = 'drag' // 拖起 → drag 台词
    // 久坐提醒命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的 wokeUp 派生
    // 把更具体的 break 台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if (contextSignal === 'break_reminder' && this.ctx.state === 'sleep') event = 'wake'

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
      // Re-sync the predicted windowX from the true OS position at each walk
      // start, so drift accumulated over the session doesn't skew edge-clamping.
      const startedWalking = effects.animation.startsWith('walk') && !this.currentAnim.startsWith('walk')
      this.player.play(effects.animation)
      this.currentAnim = effects.animation
      if (startedWalking) void this.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    }
    if (effects.move !== 0) {
      // clamp:true — autonomous walk stays on-screen (main enforces the edge).
      window.petApi.moveWindow({ dx: effects.move, dy: 0, clamp: true })
      this.windowX += effects.move
    }

    // 反应规划器:每 tick 一个触发。优先级:主进程情境信号 > 睡→醒(wake)派生 > 手势触发(poke/drag)。
    const wokeUp = prevState === 'sleep' && this.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined =
      contextSignal ?? (wokeUp ? 'wake' : (this.pendingReaction ?? undefined))
    this.pendingReaction = null
    const sleeping = this.ctx.state === 'sleep'
    const r = stepReaction(this.reactionCtx, {
      dtMs,
      trigger,
      pausedByDialog: this.ctx.paused,
      sleeping,
      nowMs: Date.now(),
      rng: Math.random
    })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
}
```

- [ ] **Step 2: 在 `src/renderer/main.ts` 接线订阅**

把：

```ts
  await controller.start()
  window.petApi.onPetEvent((event) => controller.send(event))
```

改成：

```ts
  await controller.start()
  window.petApi.onPetEvent((event) => controller.send(event))
  window.petApi.onContextSignal((kind) => controller.receiveContextSignal(kind))
```

- [ ] **Step 3: 全量 typecheck,确认此前 Task 2/3/4 遗留的报错全部清零**

Run: `pnpm typecheck`
Expected: PASS(零错误)

- [ ] **Step 4: 全量单测**

Run: `pnpm test`
Expected: PASS(全部通过，含 Task 1/2 新增用例)

- [ ] **Step 5: 提交**

```bash
git add src/renderer/petController.ts src/renderer/main.ts
git commit -m "feat(pet): petController 接线情境信号,睡眠戳/久坐叫醒同 tick 生效"
```

---

## Task 6: `break` 分类台词(四宠物包)

**Files:**
- Modify: `pets/luluka/lines.json`
- Modify: `pets/youka/lines.json`
- Modify: `pets/shiraishi-mio/lines.json`
- Modify: `pets/juwang/lines.json`

**Interfaces:**
- Consumes: 无代码依赖，`pickLine`(`src/main/lines/linesLoader.ts`)已支持任意字符串 key，无需改动。
- Produces: 四个宠物包各自新增 `break` 分类，供 Task 5 已接好的 `break_reminder → break` 链路在真机验收时有词可念。

- [ ] **Step 1: `pets/luluka/lines.json` 的 `sleep` 分类后插入 `break`**

把：

```json
  "sleep": [
    { "text": "Zzz……(梦到冰淇淋了)" },
    { "text": "……五秒,就休息五秒。" }
  ],

  "thinking": [
```

改成：

```json
  "sleep": [
    { "text": "Zzz……(梦到冰淇淋了)" },
    { "text": "……五秒,就休息五秒。" }
  ],

  "break": [
    { "text": "……唔。你坐这么久，我都睡了一觉了。" },
    { "text": "起来走走。线索又不会跑。" }
  ],

  "thinking": [
```

- [ ] **Step 2: `pets/youka/lines.json` 的 `sleep` 分类后插入 `break`**

把：

```json
  "sleep": [
    { "text": "晚安，老师……明天的安排，明早再确认。" },
    { "text": "（抱着枕头安静地睡着了）" },
    { "text": "休息也是维持效率的必要投资……呼……" }
  ],

  "thinking": [
```

改成：

```json
  "sleep": [
    { "text": "晚安，老师……明天的安排，明早再确认。" },
    { "text": "（抱着枕头安静地睡着了）" },
    { "text": "休息也是维持效率的必要投资……呼……" }
  ],

  "break": [
    { "text": "……老师，已经连续工作太久了。效率会下降，先起来动一动。" },
    { "text": "我把这段「久坐」也记进了账目——现在，去倒杯水。" }
  ],

  "thinking": [
```

- [ ] **Step 3: `pets/shiraishi-mio/lines.json` 的 `sleep` 分类后插入 `break`**

把：

```json
  "sleep": [
    { "text": "记录暂停。五分钟后叫我。" },
    { "text": "……只是闭眼整理思路。" }
  ],

  "thinking": [
```

改成：

```json
  "sleep": [
    { "text": "记录暂停。五分钟后叫我。" },
    { "text": "……只是闭眼整理思路。" }
  ],

  "break": [
    { "text": "……你也保持这个姿势太久了。先起来活动一下，再继续记录。" },
    { "text": "长时间不动的读数不算健康数据。休息一下。" }
  ],

  "thinking": [
```

- [ ] **Step 4: `pets/juwang/lines.json` 的 `sleep` 分类后插入 `break`**

把：

```json
  "sleep": [
    { "text": "呼……下一站……最快纪录……" },
    { "text": "只睡一小站……到站记得叫我……" },
    { "text": "夜班结束……老师，借这里停靠一下……" }
  ],

  "thinking": [
```

改成：

```json
  "sleep": [
    { "text": "呼……下一站……最快纪录……" },
    { "text": "只睡一小站……到站记得叫我……" },
    { "text": "夜班结束……老师，借这里停靠一下……" }
  ],

  "break": [
    { "text": "帕嘿……老师这一站停太久啦，起来走两步再发车！" },
    { "text": "连续运行也要进站检修啦——去伸个懒腰！" }
  ],

  "thinking": [
```

- [ ] **Step 5: 校验四份 JSON 语法合法**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('pets/luluka/lines.json','utf8'));JSON.parse(require('fs').readFileSync('pets/youka/lines.json','utf8'));JSON.parse(require('fs').readFileSync('pets/shiraishi-mio/lines.json','utf8'));JSON.parse(require('fs').readFileSync('pets/juwang/lines.json','utf8'));console.log('ok')"
```
Expected: 输出 `ok`,无异常抛出

- [ ] **Step 6: 提交(注:四个 `pets/*` 目录均被 `.gitignore`,此步 `git add` 实际不会有文件被暂存,属预期——磁盘已改好即可,跳过 commit)**

无需提交(四份 `lines.json` 均在 `.gitignore` 覆盖范围内)。确认磁盘文件已保存即完成本任务。

---

## Task 7: 全量验证 + 真机走查

**Files:** 无新增/修改文件,纯验证任务。

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: PASS(零错误)

- [ ] **Step 2: 全量单测**

Run: `pnpm test`
Expected: PASS(全部通过)

- [ ] **Step 3: 全量构建**

Run: `pnpm build`
Expected: PASS(三包构建成功)

- [ ] **Step 4: 真机走查(`pnpm preview`)——临时调小阈值**

临时把 `src/main/context/idleWatcher.ts` 的 `DEFAULT_IDLE_WATCHER_CONFIG` 改成小数值以便快速走查(**验收完成后必须改回默认值再提交**):

```ts
export const DEFAULT_IDLE_WATCHER_CONFIG: IdleWatcherConfig = {
  pollIntervalMs: 2_000,
  afkThresholdMs: 10_000,
  breakThresholdMs: 20_000,
  activeResetIdleMs: 5_000
}
```

Run: `pnpm build && pnpm preview`

走查清单(逐项肉眼确认):
- 双击戳睡眠中的宠物 → 出 `sleep` 分类梦话,宠物**不**醒来。
- 拖起睡眠中的宠物 → 正常出 `wake` 台词并醒来(不变,验证没有破坏 MVP-13 手感)。
- 应用启动后完全不碰键鼠/宠物,等待超过 `afkThresholdMs`(临时值 10s)→ 出一句 `farewell`(AFK 离开),宠物状态不变。
- 持续操作键鼠(不碰宠物)超过 `breakThresholdMs`(临时值 20s,期间闲置不能连续超过 `activeResetIdleMs`=5s)→ 若宠物已睡着,先醒来再出 `break` 台词。
- 把系统时间调到 5:00–10:00 或 23:00–2:00 之间(或等到真实时间落入该窗口),首次触碰宠物 → 出 `greet`/`farewell`,同一天不重复。
- 对话框开着时,以上信号均不产生气泡。
- `lines.json` 缺 `break` 分类的宠物包(可临时改名验证)→ 优雅降级,不崩溃、不出气泡。

- [ ] **Step 5: 走查通过后,把 `DEFAULT_IDLE_WATCHER_CONFIG` 改回默认值**

```ts
export const DEFAULT_IDLE_WATCHER_CONFIG: IdleWatcherConfig = {
  pollIntervalMs: 30_000,
  afkThresholdMs: 5 * 60_000,
  breakThresholdMs: 45 * 60_000,
  activeResetIdleMs: 60_000
}
```

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: 更新 `PROGRESS.md`,记录本 MVP 完成状态**

在 `PROGRESS.md` 的 MVP 列表末尾(紧接 MVP-13 之后)追加一条,格式仿照既有条目(`- ✅ **MVP-13** ...`那种单段落风格)。必须包含以下事实性内容,数字部分(测试通过数)以 Step 2 实际的 `pnpm test` 输出为准据实填写,不得照抄示例数字:

> - ✅ **懂我在干嘛(情境感知)** —— 代码完成 + 单测通过(`pnpm test` 输出的实际通过数/总数)、待真机验收。承接 ROADMAP.md 轨道二,`reactionPlanner` 优先级链新增四类信号:睡眠戳梦话(`sleep`,不叫醒)、当天首次问候(`greet`/早安 5-10 点、`farewell`/晚安 23-2 点,一天一次)、AFK 离开(`idleWatcher` 轮询 `powerMonitor`,默认 5 分钟,不改宠物状态)、久坐提醒(默认连续活跃 45 分钟,若宠物在睡先同 tick 内叫醒再出新增 `break` 分类)。新增主进程模块 `src/main/context/idleWatcher.ts`(纯函数核心可单测 + 薄包装)+ IPC 单向通道 `CONTEXT_SIGNAL`。零新依赖、零设置面板改动。四个宠物包 `lines.json` 新增 `break` 分类(磁盘直改,`.gitignore` 覆盖)。**真机验收清单**(计划 Task 7 Step 4):戳/拖睡眠中的宠物两种手感、AFK 离开、久坐叫醒、早安/晚安时段问候、对话框开着时全部静音、`break` 分类缺失优雅降级——验收时临时调小阈值走查,完成后已改回默认值。窗口/应用焦点检测、主动搭话/陪伴深化两个后续方向明确留给各自独立的下一轮 brainstorming。

- [ ] **Step 7: 提交**

```bash
git add src/main/context/idleWatcher.ts PROGRESS.md
git commit -m "docs(progress): 情境感知(睡眠戳/AFK/久坐/时段问候)真机验收通过"
```
