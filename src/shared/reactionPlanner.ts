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
