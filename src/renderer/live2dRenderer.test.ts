import { describe, expect, it, vi } from 'vitest'
import type { Live2DManifest } from '@shared/petPackage'
import type { Live2DPerformanceInstruction } from '@shared/live2dPerformance'
import type { ActivePerformanceLayer } from './live2dPerformanceLayer'
import {
  applyActivePerformanceLayer,
  attachPerformanceAfterBaseline,
  collectLive2DCapabilitySnapshot,
  playResolvedState,
  replaceActivePerformanceLayer,
  type CubismCoreParameterApi
} from './live2dPerformanceRuntime'

function makeCore(ids: string[]): CubismCoreParameterApi & { setParameterValueByIndex: ReturnType<typeof vi.fn> } {
  return {
    getParameterCount: () => ids.length,
    getParameterId: (index) => ({ getString: () => ({ s: ids[index] }) }),
    getParameterMinimumValue: () => -30,
    getParameterMaximumValue: () => 30,
    getParameterDefaultValue: () => 0,
    setParameterValueByIndex: vi.fn()
  }
}

describe('Live2D renderer performance helpers', () => {
  it('keeps a fading-in performance layer active at its zero-weight start', () => {
    const core = makeCore(['ParamMouthForm'])
    const layer = replaceActivePerformanceLayer(null, {
      parameters: [{ id: 'ParamMouthForm', value: 5, weight: 1 }], durationMs: 500, fadeInMs: 200, fadeOutMs: 0
    }, 1000)

    expect(applyActivePerformanceLayer(layer, core, new Map([['ParamMouthForm', 0]]), 'ParamMouthOpenY', 1000)).toEqual(layer)
    expect(core.setParameterValueByIndex).not.toHaveBeenCalled()
  })

  it('applies the overlay from the engine post-baseline hook after its baseline write', () => {
    const order: string[] = []
    const core = makeCore(['ParamMouthForm'])
    core.setParameterValueByIndex.mockImplementation(() => { order.push('overlay') })
    const listeners = new Set<() => void>()
    const internalModel = {
      on(event: string, listener: () => void) {
        if (event === 'beforeModelUpdate') listeners.add(listener)
      },
      off(event: string, listener: () => void) {
        if (event === 'beforeModelUpdate') listeners.delete(listener)
      }
    }
    const layer = replaceActivePerformanceLayer(null, {
      parameters: [{ id: 'ParamMouthForm', value: 5, weight: 1 }], durationMs: 500, fadeInMs: 0, fadeOutMs: 0
    }, 1000)
    const detach = attachPerformanceAfterBaseline(internalModel, () => {
      applyActivePerformanceLayer(layer, core, new Map([['ParamMouthForm', 0]]), 'ParamMouthOpenY', 1000)
    })

    order.push('baseline')
    for (const listener of listeners) listener()
    detach()

    expect(order).toEqual(['baseline', 'overlay'])
    expect(listeners).toHaveLength(0)
  })

  it('plays an expression-only state without invoking a motion or idle fallback', async () => {
    const startMotion = vi.fn(async () => false)
    const playExpression = vi.fn()

    const result = await playResolvedState(
      { motionGroup: undefined, selection: 'random', expression: 'smile' },
      startMotion,
      playExpression
    )

    expect(result).toEqual({ motionAttempted: false, motionSucceeded: false })
    expect(playExpression).toHaveBeenCalledWith('smile')
    expect(startMotion).not.toHaveBeenCalled()
  })

  it('still invokes a declared expression when its motion attempt rejects', async () => {
    const startMotion = vi.fn(async () => { throw new Error('missing motion') })
    const playExpression = vi.fn()

    await expect(playResolvedState(
      { motionGroup: 'TapBody', selection: 'random', expression: 'smile' },
      startMotion,
      playExpression
    )).rejects.toThrow('missing motion')

    expect(playExpression).toHaveBeenCalledWith('smile')
  })

  it('enumerates visible Core controls and declared expression names for the manifest pet id', () => {
    const snapshot = collectLive2DCapabilitySnapshot(
      { id: 'BQD' } as Live2DManifest,
      makeCore(['ParamAngleX', 'ParamEyeBallY', 'ParamMouthForm', 'ParamPhysicsRAM_BodyX']),
      [{ Name: 'smile' }, { Name: 'sad' }]
    )

    expect(snapshot).toEqual({
      petId: 'BQD',
      expressions: ['smile', 'sad'],
      parameters: [{ id: 'ParamMouthForm', min: -30, max: 30, defaultValue: 0 }]
    })
  })

  it('never writes FocusController-owned parameters from a performance instruction', () => {
    const core = makeCore(['ParamAngleX', 'ParamEyeBallY', 'ParamMouthForm'])
    const instruction: Live2DPerformanceInstruction = {
      parameters: [
        { id: 'ParamAngleX', value: 10, weight: 1 },
        { id: 'ParamEyeBallY', value: -10, weight: 1 },
        { id: 'ParamMouthForm', value: 5, weight: 1 }
      ], durationMs: 500, fadeInMs: 0, fadeOutMs: 0
    }

    applyActivePerformanceLayer(
      replaceActivePerformanceLayer(null, instruction, 1000),
      core,
      new Map([['ParamAngleX', 0], ['ParamEyeBallY', 1], ['ParamMouthForm', 2]]),
      'ParamMouthOpenY',
      1000
    )

    expect(core.setParameterValueByIndex).toHaveBeenCalledTimes(1)
    expect(core.setParameterValueByIndex).toHaveBeenCalledWith(2, 5, 1)
  })

  it('replaces the active layer and clears an expired layer without restoring defaults', () => {
    const core = makeCore(['ParamMouthForm', 'ParamMouthOpenY'])
    const first: Live2DPerformanceInstruction = {
      parameters: [{ id: 'ParamMouthForm', value: 10, weight: 1 }], durationMs: 1000, fadeInMs: 200, fadeOutMs: 200
    }
    const replacement: Live2DPerformanceInstruction = {
      parameters: [
        { id: 'ParamMouthForm', value: 20, weight: 1 },
        { id: 'ParamMouthOpenY', value: 30, weight: 1 }
      ], durationMs: 300, fadeInMs: 0, fadeOutMs: 0
    }
    let layer: ActivePerformanceLayer | null = replaceActivePerformanceLayer(null, first, 1000)

    layer = applyActivePerformanceLayer(layer, core, new Map([['ParamMouthForm', 0], ['ParamMouthOpenY', 1]]), 'ParamMouthOpenY', 1100)
    expect(core.setParameterValueByIndex).toHaveBeenLastCalledWith(0, 10, 0.5)

    layer = replaceActivePerformanceLayer(layer, replacement, 1200)
    layer = applyActivePerformanceLayer(layer, core, new Map([['ParamMouthForm', 0], ['ParamMouthOpenY', 1]]), 'ParamMouthOpenY', 1200)
    expect(core.setParameterValueByIndex).toHaveBeenLastCalledWith(0, 20, 1)
    expect(core.setParameterValueByIndex).not.toHaveBeenCalledWith(1, 30, expect.anything())

    core.setParameterValueByIndex.mockClear()
    expect(applyActivePerformanceLayer(layer, core, new Map([['ParamMouthForm', 0]]), 'ParamMouthOpenY', 1500)).toBeNull()
    expect(core.setParameterValueByIndex).not.toHaveBeenCalled()
  })
})
