export type PetLogicalState = 'idle' | 'walk' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'
export type PetEvent = 'pickup' | 'drop' | 'wake' | 'dialogOpen' | 'dialogClose' | 'messageSent' | 'replyDone' | 'remind'
export type Direction = 'left' | 'right'
/** Vertical drift during a walk episode; 'none' keeps the walk purely horizontal (the classic behavior). */
export type VerticalDirection = 'up' | 'down' | 'none'

export interface Bounds { x: number; y: number; width: number; height: number }

export interface PetBrainConfig {
  idleDwellMinMs: number
  idleDwellMaxMs: number
  walkProbability: number
  walkSpeedPxPerSec: number
  walkMinPx: number
  walkMaxPx: number
  sleepAfterIdleMs: number
  greetMs: number
  talkMs: number
  /** Chance a walk also drifts vertically (split evenly between up/down); the rest stay purely horizontal. */
  verticalWalkProbability: number
}

export const DEFAULT_BRAIN_CONFIG: PetBrainConfig = {
  idleDwellMinMs: 2000,
  idleDwellMaxMs: 6000,
  walkProbability: 0.6,
  walkSpeedPxPerSec: 40,
  walkMinPx: 80,
  walkMaxPx: 260,
  sleepAfterIdleMs: 45000,
  greetMs: 900,
  talkMs: 1200,
  verticalWalkProbability: 0.4
}

export interface PetBrainCtx {
  state: PetLogicalState
  dir: Direction
  dirY: VerticalDirection
  stateElapsedMs: number
  dwellMs: number
  idleAccumMs: number // 距上次"用户交互"的累计时长;自主游走不重置它(仅用户事件在 applyEvent 里重置),用于从 idle 漂移入睡
  walkRemainingPx: number
  paused: boolean // 对话框打开时为 true:宠物停止自主游走/入睡,留在原地陪聊(仍响应拖拽/对话事件)
  config: PetBrainConfig
}

export interface StepInput {
  dtMs: number
  event?: PetEvent
  bounds: Bounds
  windowX: number
  windowWidth: number
  windowY: number
  windowHeight: number
  rng: () => number
}

export interface StepEffects { animation: string; moveX: number; moveY: number }

export function animationFor(state: PetLogicalState, dir: Direction): string {
  if (state === 'walk') return dir === 'left' ? 'walk-left' : 'walk-right'
  return state
}

export function initBrain(config: Partial<PetBrainConfig> = {}): PetBrainCtx {
  const cfg = { ...DEFAULT_BRAIN_CONFIG, ...config }
  return {
    state: 'idle',
    dir: 'right',
    dirY: 'none',
    stateElapsedMs: 0,
    dwellMs: cfg.idleDwellMinMs,
    idleAccumMs: 0,
    walkRemainingPx: 0,
    paused: false,
    config: cfg
  }
}

function enterState(ctx: PetBrainCtx, state: PetLogicalState): PetBrainCtx {
  return { ...ctx, state, stateElapsedMs: 0 }
}

function enterIdle(ctx: PetBrainCtx, rng: () => number): PetBrainCtx {
  const cfg = ctx.config
  return {
    ...ctx,
    state: 'idle',
    stateElapsedMs: 0,
    dwellMs: cfg.idleDwellMinMs + rng() * (cfg.idleDwellMaxMs - cfg.idleDwellMinMs)
  }
}

function enterWalk(ctx: PetBrainCtx, rng: () => number): PetBrainCtx {
  const cfg = ctx.config
  const dir: Direction = rng() < 0.5 ? 'left' : 'right'
  const dist = cfg.walkMinPx + rng() * (cfg.walkMaxPx - cfg.walkMinPx)
  const pNone = 1 - cfg.verticalWalkProbability
  const pUpEnd = pNone + cfg.verticalWalkProbability / 2
  const vRoll = rng()
  const dirY: VerticalDirection = vRoll < pNone ? 'none' : vRoll < pUpEnd ? 'up' : 'down'
  return { ...ctx, state: 'walk', dir, dirY, stateElapsedMs: 0, walkRemainingPx: dist }
}

