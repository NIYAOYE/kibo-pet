import type { Bounds } from './petBrain'
import type { Live2DViewport, PetRenderSource } from './petPackage'

export interface FixedSize {
  width: number
  height: number
}

export function fixedWindowBounds(x: number, y: number, size: FixedSize): Bounds {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  }
}

export function isZeroMove(delta: { dx: number; dy: number }): boolean {
  return delta.dx === 0 && delta.dy === 0
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

const LIVE2D_VIEWPORT_MIN = { width: 192, height: 256 }
const LIVE2D_VIEWPORT_MAX = { width: 800, height: 900 }

/** Live2D 包窗口尺寸的夹取范围,见主设计文档 §9。宽高各自独立夹取,不保持原始宽高比——
 *  夹取的目的是避免窗口过小/过大,不是等比缩放。 */
export function clampLive2DViewport(viewport: Live2DViewport): FixedSize {
  return {
    width: clamp(viewport.width, LIVE2D_VIEWPORT_MIN.width, LIVE2D_VIEWPORT_MAX.width),
    height: clamp(viewport.height, LIVE2D_VIEWPORT_MIN.height, LIVE2D_VIEWPORT_MAX.height)
  }
}

const FOOT_ANCHOR = { x: 0.5, y: 1.0 } // 窗口内容区的水平中心、底部边缘,与 autoFit 的"贴底居中"惯例一致

/** 窗口尺寸变化(热切换/首次加载)时保持脚底锚点在屏幕上的绝对位置不跳动,再夹进当前
 *  显示器工作区。只在尺寸真正变化时调用一次,不参与逐帧拖拽路径(拖拽路径继续只用
 *  setPosition,见 Phase 5 设计文档 §4)。仅对 Live2D 包生效。 */
export function footAnchorPreservingBounds(oldBounds: Bounds, newSize: FixedSize, workArea: Bounds): Bounds {
  const anchorAbsX = oldBounds.x + FOOT_ANCHOR.x * oldBounds.width
  const anchorAbsY = oldBounds.y + FOOT_ANCHOR.y * oldBounds.height
  const rawX = anchorAbsX - FOOT_ANCHOR.x * newSize.width
  const rawY = anchorAbsY - FOOT_ANCHOR.y * newSize.height
  const x = clamp(rawX, workArea.x, workArea.x + workArea.width - newSize.width)
  const y = clamp(rawY, workArea.y, workArea.y + workArea.height - newSize.height)
  return { x, y, ...newSize }
}

/** 宠物窗口尺寸的单一数据源:sprite 包 = sheet 格子尺寸(不夹取,行为与现状字节对齐);
 *  live2d 包 = 夹取后的 render.viewport。取代此前主进程/渲染层各自硬编码的 256×288。 */
export function windowSizeForSource(source: PetRenderSource): FixedSize {
  if (source.type === 'sprite') {
    return { width: source.manifest.sheet.cellWidth, height: source.manifest.sheet.cellHeight }
  }
  return clampLive2DViewport(source.manifest.render.viewport)
}
