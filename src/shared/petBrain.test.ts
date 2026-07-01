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

  it('does not fall asleep mid-walk; only drifts to sleep once idle', () => {
    const walking = {
      ...initBrain(),
      state: 'walk' as const,
      dir: 'right' as const,
      walkRemainingPx: 10000,
      idleAccumMs: DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs - 100
    }
    const res = step(walking, input({ dtMs: 5000, windowX: 100, rng: () => 0.5 }))
    expect(res.ctx.idleAccumMs).toBeGreaterThanOrEqual(DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs)
    expect(res.ctx.state).toBe('walk') // still walking, NOT asleep mid-stride
  })

  it('carries accumulated idle time across a walk so it sleeps once idle', () => {
    const walking = {
      ...initBrain(),
      state: 'walk' as const,
      dir: 'right' as const,
      walkRemainingPx: 1,
      idleAccumMs: DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs + 1000
    }
    const afterWalk = step(walking, input({ dtMs: 100, windowX: 100, rng: () => 0.5 })) // walk ends → idle
    expect(afterWalk.ctx.state).toBe('idle')
    const asleep = step(afterWalk.ctx, input({ dtMs: 100, rng: () => 0.9 })) // idle branch sees timer past threshold
    expect(asleep.ctx.state).toBe('sleep')
  })
})

describe('petBrain events', () => {
  it('pickup → drag, drop → idle', () => {
    let res = step(initBrain(), input({ event: 'pickup' }))
    expect(res.ctx.state).toBe('drag')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = step(res.ctx, input({ dtMs: 1000 })) // drag persists without an event
    expect(res.ctx.state).toBe('drag')
    res = step(res.ctx, input({ event: 'drop', rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('messageSent → thinking (persists), replyDone → talk → idle', () => {
    let res = step(initBrain(), input({ event: 'messageSent' }))
    expect(res.ctx.state).toBe('thinking')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = step(res.ctx, input({ dtMs: 5000 })) // persists without event
    expect(res.ctx.state).toBe('thinking')
    res = step(res.ctx, input({ event: 'replyDone' }))
    expect(res.ctx.state).toBe('talk')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.talkMs + 10, rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('dialogOpen → greet → idle after greetMs', () => {
    let res = step(initBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.greetMs + 10, rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('wake from sleep returns to idle and resets the sleep timer', () => {
    const sleeping = { ...initBrain(), state: 'sleep' as const, idleAccumMs: 99999 }
    const res = step(sleeping, input({ event: 'wake', rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('any interaction resets the sleep timer (pickup)', () => {
    const almost = { ...initBrain(), idleAccumMs: 40000 }
    const res = step(almost, input({ event: 'pickup' }))
    expect(res.ctx.idleAccumMs).toBe(0)
  })
})

describe('petBrain pause (dialog open)', () => {
  it('dialogOpen pauses: no walk and no sleep while paused', () => {
    let res = step(initBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.paused).toBe(true)
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.greetMs + 10, rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.paused).toBe(true)
    // Past dwell (rng would pick walk) AND past sleep threshold — still idle.
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs + 10000, rng: () => 0 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('dialogClose unpauses and autonomous walk resumes', () => {
    let res = step(initBrain(), input({ event: 'dialogOpen' }))
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.greetMs + 10, rng: () => 0.5 }))
    expect(res.ctx.paused).toBe(true)
    res = step(res.ctx, input({ event: 'dialogClose', rng: () => 0 })) // enterIdle dwell = min (2000)
    expect(res.ctx.paused).toBe(false)
    expect(res.ctx.state).toBe('idle')
    res = step(res.ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.5]) }))
    expect(res.ctx.state).toBe('walk')
  })
})
