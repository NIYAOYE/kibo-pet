import { describe, it, expect } from 'vitest'
import { parseGenieRuntimeMarker, isGenieRuntimeUsable, serializeGenieRuntimeMarker, GENIE_RUNTIME_MARKER_VERSION } from './genieRuntimeMarker'

describe('genieRuntimeMarker', () => {
  it('序列化再解析,内容不变', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }
    expect(parseGenieRuntimeMarker(serializeGenieRuntimeMarker(m))).toEqual(m)
  })
  it('非法 JSON → 返回 null', () => {
    expect(parseGenieRuntimeMarker('{ not json')).toBeNull()
  })
  it('缺 genieTtsVersion → 返回 null', () => {
    expect(parseGenieRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })
  it('markerVersion 与当前版本不符 → isGenieRuntimeUsable 为 false', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION + 1, genieTtsVersion: '2.0.2' }
    expect(isGenieRuntimeUsable(m)).toBe(false)
  })
  it('null → isGenieRuntimeUsable 为 false', () => {
    expect(isGenieRuntimeUsable(null)).toBe(false)
  })
  it('版本匹配 → isGenieRuntimeUsable 为 true', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }
    expect(isGenieRuntimeUsable(m)).toBe(true)
  })
})
