import { describe, it, expect } from 'vitest'
import { splitByScript } from './mixedLanguageSplit'

describe('splitByScript', () => {
  it('纯英文 → 单个 en 片段', () => {
    expect(splitByScript('Hello world')).toEqual([{ lang: 'en', text: 'Hello world' }])
  })

  it('纯中文 → 单个 other 片段', () => {
    expect(splitByScript('你好世界')).toEqual([{ lang: 'other', text: '你好世界' }])
  })

  it('纯日文(含假名)→ 单个 other 片段', () => {
    expect(splitByScript('こんにちは')).toEqual([{ lang: 'other', text: 'こんにちは' }])
  })

  it('中文夹一个英文单词 → 三段,按原文顺序', () => {
    expect(splitByScript('我觉得 React 框架很好用')).toEqual([
      { lang: 'other', text: '我觉得 ' },
      { lang: 'en', text: 'React' },
      { lang: 'other', text: ' 框架很好用' }
    ])
  })

  it('英文片段允许内部空格与常见标点连续算作一段', () => {
    expect(splitByScript('你说 hello, world 对吧')).toEqual([
      { lang: 'other', text: '你说 ' },
      { lang: 'en', text: 'hello, world' },
      { lang: 'other', text: ' 对吧' }
    ])
  })

  it('空文本 → 空数组', () => {
    expect(splitByScript('')).toEqual([])
  })

  it('数字算作英文片段的一部分', () => {
    expect(splitByScript('降水概率 86% 左右')).toEqual([
      { lang: 'other', text: '降水概率 ' },
      { lang: 'en', text: '86' },
      { lang: 'other', text: '% 左右' }
    ])
  })
})
