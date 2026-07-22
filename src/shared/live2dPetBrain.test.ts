import { describe, it, expect } from 'vitest'
import { initLive2DBrain, stepLive2D, DEFAULT_LIVE2D_BRAIN_CONFIG, type Live2DStepInput } from './live2dPetBrain'

function input(partial: Partial<Live2DStepInput> = {}): Live2DStepInput {
  return {
    dtMs: 100,
    rng: () => 0,
    ...partial
  }
}

describe('live2dPetBrain autonomous', () => {
  it('starts in idle', () => {
    expect(initLive2DBrain().state).toBe('idle')
  })

  it('falls asleep after prolonged idle without interaction', () => {
    let res = { ctx: initLive2DBrain(), effects: { animation: 'idle' } }
    let total = 0
    while (total < DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs) {
      res = stepLive2D(res.ctx, input({ dtMs: 5000 }))
      total += 5000
    }
    expect(res.ctx.state).toBe('sleep')
  })

  it('stays idle (no walk option exists) until the sleep threshold is hit', () => {
    const res = stepLive2D(initLive2DBrain(), input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs - 100 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.effects.animation).toBe('idle')
  })
})

describe('live2dPetBrain events', () => {
  it('pickup → drag, drop → idle', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'pickup' }))
    expect(res.ctx.state).toBe('drag')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: 1000 })) // drag persists without an event
    expect(res.ctx.state).toBe('drag')
    res = stepLive2D(res.ctx, input({ event: 'drop' }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('messageSent → thinking (persists), replyDone → talk → idle after talkMs', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'messageSent' }))
    expect(res.ctx.state).toBe('thinking')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: 5000 })) // persists without event
    expect(res.ctx.state).toBe('thinking')
    res = stepLive2D(res.ctx, input({ event: 'replyDone' }))
    expect(res.ctx.state).toBe('talk')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.talkMs + 10 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('dialogOpen → greet → idle after greetMs', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.idleAccumMs).toBe(0)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('wake from sleep returns to idle and resets the sleep timer', () => {
    const sleeping = { ...initLive2DBrain(), state: 'sleep' as const, idleAccumMs: 99999 }
    const res = stepLive2D(sleeping, input({ event: 'wake' }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('any interaction resets the sleep timer (pickup)', () => {
    const almost = { ...initLive2DBrain(), idleAccumMs: 40000 }
    const res = stepLive2D(almost, input({ event: 'pickup' }))
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it("'remind' 使宠物进入 greet(复用打招呼动画)", () => {
    const res = stepLive2D(initLive2DBrain(), input({ dtMs: 0, event: 'remind' }))
    expect(res.ctx.state).toBe('greet')
  })
})

describe('live2dPetBrain pause (dialog open)', () => {
  it('dialogOpen pauses: no sleep while paused, even past the sleep threshold', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs + 10000 }))
    expect(res.ctx.state).toBe('idle') // still idle, not asleep — paused suppresses the sleep drift
  })

  it('dialogClose unpauses and idle resumes counting toward sleep', () => {
    let res = stepLive2D(initLive2DBrain(), input({ event: 'dialogOpen' }))
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.greetMs + 10 }))
    expect(res.ctx.paused).toBe(true)
    res = stepLive2D(res.ctx, input({ event: 'dialogClose' }))
    expect(res.ctx.paused).toBe(false)
    expect(res.ctx.state).toBe('idle')
    res = stepLive2D(res.ctx, input({ dtMs: DEFAULT_LIVE2D_BRAIN_CONFIG.sleepAfterIdleMs + 10 }))
    expect(res.ctx.state).toBe('sleep')
  })
})
