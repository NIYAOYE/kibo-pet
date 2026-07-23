import { describe, it, expect, vi } from 'vitest'
import { createVoiceSidecar, type SpeakRequest } from './voiceSidecar'
import type { SseFrame } from './sseParser'

describe('first PCM timeout', () => {
  it('aborts and rejects an SSE request that produces neither PCM nor completion before the timeout', async () => {
    vi.useFakeTimers()
    try {
      const request = { signal: null as AbortSignal | null }
      const postSse = vi.fn((_port, _path, _body, _onFrame: (f: SseFrame) => void, signal: AbortSignal) => {
        request.signal = signal
        return new Promise<void>(() => {})
      })
      const sc = createVoiceSidecar({
        port: 8850,
        spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
        postSse,
        firstPcmTimeoutMs: 25
      })
      let failure: unknown
      void sc.speak(req, () => {}, new AbortController().signal).catch((error) => { failure = error })

      await vi.advanceTimersByTimeAsync(25)

      expect(request.signal?.aborted).toBe(true)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('first audio')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the timeout after audio starts so a slow normal SSE stream is not aborted', async () => {
    vi.useFakeTimers()
    try {
      const request = { signal: null as AbortSignal | null }
      let finishRequest: () => void = () => {}
      const postSse = vi.fn((_port, _path, _body, onFrame: (f: SseFrame) => void, signal: AbortSignal) => {
        request.signal = signal
        onFrame({ event: 'audio', data: JSON.stringify({ audio: 'QUJD', sampleRate: 32000 }) })
        return new Promise<void>((resolve) => { finishRequest = resolve })
      })
      const sc = createVoiceSidecar({
        port: 8850,
        spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
        postSse,
        firstPcmTimeoutMs: 25
      })
      const chunks: { audioBase64: string; sampleRate: number }[] = []
      const speaking = sc.speak(req, (chunk) => chunks.push(chunk), new AbortController().signal)

      await vi.advanceTimersByTimeAsync(100)
      expect(request.signal?.aborted).toBe(false)
      expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }])

      finishRequest()
      await speaking
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start an SSE request or report a timeout when its caller was already cancelled', async () => {
    const postSse = vi.fn(async () => {})
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse,
      firstPcmTimeoutMs: 1
    })
    const caller = new AbortController()
    caller.abort()

    await expect(sc.speak(req, () => {}, caller.signal)).rejects.toThrow('cancelled')
    expect(postSse).not.toHaveBeenCalled()
  })

  it('does not start an SSE request when cancellation wins before the scheduled request microtask', async () => {
    const postSse = vi.fn(async () => {})
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse,
      firstPcmTimeoutMs: 1
    })
    const caller = new AbortController()
    const speaking = sc.speak(req, () => {}, caller.signal)
    caller.abort()

    await expect(speaking).rejects.toThrow('cancelled')
    expect(postSse).not.toHaveBeenCalled()
  })
})

const req: SpeakRequest = {
  text: '你好', language: 'auto', segments: [{ lang: 'zh', text: '你好' }], isCutText: true, cutMinLen: 10, cutMute: 0.3,
  synthesisChunking: 'sentence', speed: 1, noiseScale: 0.5, temperature: 1,
  topK: 15, topP: 1, repetitionPenalty: 1.35
}

describe('createVoiceSidecar', () => {
  it('start() 调用 spawnProcess 并等待 waitReady', async () => {
    const kill = vi.fn()
    const waitReady = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => ({ kill, waitReady }))
    const postSse = vi.fn(async () => {})
    const sc = createVoiceSidecar({ port: 8850, spawnProcess, postSse })
    await sc.start()
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(waitReady).toHaveBeenCalledTimes(1)
  })

  it('speak():把 audio 帧转成 PcmChunk 逐个回调,done 帧后 resolve', async () => {
    const postSse = vi.fn(async (_port, _path, _body, onFrame: (f: SseFrame) => void) => {
      onFrame({ event: 'audio', data: JSON.stringify({ audio: 'QUJD', sampleRate: 32000 }) })
      onFrame({ event: 'audio', data: JSON.stringify({ audio: 'REVG', sampleRate: 32000 }) })
      onFrame({ event: 'done', data: '{}' })
    })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    const chunks: { audioBase64: string; sampleRate: number }[] = []
    await sc.speak(req, (c) => chunks.push(c), new AbortController().signal)
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }, { audioBase64: 'REVG', sampleRate: 32000 }])
  })

  it('speak():收到 error 帧 → 抛错,携带错误信息', async () => {
    const postSse = vi.fn(async (_port, _path, _body, onFrame: (f: SseFrame) => void) => {
      onFrame({ event: 'error', data: JSON.stringify({ error: '模型未加载' }) })
    })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    await expect(sc.speak(req, () => {}, new AbortController().signal)).rejects.toThrow('模型未加载')
  })

  it('speak():postSse 本身拒绝(连接失败等)→ 原样向上抛', async () => {
    const postSse = vi.fn(async () => { throw new Error('连接被拒绝') })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    await expect(sc.speak(req, () => {}, new AbortController().signal)).rejects.toThrow('连接被拒绝')
  })

  it('stop():调用 spawnProcess 返回对象的 kill()', async () => {
    const kill = vi.fn()
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill, waitReady: vi.fn(async () => {}) }),
      postSse: vi.fn(async () => {})
    })
    await sc.start()
    sc.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
