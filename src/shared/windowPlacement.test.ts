import { describe, expect, it } from 'vitest'
import { fixedWindowBounds, isZeroMove } from './windowPlacement'

describe('fixedWindowBounds', () => {
  it('每次都返回整数坐标和调用方声明的固定尺寸', () => {
    expect(fixedWindowBounds(932.6, 207.5, { width: 240, height: 172 })).toEqual({
      x: 933,
      y: 208,
      width: 240,
      height: 172
    })
  })

  it('重复计算不可落地的 DPI 坐标时结果不累计变化', () => {
    const results = Array.from({ length: 200 }, () =>
      fixedWindowBounds(933, 208, { width: 240, height: 172 })
    )

    expect(new Set(results.map((b) => `${b.x},${b.y},${b.width},${b.height}`))).toEqual(
      new Set(['933,208,240,172'])
    )
  })
})

describe('isZeroMove', () => {
  it('只把两个方向都为零的位移视为无效移动', () => {
    expect(isZeroMove({ dx: 0, dy: 0 })).toBe(true)
    expect(isZeroMove({ dx: 1, dy: 0 })).toBe(false)
    expect(isZeroMove({ dx: 0, dy: -1 })).toBe(false)
  })
})
