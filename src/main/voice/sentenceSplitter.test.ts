import { describe, it, expect } from 'vitest'
import { createSentenceSplitter } from './sentenceSplitter'

describe('createSentenceSplitter', () => {
  it('单次 push 完整一句 → 立即吐出该句', () => {
    const s = createSentenceSplitter()
    expect(s.push('你好。')).toEqual(['你好。'])
  })

  it('跨多次 push 拼出一句 → 只在句子边界吐出', () => {
    const s = createSentenceSplitter()
    expect(s.push('你')).toEqual([])
    expect(s.push('好')).toEqual([])
    expect(s.push('。')).toEqual(['你好。'])
  })

  it('一次 push 含多句 → 全部吐出,按序', () => {
    const s = createSentenceSplitter()
    expect(s.push('第一句。第二句!第三句?')).toEqual(['第一句。', '第二句!', '第三句?'])
  })

  it('英文标点、省略号、混合标点均能切分', () => {
    const s = createSentenceSplitter()
    expect(s.push('Hello world. こんにちは!你好…')).toEqual(['Hello world.', ' こんにちは!', '你好…'])
  })

  it('flush 吐出尾部不完整的句子;若尾部为空则返回 null', () => {
    const s = createSentenceSplitter()
    s.push('完整句子。剩下没说完')
    expect(s.flush()).toBe('剩下没说完')
    expect(s.flush()).toBeNull()
  })

  it('flush 后再 push 不会带出旧内容', () => {
    const s = createSentenceSplitter()
    s.push('第一句。剩余')
    s.flush()
    expect(s.push('新内容。')).toEqual(['新内容。'])
  })
})
