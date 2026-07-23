import { describe, it, expect } from 'vitest'
import {
  TRANSLATE_RUNTIME_MARKER_VERSION,
  parseTranslateRuntimeMarker,
  isTranslateRuntimeUsable,
  serializeTranslateRuntimeMarker
} from './translateRuntimeMarker'

describe('translateRuntimeMarker', () => {
  it('序列化再解析,内容不变', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION, nllbModelRepo: 'JustFrederik/nllb-200-distilled-600M-ct2-int8' }
    expect(parseTranslateRuntimeMarker(serializeTranslateRuntimeMarker(m))).toEqual(m)
  })

  it('版本号不匹配 → 不可用', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION + 1, nllbModelRepo: 'x' }
    expect(isTranslateRuntimeUsable(m)).toBe(false)
  })

  it('null → 不可用', () => {
    expect(isTranslateRuntimeUsable(null)).toBe(false)
  })

  it('版本号匹配 → 可用', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION, nllbModelRepo: 'x' }
    expect(isTranslateRuntimeUsable(m)).toBe(true)
  })

  it('损坏的 JSON → 解析返回 null', () => {
    expect(parseTranslateRuntimeMarker('not json')).toBeNull()
  })

  it('缺字段 → 解析返回 null', () => {
    expect(parseTranslateRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })
})
