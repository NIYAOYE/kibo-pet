import { describe, it, expect, vi } from 'vitest'
import { createSentenceBuffer } from './sentenceBuffer'

describe('createSentenceBuffer', () => {
  it('无标点时不产出片段', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好')).toEqual([])
    expect(buf.push('世界')).toEqual([])
  })

  it('强标点(。！？!?.)立即切出片段', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好。')).toEqual(['你好。'])
    expect(buf.push('后面的')).toEqual([])
  })

  it('短于 minLength 的强标点片段被丢弃', () => {
    const buf = createSentenceBuffer({ minLength: 3 })
    expect(buf.push('好。')).toEqual([]) // 长度 2 < minLength 3
  })

  it('软标点(，、,;：:)首次出现记下断点,buffer 继续增长超过断点才真正切出', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好，')).toEqual([]) // 软断点刚好在末尾,buffer.length 不大于 softBreakIndex,先不切
    expect(buf.push('世界')).toEqual(['你好，']) // 继续增长,超过断点 → 切出
  })

  it('超过 maxLength 强制切分', () => {
    const buf = createSentenceBuffer({ maxLength: 10, minLength: 1 })
    const segments = buf.push('a'.repeat(15))
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0].length).toBeLessThanOrEqual(10)
  })

  it('flush 返回剩余内容并清空;不足 minLength 的残留也会被 flush 出来', () => {
    const buf = createSentenceBuffer()
    buf.push('好')
    expect(buf.flush()).toBe('好')
    expect(buf.flush()).toBe('') // 再次 flush 是空
  })

  it('clear 丢弃残留内容,flush 拿不到东西', () => {
    const buf = createSentenceBuffer()
    buf.push('残留内容')
    buf.clear()
    expect(buf.flush()).toBe('')
  })

  it('markdown 代码块围栏与 URL 被清除,换行变空格', () => {
    const buf = createSentenceBuffer({ minLength: 1 })
    buf.push('```js\n')
    const segs = buf.push('看 https://example.com/x 这里\n结束。')
    expect(segs[0]).not.toContain('```')
    expect(segs[0]).not.toContain('https://')
    expect(segs[0]).not.toContain('\n')
  })

  it('注入 clock:push 后不主动 flush 也不触发 onIdle;手动推进 clock 后触发 onIdle', () => {
    let scheduled: (() => void) | null = null
    const clock = {
      setTimeout: vi.fn((fn: () => void) => { scheduled = fn; return 1 as unknown as ReturnType<typeof setTimeout> }),
      clearTimeout: vi.fn()
    }
    let idleFired = 0
    const buf = createSentenceBuffer({ clock, onIdle: () => { idleFired++ } })
    buf.push('还没说完')
    expect(idleFired).toBe(0)
    expect(scheduled).not.toBeNull()
    scheduled!()
    expect(idleFired).toBe(1)
  })

  it('push 会取消上一个待触发的 idle 计时器', () => {
    const clock = {
      setTimeout: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimeout: vi.fn()
    }
    const buf = createSentenceBuffer({ clock, onIdle: () => {} })
    buf.push('第一段')
    buf.push('继续')
    expect(clock.clearTimeout).toHaveBeenCalled()
  })
})
