import { describe, it, expect } from 'vitest'
import { resolveKey, ALLOWED_KEY_NAMES } from './keyAllowlist'

describe('resolveKey', () => {
  it('单键:Enter/Tab/Escape/Backspace/Delete/方向键解析出对应单个 vk code', () => {
    expect(resolveKey('Enter')).toEqual([0x0d])
    expect(resolveKey('Tab')).toEqual([0x09])
    expect(resolveKey('Escape')).toEqual([0x1b])
    expect(resolveKey('Backspace')).toEqual([0x08])
    expect(resolveKey('Delete')).toEqual([0x2e])
    expect(resolveKey('ArrowUp')).toEqual([0x26])
    expect(resolveKey('ArrowDown')).toEqual([0x28])
    expect(resolveKey('ArrowLeft')).toEqual([0x25])
    expect(resolveKey('ArrowRight')).toEqual([0x27])
  })

  it('组合键:Ctrl+X 系列解析出 [Ctrl, X] 两个 vk code(按下顺序)', () => {
    expect(resolveKey('Ctrl+A')).toEqual([0x11, 0x41])
    expect(resolveKey('Ctrl+C')).toEqual([0x11, 0x43])
    expect(resolveKey('Ctrl+V')).toEqual([0x11, 0x56])
    expect(resolveKey('Ctrl+X')).toEqual([0x11, 0x58])
    expect(resolveKey('Ctrl+Z')).toEqual([0x11, 0x5a])
  })

  it('白名单外的键(含破坏性组合)一律返回 null', () => {
    expect(resolveKey('Alt+F4')).toBeNull()
    expect(resolveKey('Ctrl+Alt+Delete')).toBeNull()
    expect(resolveKey('Meta')).toBeNull()
    expect(resolveKey('F1')).toBeNull()
    expect(resolveKey('')).toBeNull()
  })

  it('原型链污染输入(Object.prototype 继承属性)一律返回 null', () => {
    expect(resolveKey('__proto__')).toBeNull()
    expect(resolveKey('constructor')).toBeNull()
    expect(resolveKey('toString')).toBeNull()
    expect(resolveKey('hasOwnProperty')).toBeNull()
  })

  it('ALLOWED_KEY_NAMES 与可解析的键名集合一致', () => {
    for (const name of ALLOWED_KEY_NAMES) expect(resolveKey(name)).not.toBeNull()
  })
})
