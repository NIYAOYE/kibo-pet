import { describe, it, expect } from 'vitest'
import { translateText } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'

describe('translateText', () => {
  it('成功:返回 provider 的完整回复文本(掐头去尾空白)', async () => {
    const provider = createFakeProvider({ reply: '  Good morning!  ' })
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBe('Good morning!')
  })

  it('system prompt 要求整句翻译成目标语言、只输出译文', async () => {
    const seen: string[] = []
    const provider = {
      streamChat: (req: { system: string }) => {
        seen.push(req.system)
        return (async function* () { yield { type: 'text' as const, text: 'おはよう' }; yield { type: 'done' as const } })()
      }
    }
    await translateText({ provider, text: '早安', targetLanguage: 'ja', signal: new AbortController().signal })
    expect(seen[0]).toContain('日语')
  })

  it('取消:signal 提前 abort → 返回 null', async () => {
    const provider = createFakeProvider({ reply: 'x' })
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: ctrl.signal })
    expect(r).toBeNull()
  })

  it('provider 报错 → 返回 null(静默降级,不抛)', async () => {
    const provider = { streamChat: () => (async function* () { yield { type: 'error' as const, message: 'boom' } })() }
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBeNull()
  })

  it('空回复(掐头去尾后为空)→ 返回 null', async () => {
    const provider = createFakeProvider({ reply: '   ' })
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBeNull()
  })
})
