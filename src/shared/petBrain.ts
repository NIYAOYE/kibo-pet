export type PetLogicalState = 'idle' | 'walk' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'
export type PetEvent = 'pickup' | 'drop' | 'wake' | 'dialogOpen' | 'messageSent' | 'replyDone'
export type Direction = 'left' | 'right'

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
  talkMs: 1200
}

export interface PetBrainCtx {
  state: PetLogicalState
  dir: Direction
  stateElapsedMs: number
  dwellMs: number
  idleAccumMs: number
  walkRemainingPx: number
  config: PetBrainConfig
}

export interface StepInput {
  dtMs: number
  event?: PetEvent
  bounds: Bounds
  windowX: number
  windowWidth: number
  rng: () => number
}

export interface StepEffects { animation: string; move: number }

export function animationFor(state: PetLogicalState, dir: Direction): string {
  if (state === 'walk') return dir === 'left' ? 'walk-left' : 'walk-right'
  return state
}

export function initBrain(config: Partial<PetBrainConfig> = {}): PetBrainCtx {
  const cfg = { ...DEFAULT_BRAIN_CONFIG, ...config }
  return {
    state: 'idle',
    dir: 'right',
    stateElapsedMs: 0,
    dwellMs: cfg.idleDwellMinMs,
    idleAccumMs: 0,
    walkRemainingPx: 0,
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
  return { ...ctx, state: 'walk', dir, stateElapsedMs: 0, walkRemainingPx: dist }
}

// Task 2 会把各事件分支填满;此处先透传(仅供 Task 1 通过)。
function applyEvent(ctx: PetBrainCtx, _event: PetEvent, _rng: () => number): PetBrainCtx {
  return ctx
}

export function step(ctx: PetBrainCtx, input: StepInput): { ctx: PetBrainCtx; effects: StepEffects } {
  const cfg = ctx.config
  let next: PetBrainCtx = {
    ...ctx,
    stateElapsedMs: ctx.stateElapsedMs + input.dtMs,
    idleAccumMs: ctx.idleAccumMs + input.dtMs
  }
  let move = 0

  if (input.event) next = applyEvent(next, input.event, input.rng)

  switch (next.state) {
    case 'idle': {
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) { next = enterState(next, 'sleep'); break }
      if (next.stateElapsedMs >= next.dwellMs) {
        next = input.rng() < cfg.walkProbability ? enterWalk(next, input.rng) : enterIdle(next, input.rng)
      }
      break
    }
    case 'walk': {
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) { next = enterState(next, 'sleep'); break }
      const stepPx = cfg.walkSpeedPxPerSec * (input.dtMs / 1000)
      let dx = next.dir === 'left' ? -stepPx : stepPx
      const minX = input.bounds.x
      const maxX = input.bounds.x + input.bounds.width - input.windowWidth
      const targetX = input.windowX + dx
      let hitEdge = false
      if (targetX <= minX) { dx = minX - input.windowX; hitEdge = true }
      else if (targetX >= maxX) { dx = maxX - input.windowX; hitEdge = true }
      move = dx
      next = { ...next, walkRemainingPx: next.walkRemainingPx - Math.abs(dx) }
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

  return { ctx: next, effects: { animation: animationFor(next.state, next.dir), move } }
}
