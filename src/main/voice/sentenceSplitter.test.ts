import { describe, it, expect } from 'vitest'
import { createSentenceSplitter, createSmartSplitter } from './sentenceSplitter'

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

  it('数字前后的小数点不当作句子边界(如 32.3℃ 不应被切开)', () => {
    const s = createSentenceSplitter()
    expect(s.push('现在32.3摄氏度,明天24.2到33.8摄氏度。')).toEqual(['现在32.3摄氏度,明天24.2到33.8摄氏度。'])
  })

  it('小数点跨多次 push 到达(先收到"32."再收到"3摄氏度。")仍不会提前切分', () => {
    const s = createSentenceSplitter()
    expect(s.push('现在32.')).toEqual([])
    expect(s.push('3摄氏度。')).toEqual(['现在32.3摄氏度。'])
  })

  it('数字后面紧跟句点、但下一个字符不是数字 → 仍视为正常句子边界', () => {
    const s = createSentenceSplitter()
    expect(s.push('结果是5.他很高兴')).toEqual(['结果是5.'])
  })

  it('换行符也是句子边界:列表行(无标点结尾)逐行吐出', () => {
    const s = createSentenceSplitter()
    expect(s.push('湿度: 68%\n风速: 5.5 km/h\n')).toEqual(['湿度: 68%\n', '风速: 5.5 km/h\n'])
  })

  it('纯空白的切分片段(如空行)不吐出', () => {
    const s = createSentenceSplitter()
    expect(s.push('第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
  })

  it('小数点在行内、换行在行尾:两者互不干扰', () => {
    const s = createSentenceSplitter()
    expect(s.push('当前 31.5℃\n体感 37.2℃\n')).toEqual(['当前 31.5℃\n', '体感 37.2℃\n'])
  })
})

describe('createSmartSplitter(智能合并短句)', () => {
  it('短句攒到最小长度才吐出(一次凑齐)', () => {
    const s = createSmartSplitter(10)
    // '你好。'(3字) 不够 10,先攒着;'今天天气真的很不错。'(10字) 令累计达到阈值 → 合并吐出
    expect(s.push('你好。')).toEqual([])
    expect(s.push('今天天气真的很不错。')).toEqual(['你好。今天天气真的很不错。'])
  })

  it('单句已达阈值 → 直接吐出,不额外等待', () => {
    const s = createSmartSplitter(5)
    expect(s.push('这是一个足够长的句子。')).toEqual(['这是一个足够长的句子。'])
  })

  it('列表行(换行边界)也按累计长度合并', () => {
    const s = createSmartSplitter(12)
    expect(s.push('湿度: 68%\n')).toEqual([])
    expect(s.push('风速: 5.5 km/h\n')).toEqual(['湿度: 68%\n风速: 5.5 km/h\n'])
  })

  it('flush 吐出攒着的不足阈值的尾巴;为空则 null', () => {
    const s = createSmartSplitter(100)
    s.push('短句。')
    expect(s.flush()).toBe('短句。')
    expect(s.flush()).toBeNull()
  })

  it('flush 合并"攒着的完整句"与"未完句尾巴"为一段', () => {
    const s = createSmartSplitter(100)
    s.push('第一句。还没说完')
    expect(s.flush()).toBe('第一句。还没说完')
  })
})
