import { describe, it, expect } from 'vitest'
import { isBinaryMessage, parseServerEvent } from './protocol'

describe('isBinaryMessage', () => {
  it('ArrayBuffer → true', () => {
    expect(isBinaryMessage(new ArrayBuffer(4))).toBe(true)
  })
  it('字符串 → false', () => {
    expect(isBinaryMessage('{"type":"done"}')).toBe(false)
  })
})

describe('parseServerEvent', () => {
  it('解析 audio_start', () => {
    const e = parseServerEvent(JSON.stringify({ type: 'audio_start', id: 'x', sampleRate: 32000, channels: 1, format: 'pcm_s16le' }))
    expect(e).toEqual({ type: 'audio_start', id: 'x', sampleRate: 32000, channels: 1, format: 'pcm_s16le' })
  })
  it('解析 done/cancelled/error', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'done', id: 'x' }))).toEqual({ type: 'done', id: 'x' })
    expect(parseServerEvent(JSON.stringify({ type: 'cancelled', id: 'x' }))).toEqual({ type: 'cancelled', id: 'x' })
    const err = parseServerEvent(JSON.stringify({ type: 'error', id: 'x', code: 'SYNTHESIS_FAILED', message: 'boom', fatal: false }))
    expect(err).toEqual({ type: 'error', id: 'x', code: 'SYNTHESIS_FAILED', message: 'boom', fatal: false })
  })
  it('缺 type 字段抛错', () => {
    expect(() => parseServerEvent('{}')).toThrow('Server event missing type field')
  })
  it('非法 JSON 抛错', () => {
    expect(() => parseServerEvent('{ not json')).toThrow()
  })
})
