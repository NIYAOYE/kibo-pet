import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agentLoop'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider } from '../providers/llmProvider'
import type { StreamChunk } from '@shared/llm'

const base = (over: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
  provider: createFakeProvider({ reply: 'abcd', chunkSize: 2 }),
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxOutputTokens: 64,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  onText: vi.fn(),
  ...over
})

describe('runAgent', () => {
  it('streams text via onText and returns the full accumulated text', async () => {
    const onText = vi.fn()
    const res = await runAgent(base({ onText }))
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['ab', 'cd'])
    expect(res).toEqual({ text: 'abcd' })
  })

  it('surfaces a provider error chunk as result.error', async () => {
    const res = await runAgent(base({ provider: createFakeProvider({ failWith: 'net down' }) }))
    expect(res.error).toBe('net down')
  })

  it('returns canceled when the signal is aborted before starting', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const onText = vi.fn()
    const res = await runAgent(base({ signal: ctrl.signal, onText }))
    expect(res.canceled).toBe(true)
    expect(onText).not.toHaveBeenCalled()
  })

  it('外部取消后立即停止向 UI 推送被弃回复的文本(即使 provider 仍在产出)', async () => {
    // 模拟不配合 abort 的真实 SDK:generator 不检查 signal,会一直往下 yield。
    const stubborn: LlmProvider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        yield { type: 'text', text: 'a' }
        await new Promise((r) => setTimeout(r, 5))
        yield { type: 'text', text: 'b' }
        await new Promise((r) => setTimeout(r, 5))
        yield { type: 'text', text: 'c' }
        yield { type: 'done' }
      }
    }
    const ctrl = new AbortController()
    const onText = vi.fn(() => { if (onText.mock.calls.length === 1) ctrl.abort() }) // 收到第一块后模拟"用户打断"
    const res = await runAgent(base({ provider: stubborn, signal: ctrl.signal, onText }))
    expect(res.canceled).toBe(true)
    expect(onText).toHaveBeenCalledTimes(1) // 只推了 'a';'b'/'c' 不再进入 UI
  })

  it('times out a hanging provider and reports 响应超时', async () => {
    // provider sleeps 1s between chunks (real), timeout 20ms → aborts
    const slow = createFakeProvider({ reply: 'abcd', chunkSize: 1, delayMs: 1000 })
    const res = await runAgent(base({ provider: slow, timeoutMs: 20 }))
    expect(res.error).toBe('响应超时')
  })
})
