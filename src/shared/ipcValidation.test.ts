import { describe, it, expect } from 'vitest'
import {
  validateMoveDelta, validateBool, validateChatSend, validateOverlayRect,
  validateKey, validateProviderSettings, validateTestConnectionArg
} from './ipcValidation'

describe('validateMoveDelta', () => {
  it('接受有限数 + 可选 clamp', () => {
    expect(validateMoveDelta({ dx: 3, dy: -4 })).toEqual({ dx: 3, dy: -4, clamp: undefined })
    expect(validateMoveDelta({ dx: 1, dy: 2, clamp: true })).toEqual({ dx: 1, dy: 2, clamp: true })
  })
  it('拒绝 NaN/Infinity/非对象/非布尔 clamp', () => {
    expect(validateMoveDelta({ dx: NaN, dy: 0 })).toBeNull()
    expect(validateMoveDelta({ dx: 0, dy: Infinity })).toBeNull()
    expect(validateMoveDelta({ dx: 1, dy: 2, clamp: 'yes' })).toBeNull()
    expect(validateMoveDelta(null)).toBeNull()
    expect(validateMoveDelta('x')).toBeNull()
  })
})

describe('validateBool', () => {
  it('严格布尔', () => {
    expect(validateBool(true)).toBe(true)
    expect(validateBool(false)).toBe(false)
    expect(validateBool(1)).toBeNull()
    expect(validateBool('true')).toBeNull()
  })
})

describe('validateChatSend', () => {
  it('接受 text 字符串', () => {
    expect(validateChatSend({ text: 'hi' })).toEqual({ text: 'hi' })
  })
  it('拒绝非字符串 / 超长 / 非数组 attachments', () => {
    expect(validateChatSend({ text: 123 })).toBeNull()
    expect(validateChatSend({ text: 'a'.repeat(8001) })).toBeNull()
    expect(validateChatSend({ text: 'ok', attachments: 'x' })).toBeNull()
    expect(validateChatSend(null)).toBeNull()
  })
})

describe('validateKey', () => {
  it('接受合规字符串,拒绝非字符串/超长', () => {
    expect(validateKey('sk-abc')).toBe('sk-abc')
    expect(validateKey('')).toBe('')
    expect(validateKey(123)).toBeNull()
    expect(validateKey('k'.repeat(4001))).toBeNull()
  })
})

describe('validateProviderSettings', () => {
  it('接受合法 provider', () => {
    expect(validateProviderSettings({ kind: 'anthropic', model: 'claude-haiku-4-5' }))
      .toEqual({ kind: 'anthropic', model: 'claude-haiku-4-5', baseURL: undefined })
  })
  it('拒绝错 kind / 空 model / 非字符串 baseURL', () => {
    expect(validateProviderSettings({ kind: 'bogus', model: 'x' })).toBeNull()
    expect(validateProviderSettings({ kind: 'anthropic', model: '' })).toBeNull()
    expect(validateProviderSettings({ kind: 'anthropic', model: 'x', baseURL: 9 })).toBeNull()
  })
})

describe('validateTestConnectionArg', () => {
  it('接受 provider + key', () => {
    expect(validateTestConnectionArg({ provider: { kind: 'anthropic', model: 'm' }, key: 'k' }))
      .toEqual({ provider: { kind: 'anthropic', model: 'm', baseURL: undefined }, key: 'k' })
  })
  it('provider 或 key 非法 → null', () => {
    expect(validateTestConnectionArg({ provider: { kind: 'x', model: 'm' }, key: 'k' })).toBeNull()
    expect(validateTestConnectionArg({ provider: { kind: 'anthropic', model: 'm' }, key: 5 })).toBeNull()
  })
})

describe('validateChatSend 附件', () => {
  const okAtt = { kind: 'image', mimeType: 'image/jpeg', dataBase64: 'AAAA' }
  it('放行合法图片附件', () => {
    const r = validateChatSend({ text: '这是什么', attachments: [okAtt] })
    expect(r?.attachments?.length).toBe(1)
  })
  it('允许纯图(text 空字符串)', () => {
    expect(validateChatSend({ text: '', attachments: [okAtt] })).not.toBeNull()
  })
  it('拒绝非白名单 mimeType', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ ...okAtt, mimeType: 'image/svg+xml' }] })).toBeNull()
  })
  it('拒绝超张数', () => {
    expect(validateChatSend({ text: 'x', attachments: Array(7).fill(okAtt) })).toBeNull()
  })
  it('拒绝超大单图', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ ...okAtt, dataBase64: 'a'.repeat(14_000_001) }] })).toBeNull()
  })
  it('拒绝 dataBase64 非字符串', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ kind: 'image', mimeType: 'image/png', dataBase64: 123 }] })).toBeNull()
  })
})

describe('validateOverlayRect', () => {
  it('放行有限数字矩形', () => {
    expect(validateOverlayRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
  it('拒绝非数字', () => {
    expect(validateOverlayRect({ x: 'a', y: 2, width: 3, height: 4 })).toBeNull()
  })
})
