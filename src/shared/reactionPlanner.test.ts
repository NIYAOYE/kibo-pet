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
      ['idle', 'long_idle', 'wake', 'click', 'drag', 'greet', 'farewell', 'sleep', 'break', 'app_focus']
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

  it('app_focus → app_focus category', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'app_focus', pausedByDialog: false, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBe('app_focus')
  })

  it('pausedByDialog 时 app_focus 也静音', () => {
    const r = stepReaction(initReaction(cfg), { dtMs: 16, trigger: 'app_focus', pausedByDialog: true, sleeping: false, nowMs: NOON_MS, rng })
    expect(r.output.speak).toBeUndefined()
  })
})
