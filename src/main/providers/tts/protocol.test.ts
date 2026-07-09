import { describe, it, expect } from 'vitest'
import { isBinaryMessage, parseServerEvent, toArrayBuffer } from './protocol'

describe('isBinaryMessage', () => {
  it('ArrayBuffer → true', () => {
    expect(isBinaryMessage(new ArrayBuffer(4))).toBe(true)
  })
  it('字符串 → false', () => {
    expect(isBinaryMessage('{"type":"done"}')).toBe(false)
  })
  // 回归测试:真实 `ws` 库 binaryType 默认是 'nodebuffer',此时二进制帧交付
  // 到 onmessage 的是 Node Buffer(ArrayBufferView 的子类),不是 ArrayBuffer。
  // 修复前 isBinaryMessage 只认 `instanceof ArrayBuffer`,对 Buffer 判 false,
  // 导致真实音频帧在 ttsClient.handleMessage 里被当成非法消息静默丢弃。
  it('Buffer(ws 默认 binaryType=nodebuffer 时真实交付的类型)→ true', () => {
    expect(isBinaryMessage(Buffer.from([1, 2, 3, 4]))).toBe(true)
  })
  it('Uint8Array → true', () => {
    expect(isBinaryMessage(new Uint8Array([1, 2, 3]))).toBe(true)
  })
})

describe('toArrayBuffer', () => {
  it('ArrayBuffer 原样返回', () => {
    const ab = new ArrayBuffer(8)
    expect(toArrayBuffer(ab)).toBe(ab)
  })
  it('Buffer 归一化为等长 ArrayBuffer', () => {
    const buf = Buffer.from([1, 2, 3, 4])
    const ab = toArrayBuffer(buf)
    expect(ab.byteLength).toBe(4)
    expect(Array.from(new Uint8Array(ab))).toEqual([1, 2, 3, 4])
  })
  it('Buffer 来自共享内存池的子区间时,不会带上池中的无关字节', () => {
    // Node 的小 Buffer 常从共享池分配,.buffer 可能比这一帧本身大得多。
    const pool = Buffer.allocUnsafe(64)
    pool.fill(0xff)
    const view = pool.subarray(10, 14)
    view[0] = 1
    view[1] = 2
    view[2] = 3
    view[3] = 4
    const ab = toArrayBuffer(view)
    expect(ab.byteLength).toBe(4)
    expect(Array.from(new Uint8Array(ab))).toEqual([1, 2, 3, 4])
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
