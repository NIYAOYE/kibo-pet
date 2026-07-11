import { describe, it, expect } from 'vitest'
import { createLlmTranslator } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'
import type { StreamChatRequest } from '../providers/llmProvider'

describe('createLlmTranslator', () => {
  it('把 provider 的流式文本拼成完整译文', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'こんにちは' }))
    const out = await translator.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('こんにちは')
  })

  it('provider 报错 → 向上抛出', async () => {
    const translator = createLlmTranslator(createFakeProvider({ failWith: '模型不可用' }))
    await expect(translator.translate('你好', 'en', new AbortController().signal)).rejects.toThrow('模型不可用')
  })

  it('已取消的 signal → fakeProvider 立即结束,返回空字符串', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'hello', delayMs: 50 }))
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await translator.translate('你好', 'en', ctrl.signal)
    expect(out).toBe('')
  })

  it('输出预算至少 2048 token,且提示词要求"碎片也必须翻译、绝不回吐原文"', async () => {
    const seen: StreamChatRequest[] = []
    const inner = createFakeProvider({ reply: 'こんにちは' })
    const recording: typeof inner = {
      streamChat(req) {
        seen.push(req)
        return inner.streamChat(req)
      }
    }
    const translator = createLlmTranslator(recording)
    await translator.translate('湿度: 68%', 'ja', new AbortController().signal)
    expect(seen[0].maxOutputTokens).toBeGreaterThanOrEqual(2048)
    expect(seen[0].system).toContain('不完整')
    expect(seen[0].system).toContain('不要原样返回')
  })
})
