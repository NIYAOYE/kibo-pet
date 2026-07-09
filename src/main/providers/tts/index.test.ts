import { describe, it, expect, vi } from 'vitest'
import { createTtsProvider } from './index'
import type { TtsClient } from './ttsClient'

function fakeClient(overrides?: Partial<TtsClient>): TtsClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    start: overrides?.start ?? vi.fn(async () => { calls.push('start'); return { type: 'ready', protocol: 1, host: '127.0.0.1', port: 1, token: 't', device: 'cpu', precision: 'fp32' } as const }),
    begin: vi.fn((id, lang) => calls.push(`begin:${id}:${lang}`)),
    pushToken: vi.fn((t) => calls.push(`pushToken:${t}`)),
    finish: vi.fn(() => calls.push('finish')),
    cancel: vi.fn(() => calls.push('cancel')),
    close: overrides?.close ?? vi.fn(async () => { calls.push('close') })
  }
}

describe('createTtsProvider', () => {
  it('enabled:false → start() 恒返回 false,begin/pushToken/finish/cancel 全部安全 no-op', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: false, client })
    expect(await provider.start()).toBe(false)
    provider.begin('x', 'zh')
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await provider.close()
    expect(client.calls).toEqual([]) // client 从未被真正调用
  })

  it('enabled:true 且 client.start() 成功 → start() 返回 true,后续调用透传给 client', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: true, client })
    expect(await provider.start()).toBe(true)
    provider.begin('x', 'ja')
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await provider.close()
    expect(client.calls).toEqual(['start', 'begin:x:ja', 'pushToken:hi', 'finish', 'cancel', 'close'])
  })

  it('enabled:true 但 client.start() 拒绝 → start() 返回 false,之后调用保持安全 no-op(不抛错)', async () => {
    const client = fakeClient({ start: vi.fn(async () => { throw new Error('sidecar 挂了') }) })
    const provider = createTtsProvider({ enabled: true, client })
    expect(await provider.start()).toBe(false)
    expect(() => provider.begin('x', 'zh')).not.toThrow()
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await expect(provider.close()).resolves.toBeUndefined()
    expect(client.begin).not.toHaveBeenCalled()
  })

  it('enabled:true 但未传 client → start() 返回 false,不抛错', async () => {
    const provider = createTtsProvider({ enabled: true })
    expect(await provider.start()).toBe(false)
    expect(() => provider.begin('x', 'zh')).not.toThrow()
  })

  it('close() 后 available 复位,再调用又变回 no-op', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: true, client })
    await provider.start()
    await provider.close()
    provider.begin('x', 'zh')
    expect(client.begin).not.toHaveBeenCalled()
  })
})
