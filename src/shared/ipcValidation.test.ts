import { describe, it, expect } from 'vitest'
import {
  validateMoveDelta, validateBool, validateChatSend, validateOverlayRect,
  validateKey, validateProviderSettings, validateTestConnectionArg,
  validateTodoAdd, validateTodoId, validateReactionCategory, validateBubbleHeight, validateCollapsedHeight,
  validatePetId
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

describe('validateTodoAdd', () => {
  it('合法:标题 + null dueAt', () => {
    expect(validateTodoAdd({ title: '买菜', dueAt: null })).toEqual({ title: '买菜', dueAt: null })
  })
  it('合法:标题 + 数值 dueAt(将来)', () => {
    const future = Date.now() + 3600_000
    expect(validateTodoAdd({ title: '开会', dueAt: future })).toEqual({ title: '开会', dueAt: future })
  })
  it('空标题 / 非对象 / 非法 dueAt → null', () => {
    expect(validateTodoAdd({ title: '   ', dueAt: null })).toBeNull()
    expect(validateTodoAdd(null)).toBeNull()
    expect(validateTodoAdd({ title: 'x', dueAt: 'nope' })).toBeNull()
    expect(validateTodoAdd({ title: 'x', dueAt: -5 })).toBeNull()
  })
  it('超长标题 → null', () => {
    expect(validateTodoAdd({ title: 'a'.repeat(1000), dueAt: null })).toBeNull()
  })
  it('拒绝:dueAt 早于等于 now(过去时间)', () => {
    expect(validateTodoAdd({ title: 'x', dueAt: 500 }, 1000)).toBeNull()
    expect(validateTodoAdd({ title: 'x', dueAt: 1000 }, 1000)).toBeNull() // 等于 now 也拒绝
  })
})

describe('validateTodoId', () => {
  it('非空字符串通过,其它 null', () => {
    expect(validateTodoId('abc')).toBe('abc')
    expect(validateTodoId('')).toBeNull()
    expect(validateTodoId(123)).toBeNull()
  })
})

describe('validateReactionCategory', () => {
  it('接受合法 category', () => {
    expect(validateReactionCategory('idle')).toBe('idle')
    expect(validateReactionCategory('click')).toBe('click')
  })
  it('拒绝非法/非字符串', () => {
    expect(validateReactionCategory('nope')).toBeNull()
    expect(validateReactionCategory(123)).toBeNull()
    expect(validateReactionCategory(null)).toBeNull()
  })
})

describe('validateBubbleHeight', () => {
  it('接受合法有限非负数', () => {
    expect(validateBubbleHeight(120)).toBe(120)
    expect(validateBubbleHeight(0)).toBe(0)
  })
  it('拒绝负数/NaN/Infinity/超防御性上限/非数字', () => {
    expect(validateBubbleHeight(-1)).toBeNull()
    expect(validateBubbleHeight(NaN)).toBeNull()
    expect(validateBubbleHeight(Infinity)).toBeNull()
    expect(validateBubbleHeight(5001)).toBeNull()
    expect(validateBubbleHeight('120')).toBeNull()
    expect(validateBubbleHeight(null)).toBeNull()
  })
})

describe('validateCollapsedHeight', () => {
  it('接受合法有限非负数', () => {
    expect(validateCollapsedHeight(52)).toBe(52)
    expect(validateCollapsedHeight(0)).toBe(0)
    expect(validateCollapsedHeight(400)).toBe(400)
  })
  it('拒绝负数/NaN/Infinity/超上限/非数字', () => {
    expect(validateCollapsedHeight(-1)).toBeNull()
    expect(validateCollapsedHeight(NaN)).toBeNull()
    expect(validateCollapsedHeight(Infinity)).toBeNull()
    expect(validateCollapsedHeight(401)).toBeNull()
    expect(validateCollapsedHeight('52')).toBeNull()
    expect(validateCollapsedHeight(null)).toBeNull()
  })
})

describe('validatePetId', () => {
  it('接受合法 id(字母数字下划线连字符)', () => {
    expect(validatePetId('luluka')).toBe('luluka')
    expect(validatePetId('pet_01-a')).toBe('pet_01-a')
  })
  it('拒绝空/含分隔符/路径穿越/非字符串', () => {
    expect(validatePetId('')).toBeNull()
    expect(validatePetId('a/b')).toBeNull()
    expect(validatePetId('../x')).toBeNull()
    expect(validatePetId('a.b')).toBeNull()
    expect(validatePetId(123)).toBeNull()
  })
})
