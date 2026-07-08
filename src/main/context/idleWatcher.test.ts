import { describe, it, expect } from 'vitest'
import { initIdleWatcher, stepIdleWatcher, type IdleWatcherConfig } from './idleWatcher'

const cfg: IdleWatcherConfig = {
  pollIntervalMs: 1000,
  afkThresholdMs: 3000,
  breakThresholdMs: 5000,
  activeResetIdleMs: 2000
}

describe('idleWatcher', () => {
  it('AFK:闲置跨过阈值触发一次,持续闲置不重复,回落后重新武装才能再触发', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 1000, cfg); state = r.state
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 3500, cfg); state = r.state // 跨过 3000 阈值
    expect(r.events).toEqual(['afk_leave'])
    r = stepIdleWatcher(state, 4000, cfg); state = r.state // 仍然闲置,不重复
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // 用户回来,回落
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 3500, cfg); state = r.state // 再次跨过阈值
    expect(r.events).toEqual(['afk_leave'])
  })

  it('久坐:持续活跃累加到阈值触发一次并清零', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=1000
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=2000
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=3000
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=4000
    expect(r.events).toEqual([])
    r = stepIdleWatcher(state, 0, cfg); state = r.state // accum=5000,触发
    expect(r.events).toEqual(['break_reminder'])
    expect(state.activeAccumMs).toBe(0)
  })

  it('久坐:采样闲置达到 activeResetIdleMs 时累加器清零(歇了一下不算数)', () => {
    let state = initIdleWatcher()
    let r = stepIdleWatcher(state, 0, cfg); state = r.state
    r = stepIdleWatcher(state, 0, cfg); state = r.state
    expect(state.activeAccumMs).toBe(2000)
    r = stepIdleWatcher(state, 2000, cfg); state = r.state // 闲置达到 activeResetIdleMs,清零
    expect(state.activeAccumMs).toBe(0)
    expect(r.events).toEqual([])
  })

  it('AFK 触发的同时,久坐累加器按闲置值独立判定(不是因为 AFK 才清零)', () => {
    const state = initIdleWatcher()
    const r = stepIdleWatcher(state, 3500, cfg) // 3500 既 >= afkThresholdMs 也 >= activeResetIdleMs
    expect(r.events).toEqual(['afk_leave'])
    expect(r.state.activeAccumMs).toBe(0)
  })
})
