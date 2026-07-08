export function hasManualOverride(
  aiPos: { x: number; y: number },
  currentPos: { x: number; y: number },
  thresholdPx: number
): boolean {
  const dx = currentPos.x - aiPos.x
  const dy = currentPos.y - aiPos.y
  return Math.sqrt(dx * dx + dy * dy) > thresholdPx
}

export interface LastAiPosTracker {
  set(p: { x: number; y: number }): void
  get(): { x: number; y: number } | null
  clear(): void
}

export function createLastAiPosTracker(): LastAiPosTracker {
  let pos: { x: number; y: number } | null = null
  return { set: (p) => { pos = p }, get: () => pos, clear: () => { pos = null } }
}

export interface ManualOverrideWatch { stop(): void }

/**
 * 轮询真实光标位置;若与"AI 最近一次设置的光标位置"偏差超过阈值(意味着人已经
 * 用手抓住了鼠标),立即触发 onOverride(调用方接 cancel())。定时器可注入以便单测。
 */
export function startManualOverrideWatch(opts: {
  getCursorPos: () => { x: number; y: number }
  getLastAiPos: () => { x: number; y: number } | null
  thresholdPx?: number
  intervalMs?: number
  onOverride: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}): ManualOverrideWatch {
  const threshold = opts.thresholdPx ?? 40
  const interval = opts.intervalMs ?? 250
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout))
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    const last = opts.getLastAiPos()
    if (!last) return
    const cur = opts.getCursorPos()
    if (hasManualOverride(last, cur, threshold)) {
      stopped = true
      clearTimer(handle)
      opts.onOverride()
    }
  }
  const handle = setTimer(tick, interval)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearTimer(handle)
    }
  }
}
