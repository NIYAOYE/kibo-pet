import { describe, it, expect } from 'vitest'
import { computeMouseFocusTarget, computeMouseFocusTick } from './mouseFocus'

const windowBounds = { x: 100, y: 100, width: 200, height: 200 } // 中心 (200, 200)

describe('computeMouseFocusTarget', () => {
  it('光标在窗口中心 → (0, 0)', () => {
    expect(computeMouseFocusTarget({ x: 200, y: 200 }, windowBounds, 900)).toEqual({ x: 0, y: 0 })
  })

  it('光标在中心正右方 → 正 x,y 为 0', () => {
    const t = computeMouseFocusTarget({ x: 650, y: 200 }, windowBounds, 900) // dx=450, radius=900 → x=0.5
    expect(t.x).toBeCloseTo(0.5, 5)
    expect(t.y).toBeCloseTo(0, 5)
  })

  it('光标在中心正上方(屏幕 y 更小)→ 正 y(向上看是正值,与屏幕坐标方向相反)', () => {
    const t = computeMouseFocusTarget({ x: 200, y: -250 }, windowBounds, 900) // dy=-450 → y=+0.5
    expect(t.x).toBeCloseTo(0, 5)
    expect(t.y).toBeCloseTo(0.5, 5)
  })

  it('光标在中心正下方(屏幕 y 更大)→ 负 y', () => {
    const t = computeMouseFocusTarget({ x: 200, y: 650 }, windowBounds, 900) // dy=+450 → y=-0.5
    expect(t.y).toBeCloseTo(-0.5, 5)
  })

  it('超出半径 → (0, 0)', () => {
    expect(computeMouseFocusTarget({ x: 200 + 901, y: 200 }, windowBounds, 900)).toEqual({ x: 0, y: 0 })
  })

  it('刚好在半径边界(沿单轴)→ 分量为 ±1', () => {
    const t = computeMouseFocusTarget({ x: 200 + 900, y: 200 }, windowBounds, 900)
    expect(t.x).toBeCloseTo(1, 5)
  })
})

describe('computeMouseFocusTick', () => {
  const base = {
    cursor: { x: 200, y: 200 },
    windowBounds,
    dragging: false,
    windowVisible: true,
    trackingCapable: true,
    trackingSettingEnabled: true,
    radiusPx: 900
  }

  it('模型不支持鼠标追踪 → null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, trackingCapable: false })).toBeNull()
  })

  it('用户在设置里关闭 → null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, trackingSettingEnabled: false })).toBeNull()
  })

  it('窗口不可见(最小化/锁屏)→ null(不发)', () => {
    expect(computeMouseFocusTick({ ...base, windowVisible: false })).toBeNull()
  })

  it('拖拽中 → 显式发 (0, 0)(不是 null,要主动回正)', () => {
    expect(computeMouseFocusTick({ ...base, dragging: true, cursor: { x: 650, y: 200 } })).toEqual({ x: 0, y: 0 })
  })

  it('正常情况 → 委托给 computeMouseFocusTarget', () => {
    const result = computeMouseFocusTick({ ...base, cursor: { x: 650, y: 200 } })
    expect(result?.x).toBeCloseTo(0.5, 5)
  })
})
