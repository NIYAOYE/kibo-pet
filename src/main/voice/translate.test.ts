import { describe, it, expect, vi } from 'vitest'
import { createLlmTranslator, createFallbackTranslator, createLocalNllbTranslator, type Translator } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'
import type { StreamChatRequest } from '../providers/llmProvider'
import type { TranslateSidecar } from './translateSidecar'

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

function fakeTranslator(impl: (text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal) => Promise<string>): Translator {
  return { translate: impl }
}

describe('createFallbackTranslator', () => {
  it('primary 可用且成功 → 用 primary 结果,不碰 fallback', async () => {
    const fallback = vi.fn(async () => { throw new Error('不该被调用') })
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => '本地译文'),
      fallback: fakeTranslator(fallback),
      isPrimaryAvailable: () => true
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('本地译文')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('primary 不可用 → 直接用 fallback,primary 不会被调用', async () => {
    const primary = vi.fn(async () => { throw new Error('不该被调用') })
    const t = createFallbackTranslator({
      primary: fakeTranslator(primary),
      fallback: fakeTranslator(async () => 'LLM 译文'),
      isPrimaryAvailable: () => false
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('LLM 译文')
    expect(primary).not.toHaveBeenCalled()
  })

  it('primary 可用但抛错(未取消)→ 回退 fallback', async () => {
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => { throw new Error('本地推理超时') }),
      fallback: fakeTranslator(async () => 'LLM 译文'),
      isPrimaryAvailable: () => true
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('LLM 译文')
  })

  it('primary 抛错且 signal 已取消 → 直接抛出,不回退', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fallback = vi.fn(async () => 'LLM 译文')
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => { throw new Error('已取消') }),
      fallback: fakeTranslator(fallback),
      isPrimaryAvailable: () => true
    })
    await expect(t.translate('你好', 'ja', ctrl.signal)).rejects.toThrow('已取消')
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('createLocalNllbTranslator', () => {
  it('自动检测源语言,转发给 sidecar.translate', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar: TranslateSidecar = { start: vi.fn(), translate, stop: vi.fn() }
    const t = createLocalNllbTranslator(sidecar)
    const signal = new AbortController().signal
    const out = await t.translate('你好', 'ja', signal)
    expect(out).toBe('こんにちは')
    expect(translate).toHaveBeenCalledWith({ text: '你好', source: 'zh', target: 'ja' }, signal)
  })

  it('源语言检测为日语(含假名)时正确传给 sidecar', async () => {
    const translate = vi.fn(async () => 'hello')
    const sidecar: TranslateSidecar = { start: vi.fn(), translate, stop: vi.fn() }
    const t = createLocalNllbTranslator(sidecar)
    await t.translate('こんにちは', 'en', new AbortController().signal)
    expect(translate).toHaveBeenCalledWith({ text: 'こんにちは', source: 'ja', target: 'en' }, expect.anything())
  })
})