function applyEvent(ctx: PetBrainCtx, event: PetEvent, rng: () => number): PetBrainCtx {
  switch (event) {
    case 'pickup': return { ...enterState(ctx, 'drag'), idleAccumMs: 0 }
    case 'drop': return { ...enterIdle(ctx, rng), idleAccumMs: 0 }
    case 'wake': return { ...enterIdle(ctx, rng), idleAccumMs: 0 }
    case 'dialogOpen': return { ...enterState(ctx, 'greet'), idleAccumMs: 0, paused: true }
    case 'dialogClose': return { ...enterIdle(ctx, rng), idleAccumMs: 0, paused: false }
    case 'messageSent': return { ...enterState(ctx, 'thinking'), idleAccumMs: 0 }
    case 'replyDone': return { ...enterState(ctx, 'talk'), idleAccumMs: 0 }
    case 'remind': return { ...enterState(ctx, 'greet'), idleAccumMs: 0 }
    default: return ctx
  }
}

export function step(ctx: PetBrainCtx, input: StepInput): { ctx: PetBrainCtx; effects: StepEffects } {
  const cfg = ctx.config
  let next: PetBrainCtx = {
    ...ctx,
    stateElapsedMs: ctx.stateElapsedMs + input.dtMs,
    idleAccumMs: ctx.idleAccumMs + input.dtMs
  }
  let moveX = 0
  let moveY = 0

  if (input.event) next = applyEvent(next, input.event, input.rng)

  switch (next.state) {
    case 'idle': {
      // While paused (dialog open) the pet stays put — no autonomous walk, no sleep.
      if (next.paused) break
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) { next = enterState(next, 'sleep'); break }
      if (next.stateElapsedMs >= next.dwellMs) {
        next = input.rng() < cfg.walkProbability ? enterWalk(next, input.rng) : enterIdle(next, input.rng)
      }
      break
    }
    case 'walk': {
      const stepPx = cfg.walkSpeedPxPerSec * (input.dtMs / 1000)
      const diagonal = next.dirY !== 'none'
      const norm = diagonal ? Math.SQRT1_2 : 1
      let dx = (next.dir === 'left' ? -1 : 1) * stepPx * norm
      let dy = diagonal ? (next.dirY === 'up' ? -1 : 1) * stepPx * norm : 0
      const minX = input.bounds.x
      const maxX = input.bounds.x + input.bounds.width - input.windowWidth
      const minY = input.bounds.y
      const maxY = input.bounds.y + input.bounds.height - input.windowHeight
      const targetX = input.windowX + dx
      const targetY = input.windowY + dy
      let hitEdge = false
      if (targetX <= minX) { dx = minX - input.windowX; hitEdge = true }
      else if (targetX >= maxX) { dx = maxX - input.windowX; hitEdge = true }
      if (targetY <= minY) { dy = minY - input.windowY; hitEdge = true }
      else if (targetY >= maxY) { dy = maxY - input.windowY; hitEdge = true }
      moveX = dx
      moveY = dy
      next = { ...next, walkRemainingPx: next.walkRemainingPx - Math.hypot(dx, dy) }
      if (hitEdge || next.walkRemainingPx <= 0) next = enterIdle(next, input.rng)
      break
    }
    case 'greet': {
      if (next.stateElapsedMs >= cfg.greetMs) next = enterIdle(next, input.rng)
      break
    }
    case 'talk': {
      if (next.stateElapsedMs >= cfg.talkMs) next = enterIdle(next, input.rng)
      break
    }
    // 'drag' / 'thinking' / 'sleep' 持续,直到相应事件(Task 2)
  }

  return { ctx: next, effects: { animation: animationFor(next.state, next.dir), moveX, moveY } }
}
