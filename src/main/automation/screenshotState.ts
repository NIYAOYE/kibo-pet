export interface ScreenshotRecord {
  displayId: string
  /** 该显示器左上角在"物理像素"坐标系里的原点(已乘 scaleFactor) */
  originX: number
  originY: number
  /** 该显示器的物理分辨率(已乘 scaleFactor) */
  physicalWidth: number
  physicalHeight: number
  /** 发给模型的降采样后图像分辨率 —— click_at 的 x,y 以此为基准 */
  imageWidth: number
  imageHeight: number
}

export interface ScreenshotState {
  record(r: ScreenshotRecord): void
  current(): ScreenshotRecord | null
  reset(): void
  /** 把"最近一次截屏图像"坐标系里的 (x,y) 换算成物理屏幕坐标;未截屏过返回 null */
  toPhysicalPoint(x: number, y: number): { x: number; y: number } | null
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

export function createScreenshotState(): ScreenshotState {
  let rec: ScreenshotRecord | null = null
  return {
    record(r) { rec = r },
    current: () => rec,
    reset() { rec = null },
    toPhysicalPoint(x, y) {
      if (!rec) return null
      const scaleX = rec.physicalWidth / rec.imageWidth
      const scaleY = rec.physicalHeight / rec.imageHeight
      const px = Math.round(rec.originX + x * scaleX)
      const py = Math.round(rec.originY + y * scaleY)
      return {
        x: clamp(px, rec.originX, rec.originX + rec.physicalWidth - 1),
        y: clamp(py, rec.originY, rec.originY + rec.physicalHeight - 1)
      }
    }
  }
}
