import { describe, it, expect } from 'vitest'
import { toSpeakableText } from './speakableText'

describe('toSpeakableText', () => {
  it('纯文本原样返回', () => {
    expect(toSpeakableText('今天天气不错')).toBe('今天天气不错')
  })

  it('去掉加粗标记,保留文字', () => {
    expect(toSpeakableText('这是**重点**内容')).toBe('这是重点内容')
  })

  it('去掉斜体标记(* 和 _ 两种写法),保留文字', () => {
    expect(toSpeakableText('这是*斜体*文字')).toBe('这是斜体文字')
    expect(toSpeakableText('这是_斜体_文字')).toBe('这是斜体文字')
  })

  it('行内代码整体丢弃', () => {
    expect(toSpeakableText('运行 `pnpm test` 命令')).toBe('运行  命令')
  })

  it('围栏代码块整体丢弃(含多行)', () => {
    const raw = '说明如下:\n```js\nconst a = 1\nconsole.log(a)\n```\n就这样'
    expect(toSpeakableText(raw)).toBe('说明如下:\n\n就这样')
  })

  it('Markdown 链接只读文字,丢弃 URL', () => {
    expect(toSpeakableText('参考[这篇文章](https://example.com/a)')).toBe('参考这篇文章')
  })

  it('标题标记去掉前导 #,保留文字', () => {
    expect(toSpeakableText('## 今日总结')).toBe('今日总结')
  })

  it('无序/有序列表标记去掉前导符号,保留文字', () => {
    expect(toSpeakableText('- 第一项')).toBe('第一项')
    expect(toSpeakableText('* 第二项')).toBe('第二项')
    expect(toSpeakableText('1. 第三项')).toBe('第三项')
  })

  it('表格分隔行整行丢弃,数据行转为顿号连接的纯文本', () => {
    const raw = '|城市|气温|\n|---|---|\n|北京|20|'
    expect(toSpeakableText(raw)).toBe('城市 · 气温\n北京 · 20')
  })

  it('常见数学/单位符号映射成可读文字', () => {
    expect(toSpeakableText('今天20℃,湿度60%')).toBe('今天20摄氏度,湿度60百分之')
    expect(toSpeakableText('3×4÷2')).toBe('3乘4除以2')
    expect(toSpeakableText('a≥b 且 a≠c 且 a≈d,误差±1')).toBe('a大于等于b 且 a不等于c 且 a约等于d,误差正负1')
  })

  it('组合场景:加粗 + 符号一起出现', () => {
    expect(toSpeakableText('**当前气温**:20℃')).toBe('当前气温:20摄氏度')
  })
})
