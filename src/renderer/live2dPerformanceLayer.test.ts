import { describe, expect, it } from 'vitest'
import { performanceWeightAt, type ActivePerformanceLayer } from './live2dPerformanceLayer'

const layer: ActivePerformanceLayer = {
  instruction: {
    parameters: [],
    durationMs: 1000,
    fadeInMs: 200,
    fadeOutMs: 300
  },
  startedAtMs: 1000
}

describe('performanceWeightAt', () => {
  it('applies the requested fade-in, hold, fade-out, and end boundaries', () => {
    expect(performanceWeightAt(layer, 1100)).toBe(0.5)
    expect(performanceWeightAt(layer, 1500)).toBe(1)
    expect(performanceWeightAt(layer, 1850)).toBe(0.5)
    expect(performanceWeightAt(layer, 2000)).toBe(0)
  })

  it('has full weight throughout an instruction with zero fades', () => {
    const instantLayer: ActivePerformanceLayer = {
      instruction: { ...layer.instruction, fadeInMs: 0, fadeOutMs: 0 },
      startedAtMs: 1000
    }

    expect(performanceWeightAt(instantLayer, 1000)).toBe(1)
    expect(performanceWeightAt(instantLayer, 1999)).toBe(1)
  })

  it('returns zero before the supplied layer starts', () => {
    expect(performanceWeightAt(layer, 999)).toBe(0)
  })

  it('evaluates only its supplied layer so replacement remains a caller concern', () => {
    const replacement: ActivePerformanceLayer = {
      instruction: { ...layer.instruction, durationMs: 2000 },
      startedAtMs: 1500
    }

    expect(performanceWeightAt(layer, 1500)).toBe(1)
    expect(performanceWeightAt(replacement, 1500)).toBe(0)
  })
})
