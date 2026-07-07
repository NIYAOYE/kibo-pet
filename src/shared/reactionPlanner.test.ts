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
