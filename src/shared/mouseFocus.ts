import type { Bounds } from './petBrain'

/** 光标离宠物窗口中心多远以内才追踪,屏幕像素,常量不做成设置项(YAGNI,已与用户确认)。 */
export const DEFAULT_MOUSE_TRACK_RADIUS_PX = 900

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 光标屏幕坐标相对宠物窗口中心的偏移,归一化到 [-1,1] 喂给 Live2DModel.focus()。
 *  垂直方向取反:屏幕坐标 y 向下增大,但 Cubism 的 ParamAngleY/EyeBallY 约定正值=向上看。
 *  超出 radiusPx → (0,0)(不追踪,回正)。 */
export function computeMouseFocusTarget(
  cursor: { x: number; y: number },
  windowBounds: Bounds,
  radiusPx: number
): { x: number; y: number } {
  const cx = windowBounds.x + windowBounds.width / 2
  const cy = windowBounds.y + windowBounds.height / 2
  const dx = cursor.x - cx
  const dy = cursor.y - cy
  if (Math.hypot(dx, dy) > radiusPx) return { x: 0, y: 0 }
  return { x: clamp(dx / radiusPx, -1, 1) + 0, y: clamp(-dy / radiusPx, -1, 1) + 0 }
}

export interface MouseFocusTickInput {
  cursor: { x: number; y: number }
  windowBounds: Bounds
  dragging: boolean
  windowVisible: boolean
  trackingCapable: boolean
  trackingSettingEnabled: boolean
  radiusPx: number
}

/** 主进程轮询循环每 tick 调一次,决定这次要不要往渲染进程推 MOUSE_FOCUS。
 *  返回 null = 这次什么都不发(功能关闭/模型不支持/窗口不可见);
 *  返回非 null 时必须发出去,哪怕是 (0,0)——那是"主动回正"的目标,不是"不用发"的信号。 */
export function computeMouseFocusTick(input: MouseFocusTickInput): { x: number; y: number } | null {
  if (!input.trackingCapable || !input.trackingSettingEnabled || !input.windowVisible) return null
  if (input.dragging) return { x: 0, y: 0 }
  return computeMouseFocusTarget(input.cursor, input.windowBounds, input.radiusPx)
}
