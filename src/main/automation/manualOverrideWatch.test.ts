import { describe, it, expect, vi } from 'vitest'
import { hasManualOverride, createLastAiPosTracker, startManualOverrideWatch } from './manualOverrideWatch'

describe('hasManualOverride', () => {
  it('距离在阈值内 → false', () => {
    expect(hasManualOverride({ x: 100, y: 100 }, { x: 110, y: 100 }, 40)).toBe(false)
  })
  it('距离超过阈值 → true', () => {
    expect(hasManualOverride({ x: 100, y: 100 }, { x: 200, y: 100 }, 40)).toBe(true)
  })
  it('对角线距离用欧氏距离,不是曼哈顿距离', () => {
    // dx=30, dy=30 → 欧氏距离≈42.4 > 40阈值,但曼哈顿距离60也>40,换一组能区分的:
    expect(hasManualOverride({ x: 0, y: 0 }, { x: 28, y: 28 }, 40)).toBe(false) // 欧氏≈39.6 < 40
  })
})

describe('createLastAiPosTracker', () => {
  it('未 set 时 get() 为 null;set 后能读回', () => {
    const t = createLastAiPosTracker()
    expect(t.get()).toBeNull()
    t.set({ x: 5, y: 6 })
    expect(t.get()).toEqual({ x: 5, y: 6 })
  })

  it('set 后 clear() → get() 回到 null', () => {
    const t = createLastAiPosTracker()
    t.set({ x: 5, y: 6 })
    expect(t.get()).toEqual({ x: 5, y: 6 })
    t.clear()
    expect(t.get()).toBeNull()
  })
})

describe('startManualOverrideWatch', () => {
  function fakeTimer() {
    let cb: (() => void) | null = null
    return {
      setTimer: (fn: () => void) => { cb = fn; return 'handle' },
      clearTimer: () => { cb = null },
      fire: () => cb?.()
    }
  }

  it('光标偏离超过阈值 → 触发 onOverride 且只触发一次', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    let cursor = { x: 100, y: 100 }
    startManualOverrideWatch({
      getCursorPos: () => cursor,
      getLastAiPos: () => ({ x: 100, y: 100 }),
      thresholdPx: 40,
      onOverride,
      setTimer, clearTimer
    })
    fire() // 未偏离
    expect(onOverride).not.toHaveBeenCalled()
    cursor = { x: 300, y: 100 }
    fire() // 偏离
    expect(onOverride).toHaveBeenCalledTimes(1)
    fire() // 已停止,不再重复触发
    expect(onOverride).toHaveBeenCalledTimes(1)
  })

  it('尚未有 lastAiPos(AI 还没点过)时不触发', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    startManualOverrideWatch({
      getCursorPos: () => ({ x: 999, y: 999 }),
      getLastAiPos: () => null,
      onOverride,
      setTimer, clearTimer
    })
    fire()
    expect(onOverride).not.toHaveBeenCalled()
  })

  it('stop() 后不再触发', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    const watch = startManualOverrideWatch({
      getCursorPos: () => ({ x: 500, y: 500 }),
      getLastAiPos: () => ({ x: 0, y: 0 }),
      onOverride,
      setTimer, clearTimer
    })
    watch.stop()
    fire()
    expect(onOverride).not.toHaveBeenCalled()
  })
})
