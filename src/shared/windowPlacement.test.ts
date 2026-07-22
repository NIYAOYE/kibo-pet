import { describe, expect, it } from 'vitest'
import { fixedWindowBounds, isZeroMove, clamp, clampLive2DViewport, footAnchorPreservingBounds, windowSizeForSource } from './windowPlacement'
import type { PetRenderSource } from './petPackage'

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

describe('clamp', () => {
  it('低于下限时夹到下限', () => {
    expect(clamp(-10, 0, 100)).toBe(0)
  })
  it('高于上限时夹到上限', () => {
    expect(clamp(200, 0, 100)).toBe(100)
  })
  it('区间内原样返回', () => {
    expect(clamp(42, 0, 100)).toBe(42)
  })
  it('恰好等于边界值时原样返回', () => {
    expect(clamp(0, 0, 100)).toBe(0)
    expect(clamp(100, 0, 100)).toBe(100)
  })
})

describe('clampLive2DViewport', () => {
  it('落在范围内的尺寸原样返回', () => {
    expect(clampLive2DViewport({ width: 360, height: 480, resolutionCap: 1.5 })).toEqual({ width: 360, height: 480 })
  })
  it('小于最小值时夹到最小 192x256', () => {
    expect(clampLive2DViewport({ width: 100, height: 100, resolutionCap: 1.5 })).toEqual({ width: 192, height: 256 })
  })
  it('大于最大值时夹到最大 800x900', () => {
    expect(clampLive2DViewport({ width: 2000, height: 2000, resolutionCap: 1.5 })).toEqual({ width: 800, height: 900 })
  })
  it('宽高各自独立夹取,不保持原始宽高比', () => {
    expect(clampLive2DViewport({ width: 100, height: 480, resolutionCap: 1.5 })).toEqual({ width: 192, height: 480 })
  })
})

describe('footAnchorPreservingBounds', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('尺寸不变时脚底中心点(水平中心/底边)绝对坐标不变', () => {
    const oldBounds = { x: 100, y: 100, width: 360, height: 480 }
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 480 }, workArea)
    expect(result).toEqual(oldBounds)
  })

  it('切到更高的模型时,脚底(底边中心)绝对坐标保持不变,窗口向上扩展', () => {
    const oldBounds = { x: 100, y: 500, width: 360, height: 480 } // 脚底中心 = (280, 980)
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 700 }, workArea)
    // 新脚底中心 = (result.x + 180, result.y + 700) 应仍等于 (280, 980)
    expect(result.x + 180).toBe(280)
    expect(result.y + 700).toBe(980)
    expect(result.width).toBe(360)
    expect(result.height).toBe(700)
  })

  it('结果始终被夹进 workArea 内(超出工作区时夹取,不越界)', () => {
    const oldBounds = { x: 10, y: 10, width: 360, height: 480 } // 脚底中心 y = 490,顶部很靠近工作区上边缘
    const result = footAnchorPreservingBounds(oldBounds, { width: 360, height: 900 }, workArea)
    expect(result.y).toBeGreaterThanOrEqual(workArea.y)
    expect(result.x).toBeGreaterThanOrEqual(workArea.x)
    expect(result.x + result.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(result.y + result.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })
})

describe('windowSizeForSource', () => {
  it('sprite 包:窗口尺寸 = sheet 格子尺寸,不夹取', () => {
    const source: PetRenderSource = {
      type: 'sprite',
      manifest: { id: 'x', displayName: 'x', description: '', spritesheetPath: 'x', sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }, animations: { idle: { row: 0, frames: 1, fps: 1, loop: true } } },
      spritesheetDataUrl: 'data:x'
    }
    expect(windowSizeForSource(source)).toEqual({ width: 192, height: 208 })
  })

  it('live2d 包:窗口尺寸 = 夹取后的 render.viewport', () => {
    const source: PetRenderSource = {
      type: 'live2d',
      manifest: {
        schemaVersion: 2, id: 'x', displayName: 'x', description: '',
        render: {
          type: 'live2d', model: 'model/x.model3.json',
          viewport: { width: 2000, height: 480, resolutionCap: 1.5 },
          transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
          interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
          stateMap: {}
        }
      },
      resourceBaseUrl: 'kibo-pet://tok/'
    }
    expect(windowSizeForSource(source)).toEqual({ width: 800, height: 480 })
  })
})
