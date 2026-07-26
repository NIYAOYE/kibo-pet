import type { Live2DPerformanceInstruction } from '@shared/live2dPerformance'

export interface ActivePerformanceLayer {
  instruction: Live2DPerformanceInstruction
  startedAtMs: number
}

function clampWeight(weight: number): number {
  return Math.min(Math.max(weight, 0), 1)
}

/** Returns the current envelope weight for one active performance instruction. */
export function performanceWeightAt(layer: ActivePerformanceLayer, nowMs: number): number {
  const elapsedMs = nowMs - layer.startedAtMs
  const { durationMs, fadeInMs, fadeOutMs } = layer.instruction
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || elapsedMs < 0 || elapsedMs >= durationMs) {
    return 0
  }

  let weight = 1
  if (fadeInMs > 0) weight = Math.min(weight, elapsedMs / fadeInMs)
  if (fadeOutMs > 0) weight = Math.min(weight, (durationMs - elapsedMs) / fadeOutMs)
  return clampWeight(weight)
}
