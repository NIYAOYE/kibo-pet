import { describe, it, expect } from 'vitest'
import { needsTranslation, detectSourceLanguage } from './languageDetect'

describe('needsTranslation', () => {
  it('target 为 auto 时永远不需要翻译', () => {
    expect(needsTranslation('Hello world', 'auto')).toBe(false)
    expect(needsTranslation('你好世界', 'auto')).toBe(false)
  })

  it('target=zh,文本已经以中文为主 → 不需要翻译', () => {
    expect(needsTranslation('你好,今天天气不错。', 'zh')).toBe(false)
  })

  it('target=zh,文本是纯英文 → 需要翻译', () => {
    expect(needsTranslation('Hello, nice weather today.', 'zh')).toBe(true)
  })

  it('target=ja,文本含假名 → 不需要翻译(即便混了英文,GSV 自动分段处理混合)', () => {
    expect(needsTranslation('こんにちは、Nice to meet you.', 'ja')).toBe(false)
  })

  it('target=ja,文本不含任何假名(纯中文或纯英文)→ 需要翻译', () => {
    expect(needsTranslation('你好,很高兴认识你。', 'ja')).toBe(true)
    expect(needsTranslation('Hello, nice to meet you.', 'ja')).toBe(true)
  })

  it('target=en,文本已经以英文为主 → 不需要翻译', () => {
    expect(needsTranslation('Hello, nice to meet you.', 'en')).toBe(false)
  })

  it('target=en,文本是纯中文 → 需要翻译', () => {
    expect(needsTranslation('你好,很高兴认识你。', 'en')).toBe(true)
  })

  it('空文本(或全空白)→ 不需要翻译', () => {
    expect(needsTranslation('   ', 'zh')).toBe(false)
    expect(needsTranslation('', 'ja')).toBe(false)
  })
})

describe('detectSourceLanguage', () => {
  it('含假名 → ja', () => {
    expect(detectSourceLanguage('こんにちは、元気ですか')).toBe('ja')
  })

  it('纯中文(无假名)→ zh', () => {
    expect(detectSourceLanguage('你好,今天天气不错。')).toBe('zh')
  })

  it('纯英文 → en', () => {
    expect(detectSourceLanguage('Hello, nice weather today.')).toBe('en')
  })

  it('中英混合但中文字符占多数(无假名)→ zh', () => {
    expect(detectSourceLanguage('我觉得 React 这个框架很好用')).toBe('zh')
  })

  it('空文本 → en(无信息时的确定性兜底)', () => {
    expect(detectSourceLanguage('')).toBe('en')
    expect(detectSourceLanguage('   ')).toBe('en')
  })
})
