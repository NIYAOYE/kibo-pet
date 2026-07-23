import { describe, it, expect, vi } from 'vitest'
import { createTranslateSidecar } from './translateSidecar'

describe('createTranslateSidecar', () => {
  it('start() 起进程并等待就绪', async () => {
    const waitReady = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => ({ kill: vi.fn(), waitReady }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess, postJson: vi.fn() })
    await sc.start()
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(waitReady).toHaveBeenCalledOnce()
  })

  it('translate() 把请求转发给 postJson,返回 translation 字段', async () => {
    const postJson = vi.fn(async () => ({ translation: 'こんにちは' }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    const out = await sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal)
    expect(out).toBe('こんにちは')
    expect(postJson).toHaveBeenCalledWith(8860, '/translate', { text: '你好', source: 'zh', target: 'ja' }, expect.anything())
  })

  it('响应缺 translation 字段 → 抛错', async () => {
    const postJson = vi.fn(async () => ({}))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    await expect(sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal))
      .rejects.toThrow('本地翻译响应格式错误')
  })

  it('已取消的 signal → 立即拒绝,不调用 postJson', async () => {
    const postJson = vi.fn(async () => ({ translation: 'x' }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(sc.translate({ text: '你好', source: 'zh', target: 'ja' }, ctrl.signal)).rejects.toThrow()
    expect(postJson).not.toHaveBeenCalled()
  })

  it('超时 → 拒绝并携带超时信息,请求 signal 被 abort', async () => {
    vi.useFakeTimers()
    try {
      const request = { signal: null as AbortSignal | null }
      const postJson = vi.fn((_port, _path, _body, signal: AbortSignal) => {
        request.signal = signal
        return new Promise(() => {})
      })
      const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson, timeoutMs: 25 })
      let failure: unknown
      void sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal)
        .catch((e) => { failure = e })
      await vi.advanceTimersByTimeAsync(25)
      expect(request.signal?.aborted).toBe(true)
      expect((failure as Error).message).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() 杀掉进程', async () => {
    const kill = vi.fn()
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: () => ({ kill, waitReady: vi.fn(async () => {}) }), postJson: vi.fn() })
    await sc.start()
    sc.stop()
    expect(kill).toHaveBeenCalledOnce()
  })
})
