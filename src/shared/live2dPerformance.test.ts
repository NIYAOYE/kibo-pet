import { describe, expect, it } from 'vitest'
import {
  classifyVisibleParameters,
  formatLive2DCapabilities,
  validatePerformanceInstruction,
  type Live2DCapabilitySnapshot,
  type Live2DParameterCapability
} from './live2dPerformance'

const parameters: Live2DParameterCapability[] = [
  { id: 'ParamAngleX', name: 'Face angle', min: -30, max: 30, defaultValue: 0 },
  { id: 'ParamPhysicsRAM_BodyX', group: 'Physics', min: -10, max: 10, defaultValue: 0 },
  { id: 'ParamDivider_1', name: 'Divider', min: 0, max: 1, defaultValue: 0 }
]

const bqd: Live2DCapabilitySnapshot = {
  petId: 'BQD',
  expressions: ['笑咪咪', '生气'],
  parameters
}

describe('classifyVisibleParameters', () => {
  it('retains visible parameters and excludes internal parameter tokens', () => {
    expect(classifyVisibleParameters(parameters)).toEqual([parameters[0]])
  })

  it('filters uppercase internal parameter tokens', () => {
    expect(classifyVisibleParameters([
      parameters[0],
      { id: 'ParamINPUT_BodyX', min: -10, max: 10, defaultValue: 0 }
    ])).toEqual([parameters[0]])
  })

  it('applies deny overrides before allow overrides', () => {
    expect(classifyVisibleParameters(parameters, {
      allow: ['ParamPhysicsRAM_BodyX'],
      deny: ['ParamPhysicsRAM_BodyX']
    })).toEqual([parameters[0]])
  })

  it('allows an explicitly allowed internal parameter when it is not denied', () => {
    expect(classifyVisibleParameters(parameters, { allow: ['ParamPhysicsRAM_BodyX'] }))
      .toEqual([parameters[0], parameters[1]])
  })

  it('rejects parameters with invalid numeric ranges or defaults', () => {
    expect(classifyVisibleParameters([
      parameters[0],
      { id: 'ParamBrokenRange', min: 2, max: 1, defaultValue: 1 },
      { id: 'ParamInfinite', min: 0, max: Number.POSITIVE_INFINITY, defaultValue: 0 },
      { id: 'ParamBrokenDefault', min: 0, max: 1, defaultValue: Number.NaN }
    ])).toEqual([parameters[0]])
  })
})

describe('validatePerformanceInstruction', () => {
  it('accepts BQD’s real expression names and rejects its stale sy entry', () => {
    const realBqd = { ...bqd, expressions: ['眯眯眼', '泪珠', '眼泪', '笑咪咪'] }
    for (const expression of realBqd.expressions) {
      expect(validatePerformanceInstruction({
        expression, parameters: [], durationMs: 150, fadeInMs: 0, fadeOutMs: 0
      }, realBqd)).toMatchObject({ ok: true, value: { expression } })
    }
    expect(validatePerformanceInstruction({
      expression: 'sy', parameters: [], durationMs: 150, fadeInMs: 0, fadeOutMs: 0
    }, realBqd)).toEqual({ ok: false, reason: 'Unknown expression: sy' })
  })

  it('accepts a declared expression and clamps valid parameter performance bounds', () => {
    const result = validatePerformanceInstruction({
      expression: '笑咪咪',
      parameters: [{ id: 'ParamAngleX', value: 99, weight: 2 }],
      durationMs: 6000,
      fadeInMs: 8000,
      fadeOutMs: -10
    }, bqd)

    expect(result).toEqual({
      ok: true,
      value: {
        expression: '笑咪咪',
        parameters: [{ id: 'ParamAngleX', value: 30, weight: 1 }],
        durationMs: 5000,
        fadeInMs: 5000,
        fadeOutMs: 0
      }
    })
  })

  it('defaults an omitted parameter weight to one', () => {
    expect(validatePerformanceInstruction({
      parameters: [{ id: 'ParamAngleX', value: 12 }],
      durationMs: 150,
      fadeInMs: 0,
      fadeOutMs: 0
    }, bqd)).toEqual({
      ok: true,
      value: {
        parameters: [{ id: 'ParamAngleX', value: 12, weight: 1 }],
        durationMs: 150,
        fadeInMs: 0,
        fadeOutMs: 0
      }
    })
  })

  it('rejects an undeclared expression', () => {
    expect(validatePerformanceInstruction({
      expression: '不存在',
      parameters: [],
      durationMs: 150,
      fadeInMs: 0,
      fadeOutMs: 0
    }, bqd)).toEqual({ ok: false, reason: 'Unknown expression: 不存在' })
  })

  it('rejects an unknown parameter', () => {
    expect(validatePerformanceInstruction({
      parameters: [{ id: 'ParamUnknown', value: 0, weight: 1 }],
      durationMs: 150,
      fadeInMs: 0,
      fadeOutMs: 0
    }, bqd)).toEqual({ ok: false, reason: 'Unknown parameter: ParamUnknown' })
  })

  it('accepts inclusive duration and weight boundaries', () => {
    expect(validatePerformanceInstruction({
      parameters: [{ id: 'ParamAngleX', value: -30, weight: 0 }],
      durationMs: 150,
      fadeInMs: 150,
      fadeOutMs: 150
    }, bqd)).toEqual({
      ok: true,
      value: {
        parameters: [{ id: 'ParamAngleX', value: -30, weight: 0 }],
        durationMs: 150,
        fadeInMs: 150,
        fadeOutMs: 150
      }
    })
  })

  it('clamps the lower duration boundary and accepts at most eight parameters', () => {
    const result = validatePerformanceInstruction({
      parameters: Array.from({ length: 8 }, () => ({ id: 'ParamAngleX', value: 0, weight: 1 })),
      durationMs: 1,
      fadeInMs: 1,
      fadeOutMs: 1
    }, bqd)

    expect(result).toMatchObject({ ok: true, value: { durationMs: 150, fadeInMs: 1, fadeOutMs: 1 } })
  })

  it('rejects empty performances, too many parameters, and non-finite values', () => {
    expect(validatePerformanceInstruction({
      parameters: [], durationMs: 150, fadeInMs: 0, fadeOutMs: 0
    }, bqd)).toEqual({ ok: false, reason: 'An expression or parameter is required' })
    expect(validatePerformanceInstruction({
      parameters: Array.from({ length: 9 }, () => ({ id: 'ParamAngleX', value: 0, weight: 1 })),
      durationMs: 150, fadeInMs: 0, fadeOutMs: 0
    }, bqd)).toEqual({ ok: false, reason: 'At most 8 parameters are allowed' })
    expect(validatePerformanceInstruction({
      parameters: [{ id: 'ParamAngleX', value: Number.NaN, weight: 1 }],
      durationMs: 150, fadeInMs: 0, fadeOutMs: 0
    }, bqd)).toEqual({ ok: false, reason: 'Parameter value must be finite: ParamAngleX' })
  })
})

describe('formatLive2DCapabilities', () => {
  it('lists declared expressions and concrete parameter capabilities', () => {
    expect(formatLive2DCapabilities(bqd)).toContain('Expressions: 笑咪咪, 生气')
    expect(formatLive2DCapabilities(bqd)).toContain('ParamAngleX: range -30 to 30, default 0')
  })
})
