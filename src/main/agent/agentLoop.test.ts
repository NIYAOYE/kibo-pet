import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agentLoop'
import { createFakeProvider } from '../providers/fakeProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import type { LlmProvider } from '../providers/llmProvider'
import type { StreamChunk } from '@shared/llm'
import type { ToolSpec } from '../tools/toolSpec'

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
    expect(res).toEqual({ text: 'abcd', toolsUsed: [] })
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

  it('工具执行期间取消(如桌面控制人工接管安全网检测到并调用 cancel)→ 不再发起下一轮 LLM 请求', async () => {
    // 回归用例:桌面控制场景里,manualOverrideWatch 检测到用户抓鼠标的那一刻通常正夹在
    // "上一个工具调用刚结束"和"下一轮 provider.streamChat 请求"之间——真机复现过这个信号
    // 落地慢了整整一轮 LLM 流式请求(几秒)才生效,不是"立刻"停。这里让一个假工具在自己
    // 的 run() 里模拟安全网触发:执行到一半直接 abort 外部 signal,验证 runAgent 在处理完
    // 这个工具后不会再无谓地打一次 streamChat(计数应停在 1,不应该变成 2)。
    let streamChatCalls = 0
    const ctrl = new AbortController()
    const countingProvider: LlmProvider = {
      async *streamChat(req) {
        streamChatCalls++
        if (streamChatCalls === 1) {
          yield { type: 'tool_use', toolUse: { id: 't1', name: 'click_at', input: {} } }
          yield { type: 'done' }
          return
        }
        if (req.signal.aborted) return
        yield { type: 'text', text: '不该走到这一轮' }
        yield { type: 'done' }
      }
    }
    const clickAt: ToolSpec = {
      name: 'click_at',
      description: 'd',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: async () => { ctrl.abort(); return 'ok' } // 模拟点击执行期间安全网检测到人工接管并 cancel()
    }
    const registry = createToolRegistry([clickAt])
    const res = await runAgent(base({ provider: countingProvider, registry, signal: ctrl.signal }))
    expect(res.canceled).toBe(true)
    expect(streamChatCalls).toBe(1) // 没有为了发现"已取消"而多打一轮 LLM 请求
  })
})
