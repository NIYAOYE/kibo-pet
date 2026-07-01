import { describe, it, expect } from 'vitest'
import { initBrain, step, animationFor, DEFAULT_BRAIN_CONFIG, type StepInput } from './petBrain'

const BOUNDS = { x: 0, y: 0, width: 1000, height: 800 }

function rngSeq(values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0)
}

function input(partial: Partial<StepInput> = {}): StepInput {
  return { dtMs: 100, bounds: BOUNDS, windowX: 500, windowWidth: 256, rng: () => 0, ...partial }
}

describe('petBrain autonomous', () => {
  it('maps walk to a directional animation, other states to their own name', () => {
    expect(animationFor('walk', 'left')).toBe('walk-left')
    expect(animationFor('walk', 'right')).toBe('walk-right')
    expect(animationFor('idle', 'right')).toBe('idle')
    expect(animationFor('sleep', 'left')).toBe('sleep')
  })

  it('starts in idle', () => {
    expect(initBrain().state).toBe('idle')
  })

  it('transitions idle → walk after dwell when rng favors walking', () => {
    const ctx = initBrain() // dwellMs = idleDwellMinMs = 2000
    const res = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.5]) }))
    expect(res.ctx.state).toBe('walk')
    expect(res.ctx.dir).toBe('right')
    expect(res.ctx.walkRemainingPx).toBeGreaterThan(0)
  })

  it('stays idle and re-rolls dwell when rng favors staying', () => {
    const ctx = initBrain()
    const res = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.9, 0.3]) }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.stateElapsedMs).toBe(0)
  })

  it('emits directional movement while walking and returns to idle when distance consumed', () => {
    let ctx = initBrain()
    ctx = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.5]) })).ctx // walk right, dist 170
    const res = step(ctx, input({ dtMs: 1000, windowX: 500, rng: () => 0.9 }))
    expect(res.effects.move).toBeCloseTo(40) // 40px/s * 1s
    expect(res.ctx.walkRemainingPx).toBeCloseTo(130)
    expect(res.ctx.state).toBe('walk')
  })

  it('clamps at work-area edge and ends the walk', () => {
    let ctx = initBrain()
    ctx = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.9]) })).ctx // walk right, dist ~242
    const res = step(ctx, input({ dtMs: 1000, windowX: 730, rng: () => 0 })) // maxX = 1000-256 = 744
    expect(res.effects.move).toBeCloseTo(14)
    expect(res.ctx.state).toBe('idle')
  })

  it('falls asleep after prolonged idle without interaction', () => {
    let res = { ctx: initBrain(), effects: { animation: 'idle', move: 0 } }
    let total = 0
    while (total < DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs) {
      res = step(res.ctx, input({ dtMs: 5000, rng: () => 0.9 })) // always stay idle
      total += 5000
    }
    expect(res.ctx.state).toBe('sleep')
  })
})
