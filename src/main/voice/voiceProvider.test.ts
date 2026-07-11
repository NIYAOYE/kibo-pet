import { describe, it, expect, vi } from 'vitest'
import { createVoiceProvider } from './voiceProvider'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'

function fakeSidecar(impl?: Partial<VoiceSidecar>): VoiceSidecar {
  return {
    start: vi.fn(async () => {}),
    speak: vi.fn(async (_req, onChunk) => { onChunk({ audioBase64: 'QUJD', sampleRate: 32000 }) }),
    stop: vi.fn(),
    ...impl
  }
}

describe('createVoiceProvider', () => {
  it('targetLanguage=auto → 不翻译,直接把原文送去合成', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const chunks: PcmChunk[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'auto' }),
      onError: () => {}
    })
    await vp.speak('你好', (c) => chunks.push(c))
    expect(translate).not.toHaveBeenCalled()
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '你好' }), expect.any(Function), expect.any(Object))
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }])
  })

  it('targetLanguage=ja 且文本不含假名 → 先翻译再合成翻译后的文本', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    await vp.speak('你好', () => {})
    expect(translate).toHaveBeenCalledWith('你好', 'ja', expect.any(Object))
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'こんにちは' }), expect.any(Function), expect.any(Object))
  })

  it('targetLanguage=ja 且文本已含假名 → 跳过翻译', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    await vp.speak('こんにちは', () => {})
    expect(translate).not.toHaveBeenCalled()
  })

  it('翻译失败 → onError 收到消息,不调用 sidecar.speak', async () => {
    const translate = vi.fn(async () => { throw new Error('翻译服务不可用') })
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: (m) => errors.push(m)
    })
    await vp.speak('你好', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors[0]).toContain('翻译服务不可用')
  })

  it('sidecar.speak 失败 → onError 收到消息', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => { throw new Error('合成失败') }) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    await vp.speak('你好', () => {})
    expect(errors[0]).toContain('合成失败')
  })

  it('空文本/纯空白 → 直接跳过,不调用 sidecar', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    await vp.speak('   ', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
  })

  it('只含 Markdown/符号、归一化后为空 → 直接跳过,不调用 sidecar(不当作错误)', async () => {
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    await vp.speak('`raw_only_code`', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it('发音前会先做 Markdown/符号归一化,再送去合成', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    await vp.speak('**今天20℃**', () => {})
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '今天20摄氏度' }), expect.any(Function), expect.any(Object))
  })

  it('合成请求携带 language=targetLanguage(ja),让 sidecar 强制日语发音', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn(async () => 'こんにちは') },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    await vp.speak('你好', () => {})
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja' }), expect.any(Function), expect.any(Object))
  })

  it('targetLanguage=auto → 合成请求 language=auto(保持自动检测)', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'auto' }),
      onError: () => {}
    })
    await vp.speak('你好', () => {})
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'auto' }), expect.any(Function), expect.any(Object))
  })

  it('stop() 让正在进行的 speak() 的 signal 被 abort', async () => {
    let capturedSignal: AbortSignal | null = null
    const sidecar = fakeSidecar({
      speak: vi.fn(async (_req, _onChunk, signal: AbortSignal) => { capturedSignal = signal })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    const p = vp.speak('你好', () => {})
    vp.stop()
    await p
    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true)
  })

  it('两句重叠合成时,stop() 必须 abort 全部在途请求(而非仅最后一个)', async () => {
    const capturedSignals: AbortSignal[] = []
    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    const pendingA = new Promise<void>((resolve) => { releaseA = resolve })
    const pendingB = new Promise<void>((resolve) => { releaseB = resolve })

    const sidecar = fakeSidecar({
      speak: vi.fn(async (req: { text: string }, _onChunk, signal: AbortSignal) => {
        capturedSignals.push(signal)
        await (req.text === 'A' ? pendingA : pendingB)
      })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })

    const pA = vp.speak('A', () => {})
    const pB = vp.speak('B', () => {})

    vp.stop()

    releaseA()
    releaseB()
    await pA
    await pB

    expect(capturedSignals).toHaveLength(2)
    expect(capturedSignals.every((s) => s.aborted)).toBe(true)
  })
})
