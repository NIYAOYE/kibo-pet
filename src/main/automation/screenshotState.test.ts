import { describe, it, expect } from 'vitest'
import { createScreenshotState } from './screenshotState'

const rec = {
  displayId: '1', originX: 0, originY: 0,
  physicalWidth: 1920, physicalHeight: 1080,
  imageWidth: 960, imageHeight: 540 // 降采样到一半
}

describe('createScreenshotState', () => {
  it('未 record 时 current() 为 null,toPhysicalPoint 返回 null', () => {
    const s = createScreenshotState()
    expect(s.current()).toBeNull()
    expect(s.toPhysicalPoint(10, 10)).toBeNull()
  })

  it('record 后按缩放比换算图像坐标 → 物理屏幕坐标', () => {
    const s = createScreenshotState()
    s.record(rec)
    expect(s.toPhysicalPoint(100, 50)).toEqual({ x: 200, y: 100 }) // ×2 缩放
  })

  it('换算叠加显示器物理原点偏移', () => {
    const s = createScreenshotState()
    s.record({ ...rec, originX: 1920, originY: 0 }) // 第二个显示器,原点在右侧
    expect(s.toPhysicalPoint(0, 0)).toEqual({ x: 1920, y: 0 })
  })

  it('越界坐标被夹回显示器物理范围内', () => {
    const s = createScreenshotState()
    s.record(rec)
    expect(s.toPhysicalPoint(-50, -50)).toEqual({ x: 0, y: 0 })
    expect(s.toPhysicalPoint(99999, 99999)).toEqual({ x: 1919, y: 1079 })
  })

  it('reset 后回到未截屏状态', () => {
    const s = createScreenshotState()
    s.record(rec)
    s.reset()
    expect(s.current()).toBeNull()
    expect(s.toPhysicalPoint(1, 1)).toBeNull()
  })
})
