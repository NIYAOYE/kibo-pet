import { describe, it, expect, vi } from 'vitest'
import { createVoiceProvider, type VoiceProvider, type VoiceSynthesisOutcome } from './voiceProvider'
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

function synthesize(
  provider: VoiceProvider,
  text: string,
  onChunk: (c: PcmChunk) => void
): Promise<VoiceSynthesisOutcome> {
  return provider.synthesize(text, onChunk)
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
    const outcome = await synthesize(vp, '你好', (c) => chunks.push(c))
    expect(translate).not.toHaveBeenCalled()
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '你好' }), expect.any(Function), expect.any(Object))
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }])
    expect(outcome).toBe('spoken')
  })

  it('targetLanguage=ja 且文本不含假名 → 先翻译再合成翻译后的文本', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    const outcome = await synthesize(vp, '你好', () => {})
    expect(translate).toHaveBeenCalledWith('你好', 'ja', expect.any(Object))
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'こんにちは' }), expect.any(Function), expect.any(Object))
    expect(outcome).toBe('spoken')
  })

  it('targetLanguage=ja 且文本已含假名 → 跳过翻译', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    const outcome = await synthesize(vp, 'こんにちは', () => {})
    expect(translate).not.toHaveBeenCalled()
    expect(outcome).toBe('spoken')
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
    const outcome = await synthesize(vp, '你好', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors[0]).toContain('翻译服务不可用')
    expect(outcome).toBe('failed')
  })

  it('sidecar.speak 失败 → onError 收到消息', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => { throw new Error('合成失败') }) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    const outcome = await synthesize(vp, '你好', () => {})
    expect(errors[0]).toContain('合成失败')
    expect(outcome).toBe('failed')
  })

  it('stop() 中断后翻译 reject → 返回 skipped 且不报错', async () => {
    let rejectTranslate: (error: Error) => void = () => {}
    const translate = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectTranslate = reject
    }))
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar: fakeSidecar(),
      translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: (message) => errors.push(message)
    })

    const result = synthesize(vp, '你好', () => {})
    vp.stop()
    rejectTranslate(new Error('请求已取消'))

    await expect(result).resolves.toBe('skipped')
    expect(errors).toEqual([])
  })

  it('stop() 中断后 sidecar reject → 返回 skipped 且不报错', async () => {
    let rejectSynthesis: (error: Error) => void = () => {}
    const sidecar = fakeSidecar({
      speak: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectSynthesis = reject
      }))
    })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar,
      translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (message) => errors.push(message)
    })

    const result = synthesize(vp, '你好', () => {})
    vp.stop()
    rejectSynthesis(new Error('请求已取消'))

    await expect(result).resolves.toBe('skipped')
    expect(errors).toEqual([])
  })

  it('空文本/纯空白 → 返回 skipped,不调用翻译或 sidecar', async () => {
    const sidecar = fakeSidecar()
    const translate = vi.fn()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    const outcome = await synthesize(vp, '   ', () => {})
    expect(translate).not.toHaveBeenCalled()
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(outcome).toBe('skipped')
  })

  it('只含 Markdown/符号、归一化后为空 → 直接跳过,不调用 sidecar(不当作错误)', async () => {
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    const outcome = await synthesize(vp, '`raw_only_code`', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(outcome).toBe('skipped')
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

  it('sidecar 正常完成但未产生 PCM → 返回 failed 并提示本段仅显示', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => {}) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })

    const outcome = await synthesize(vp, '你好', () => {})

    expect(outcome).toBe('failed')
    expect(errors).toEqual(['语音合成未返回音频,本段改为仅显示'])
  })

  it('sidecar 产生多个 PCM chunk → 全部转发且返回 spoken', async () => {
    const chunks: PcmChunk[] = []
    const first = { audioBase64: 'QUJD', sampleRate: 32000 }
    const second = { audioBase64: 'REVG', sampleRate: 24000 }
    const sidecar = fakeSidecar({
      speak: vi.fn(async (_req, onChunk) => {
        onChunk(first)
        onChunk(second)
      })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })

    const outcome = await synthesize(vp, '你好', (chunk) => chunks.push(chunk))

    expect(chunks).toEqual([first, second])
    expect(outcome).toBe('spoken')
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
