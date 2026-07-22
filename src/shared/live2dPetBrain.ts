import type { PetEvent } from './petBrain'

export type Live2DPetState = 'idle' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'

export interface Live2DBrainConfig {
  sleepAfterIdleMs: number
  greetMs: number
  talkMs: number
}

export const DEFAULT_LIVE2D_BRAIN_CONFIG: Live2DBrainConfig = {
  sleepAfterIdleMs: 45000,
  greetMs: 900,
  talkMs: 1200
}

export interface Live2DBrainCtx {
  state: Live2DPetState
  stateElapsedMs: number
  idleAccumMs: number
  paused: boolean
  config: Live2DBrainConfig
}

export interface Live2DStepInput {
  dtMs: number
  event?: PetEvent
  rng: () => number
}

/** 与 petBrain.ts 的 StepEffects 刻意不同:没有 moveX/moveY——Live2D 宠物结构上
 *  不可能产出自主位移,这条约束在类型层面强制,不是运行时判断出来的。 */
export interface Live2DStepEffects { animation: string }

export function initLive2DBrain(config: Partial<Live2DBrainConfig> = {}): Live2DBrainCtx {
  const cfg = { ...DEFAULT_LIVE2D_BRAIN_CONFIG, ...config }
  return {
    state: 'idle',
    stateElapsedMs: 0,
    idleAccumMs: 0,
    paused: false,
    config: cfg
  }
}

function enterState(ctx: Live2DBrainCtx, state: Live2DPetState): Live2DBrainCtx {
  return { ...ctx, state, stateElapsedMs: 0 }
}

function applyEvent(ctx: Live2DBrainCtx, event: PetEvent): Live2DBrainCtx {
  switch (event) {
    case 'pickup': return { ...enterState(ctx, 'drag'), idleAccumMs: 0 }
    case 'drop': return { ...enterState(ctx, 'idle'), idleAccumMs: 0 }
    case 'wake': return { ...enterState(ctx, 'idle'), idleAccumMs: 0 }
    case 'dialogOpen': return { ...enterState(ctx, 'greet'), idleAccumMs: 0, paused: true }
    case 'dialogClose': return { ...enterState(ctx, 'idle'), idleAccumMs: 0, paused: false }
    case 'messageSent': return { ...enterState(ctx, 'thinking'), idleAccumMs: 0 }
    case 'replyDone': return { ...enterState(ctx, 'talk'), idleAccumMs: 0 }
    case 'remind': return { ...enterState(ctx, 'greet'), idleAccumMs: 0 }
    default: return ctx
  }
}

export function stepLive2D(ctx: Live2DBrainCtx, input: Live2DStepInput): { ctx: Live2DBrainCtx; effects: Live2DStepEffects } {
  const cfg = ctx.config
  let next: Live2DBrainCtx = {
    ...ctx,
    stateElapsedMs: ctx.stateElapsedMs + input.dtMs,
    idleAccumMs: ctx.idleAccumMs + input.dtMs
  }

  if (input.event) next = applyEvent(next, input.event)

  switch (next.state) {
    case 'idle': {
      // While paused (dialog open) the pet stays put — no autonomous sleep drift.
      if (next.paused) break
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) next = enterState(next, 'sleep')
      break
    }
    case 'greet': {
      if (next.stateElapsedMs >= cfg.greetMs) next = enterState(next, 'idle')
      break
    }
    case 'talk': {
      if (next.stateElapsedMs >= cfg.talkMs) next = enterState(next, 'idle')
      break
    }
    // 'drag' / 'thinking' / 'sleep' 持续,直到相应事件触发切换
  }

  return { ctx: next, effects: { animation: next.state } }
}
