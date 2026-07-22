import { describe, it, expect, vi } from 'vitest'
import { createPendingPrepareRequests } from './pendingPrepareRequests'

describe('createPendingPrepareRequests', () => {
  it('resolve() 在超时前调用:wait() 以该结果完成,不触发超时', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-1', 5000)
    registry.resolve('req-1', { ok: true })
    const result = await promise
    expect(result).toEqual({ ok: true })
    vi.useRealTimers()
  })

  it('超时未 resolve:wait() 以 MODEL_LOAD_TIMEOUT 失败结果完成', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-2', 5000)
    vi.advanceTimersByTime(5000)
    const result = await promise
    expect(result).toEqual({ ok: false, error: 'MODEL_LOAD_TIMEOUT' })
    vi.useRealTimers()
  })

  it('超时之后才 resolve() 是安静的 no-op,不影响已经完成的 wait()', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const promise = registry.wait('req-3', 1000)
    vi.advanceTimersByTime(1000)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(() => registry.resolve('req-3', { ok: true })).not.toThrow()
    vi.useRealTimers()
  })

  it('对不存在/未知的 requestId 调用 resolve() 是安静的 no-op', () => {
    const registry = createPendingPrepareRequests()
    expect(() => registry.resolve('never-registered', { ok: true })).not.toThrow()
  })

  it('两个并发请求互不干扰', async () => {
    vi.useFakeTimers()
    const registry = createPendingPrepareRequests()
    const p1 = registry.wait('a', 5000)
    const p2 = registry.wait('b', 5000)
    registry.resolve('b', { ok: true })
    registry.resolve('a', { ok: false, error: 'MODEL_SWITCH_FAILED' })
    expect(await p1).toEqual({ ok: false, error: 'MODEL_SWITCH_FAILED' })
    expect(await p2).toEqual({ ok: true })
    vi.useRealTimers()
  })
})
