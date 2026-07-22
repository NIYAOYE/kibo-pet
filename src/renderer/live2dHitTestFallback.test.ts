import { describe, it, expect } from 'vitest'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'

describe('pointInBounds', () => {
  const bounds = { x: 10, y: 20, width: 100, height: 50 }

  it('点在包围盒内部返回 true', () => {
    expect(pointInBounds(bounds, 50, 40)).toBe(true)
  })

  it('点在左上角边界上返回 true(含边界)', () => {
    expect(pointInBounds(bounds, 10, 20)).toBe(true)
  })

  it('点在右下角边界上返回 true(含边界)', () => {
    expect(pointInBounds(bounds, 110, 70)).toBe(true)
  })

  it('点在包围盒外部返回 false', () => {
    expect(pointInBounds(bounds, 9, 40)).toBe(false)
    expect(pointInBounds(bounds, 50, 71)).toBe(false)
  })
})

describe('toCanvasCoords', () => {
  it('DPI 缩放场景下只做 CSS 偏移换算,不受 canvas.width/height(物理分辨率)影响', () => {
    // 模拟 Pixi autoDensity:true + resolution:devicePixelRatio(如 150% 缩放)初始化后的 canvas:
    // backing-store 的 width/height 被放大到物理分辨率(384x432),但 CSS 尺寸(getBoundingClientRect
    // 返回的 width/height)仍是逻辑尺寸(256x288)。model.hitTest()/getBounds() 用的是逻辑坐标系,
    // 所以正确的换算应该只减去 rect 的偏移,完全不理会 canvas.width/height。
    const fakeCanvas = {
      width: 384,
      height: 432,
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 256,
        height: 288,
        right: 266,
        bottom: 308,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    } as unknown as HTMLCanvasElement

    const result = toCanvasCoords(fakeCanvas, 60, 90)

    expect(result).toEqual({ x: 50, y: 70 })
  })

  it('对非默认(非 256x288)窗口尺寸的 canvas 同样只做 CSS 偏移换算——动态窗口尺寸下这条数学不需要变', () => {
    const fakeCanvas = {
      width: 1200, height: 1350, // 物理分辨率,假设是 800x900 逻辑尺寸 * 1.5 resolutionCap
      getBoundingClientRect: () => ({
        left: 5, top: 8, width: 800, height: 900, right: 805, bottom: 908, x: 5, y: 8, toJSON: () => ({})
      })
    } as unknown as HTMLCanvasElement

    expect(toCanvasCoords(fakeCanvas, 105, 208)).toEqual({ x: 100, y: 200 })
  })
})
