import { describe, it, expect } from 'vitest'
import {
  validateMoveDelta, validateBool, validateChatSend,
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
