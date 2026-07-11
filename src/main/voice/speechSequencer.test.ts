import { describe, it, expect, vi } from 'vitest'
import { createSpeechSequencer } from './speechSequencer'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'

/** 造一个可以手动控制完成时机的 speakOne:每个文本对应一个可外部 resolve 的 Promise。 */
function makeControllableSpeakOne() {
  const releases = new Map<string, () => void>()
  const calls: string[] = []
  const speakOne = vi.fn((text: string, onChunk: (c: PcmChunk) => void) => {
    calls.push(text)
    return new Promise<void>((resolve) => {
      releases.set(text, () => {
        onChunk({ audioBase64: text, sampleRate: 32000 })
        resolve()
      })
    })
  })
  return {
    speakOne,
    calls,
    /** 让某个文本的合成"完成":发出它的音频块并 resolve 对应的 Promise。 */
    finish: (text: string) => releases.get(text)!()
  }
}

describe('createSpeechSequencer', () => {
  it('单句:speakOne 产生的音频块立即转发', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    finish('第一句')
    await Promise.resolve()
    expect(chunks).toEqual([{ audioBase64: '第一句', sampleRate: 32000 }])
  })

  it('两句合成完成顺序与文本顺序一致时,播放顺序也一致', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    finish('第一句')
    await Promise.resolve()
    finish('第二句')
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第一句', '第二句'])
  })

  it('核心修复:句子 2 比句子 1 先完成合成,播放顺序仍必须是 1 先、2 后', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish, calls } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    // 两句都已经开始合成(有限度预取):
    expect(calls).toEqual(['第一句', '第二句'])
    // 句子 2 先完成 —— 必须被缓冲,不能立即转发
    finish('第二句')
    await Promise.resolve()
    expect(chunks).toEqual([])
    // 句子 1 后完成 —— 此时应先转发 1,再把缓冲住的 2 一起转发
    finish('第一句')
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第一句', '第二句'])
  })

  it('并发上限为 2:第三句在前两句之一完成前不会开始合成', async () => {
    const { speakOne, finish, calls } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    seq.speak('第三句')
    expect(calls).toEqual(['第一句', '第二句'])
    finish('第一句')
    await Promise.resolve()
    expect(calls).toEqual(['第一句', '第二句', '第三句'])
  })

  it('某句合成失败(reject)不会卡住队列,后续句子正常推进', async () => {
    const chunks: PcmChunk[] = []
    const calls: string[] = []
    const releases = new Map<string, () => void>()
    const speakOne = vi.fn((text: string, onChunk: (c: PcmChunk) => void) => {
      calls.push(text)
      return new Promise<void>((resolve, reject) => {
        releases.set(text, () => {
          if (text === '第一句') reject(new Error('合成失败'))
          else { onChunk({ audioBase64: text, sampleRate: 32000 }); resolve() }
        })
      })
    })
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    releases.get('第一句')!()
    await Promise.resolve()
    await Promise.resolve()
    releases.get('第二句')!()
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第二句'])
  })

  it('stop() 清空队列 + 调用 stopUnderlying,之后残留的音频块不再被转发', async () => {
    const chunks: PcmChunk[] = []
    const stopUnderlying = vi.fn()
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying
    })
    seq.speak('第一句')
    seq.speak('第二句')
    seq.stop()
    expect(stopUnderlying).toHaveBeenCalledOnce()
    // 打断之后,即便旧请求最终还是"完成"了(真实场景里是 abort 触发的异常/空结果),
    // 它们的音频块也不应该被转发出去
    finish('第一句')
    finish('第二句')
    await Promise.resolve()
    expect(chunks).toEqual([])
  })

  it('stop() 之后新的 speak() 从头开始正常播放(不受旧一轮影响)', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('旧一轮')
    seq.stop()
    seq.speak('新一轮')
    finish('新一轮')
    await Promise.resolve()
    expect(chunks).toEqual([{ audioBase64: '新一轮', sampleRate: 32000 }])
  })

  it('getSettings 透传底层 getSettings', () => {
    const getSettings = vi.fn(() => DEFAULT_TTS_SETTINGS)
    const seq = createSpeechSequencer({
      speakOne: vi.fn(async () => {}), onChunk: () => {},
      getSettings, stopUnderlying: () => {}
    })
    seq.getSettings()
    expect(getSettings).toHaveBeenCalledOnce()
  })

  it('回归测试:预取的下一句在轮到它之前就已经吐出多个音频块,轮到它之后又继续吐,全部音频块都必须按顺序送出、一个不丢', async () => {
    const chunks: PcmChunk[] = []
    const emitters = new Map<string, (c: PcmChunk) => void>()
    const resolvers = new Map<string, () => void>()
    const speakOne = vi.fn((text: string, onChunk: (c: PcmChunk) => void) => {
      emitters.set(text, onChunk)
      return new Promise<void>((resolve) => { resolvers.set(text, resolve) })
    })
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')

    // 第二句(预取)在第一句还没播完时,就已经吐出了两个音频块——必须先缓冲住
    emitters.get('第二句')!({ audioBase64: '第二句-A', sampleRate: 32000 })
    emitters.get('第二句')!({ audioBase64: '第二句-B', sampleRate: 32000 })
    await Promise.resolve()
    expect(chunks).toEqual([])

    // 第一句播完,游标推进到第二句——此时被缓冲的 A、B 必须被放出来
    resolvers.get('第一句')!()
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第二句-A', '第二句-B'])

    // 第二句后续继续吐出的音频块,要能正常实时转发,不能因为"曾经被缓冲过"而卡住
    emitters.get('第二句')!({ audioBase64: '第二句-C', sampleRate: 32000 })
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第二句-A', '第二句-B', '第二句-C'])

    resolvers.get('第二句')!()
    await Promise.resolve()
  })
})
