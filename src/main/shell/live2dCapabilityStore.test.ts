import { describe, expect, it } from 'vitest'
import { createLive2DCapabilityStore, parseLive2DCapabilitySnapshot } from './live2dCapabilityStore'

const alpha = {
  petId: 'alpha',
  expressions: ['smile'],
  parameters: [{ id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 }]
}

describe('createLive2DCapabilityStore', () => {
  it('retains a report only for the active pet', () => {
    const store = createLive2DCapabilityStore()
    store.activate('alpha', 'epoch-alpha')

    expect(store.report(alpha, 'epoch-alpha')).toBe(true)
    expect(store.current()).toEqual(alpha)
    expect(store.report({ ...alpha, petId: 'beta' }, 'epoch-alpha')).toBe(false)
    expect(store.current()).toEqual(alpha)
  })

  it('clears a previous report when the active pet changes', () => {
    const store = createLive2DCapabilityStore()
    store.activate('alpha', 'epoch-alpha')
    store.report(alpha, 'epoch-alpha')

    store.activate('beta', 'epoch-beta')

    expect(store.current()).toBeNull()
    expect(store.report({ ...alpha, petId: 'beta' }, 'epoch-beta')).toBe(true)
    expect(store.current()?.petId).toBe('beta')
  })

  it('clear removes the active report', () => {
    const store = createLive2DCapabilityStore()
    store.activate('alpha', 'epoch-alpha')
    store.report(alpha, 'epoch-alpha')

    expect(store.clear('alpha', 'epoch-alpha')).toBe(true)

    expect(store.current()).toBeNull()
  })

  it('rejects delayed A lifecycle messages after A to B to A', () => {
    const store = createLive2DCapabilityStore()
    const staleA = { ...alpha, petId: 'A', expressions: ['stale'] }
    const freshA = { ...alpha, petId: 'A', expressions: ['fresh'] }

    store.activate('A', 'epoch-a1')
    expect(store.report(staleA, 'epoch-a1')).toBe(true)
    store.activate('B', 'epoch-b1')
    store.activate('A', 'epoch-a2')
    expect(store.report(freshA, 'epoch-a2')).toBe(true)

    expect(store.clear('A', 'epoch-a1')).toBe(false)
    expect(store.report(staleA, 'epoch-a1')).toBe(false)
    expect(store.current()).toEqual(freshA)
  })
})

describe('parseLive2DCapabilitySnapshot', () => {
  it('rejects malformed IPC payloads without throwing', () => {
    const malformed = [
      null,
      { petId: 'alpha', expressions: [], parameters: null },
      { petId: 'alpha', expressions: [1], parameters: [] },
      { petId: 'alpha', expressions: [], parameters: [{ id: 'ParamAngleX', min: -30, max: 30 }] },
      { petId: 'alpha', expressions: [], parameters: [{ id: 'ParamAngleX', min: 30, max: -30, defaultValue: 0 }] },
      { petId: 'alpha', expressions: [], parameters: [{ id: 'ParamAngleX', min: -30, max: 30, defaultValue: Number.NaN }] }
    ]

    for (const payload of malformed) {
      expect(() => parseLive2DCapabilitySnapshot(payload)).not.toThrow()
      expect(parseLive2DCapabilitySnapshot(payload)).toBeNull()
    }
  })

  it('returns a typed snapshot only when every parameter is valid', () => {
    expect(parseLive2DCapabilitySnapshot(alpha)).toEqual(alpha)
  })
})
