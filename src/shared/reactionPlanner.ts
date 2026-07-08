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
