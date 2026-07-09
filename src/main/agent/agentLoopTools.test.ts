import { describe, it, expect } from 'vitest'
import { runAgent, MAX_TOOL_ROUNDS, MAX_TRUNCATED_RETRIES } from './agentLoop'
import { createFakeProvider } from '../providers/fakeProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import type { ToolSpec } from '../tools/toolSpec'
import type { StreamChunk } from '@shared/llm'

const tu = (id: string, query: string): StreamChunk =>
  ({ type: 'tool_use', toolUse: { id, name: 'search', input: { query } } })
const text = (t: string): StreamChunk => ({ type: 'text', text: t })
const done: StreamChunk = { type: 'done' }

function searchTool(impl?: (input: unknown) => Promise<string>): { spec: ToolSpec; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    spec: {
      name: 'search',
      description: '假搜索',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async (input, ctx) => {
        calls.push(input)
        ctx.onStatus?.(`正在搜索:${(input as { query: string }).query}`)
        return impl ? impl(input) : `结果(${(input as { query: string }).query})`
      }
    }
  }
}

function base(script: StreamChunk[][], spec: ToolSpec) {
  return {
    provider: createFakeProvider({ script }),
    registry: createToolRegistry([spec]),
    system: 'sys',
    messages: [{ role: 'user' as const, content: '查一下' }],
    maxOutputTokens: 100,
    timeoutMs: 1000,
    signal: new AbortController().signal
  }
}

describe('runAgent 多轮工具循环', () => {
  it('单轮工具 → 文本收尾:工具被调,最终文本返回', async () => {
    const { spec, calls } = searchTool()
    const pushed: string[] = []
    const res = await runAgent({
      ...base([[tu('t1', 'AI'), done], [text('查到了:很多进展'), done]], spec),
      onText: (t) => pushed.push(t)
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('查到了:很多进展')
    expect(calls).toEqual([{ query: 'AI' }])
    expect(pushed.join('')).toBe('查到了:很多进展')
  })

  it('onStatus 从工具经 ToolContext 透传到调用方', async () => {
    const { spec } = searchTool()
    const statuses: string[] = []
    await runAgent({
      ...base([[tu('t1', 'AI'), done], [text('好'), done]], spec),
      onText: () => {},
      onStatus: (t) => statuses.push(t)
    })
    expect(statuses).toEqual(['正在搜索:AI'])
  })

  it('一轮多个 tool_use:全部执行且结果按序回灌后进入下一轮', async () => {
    const { spec, calls } = searchTool()
    const res = await runAgent({
      ...base([[tu('t1', 'A'), tu('t2', 'B'), done], [text('综合结论'), done]], spec),
      onText: () => {}
    })
    expect(calls).toEqual([{ query: 'A' }, { query: 'B' }])
    expect(res.text).toBe('综合结论')
  })

  it('连续多轮(搜两次)后收尾', async () => {
    const { spec, calls } = searchTool()
    const res = await runAgent({
      ...base([[tu('t1', '第一次'), done], [tu('t2', '第二次'), done], [text('两轮都查完了'), done]], spec),
      onText: () => {}
    })
    expect(calls).toHaveLength(2)
    expect(res.text).toBe('两轮都查完了')
  })

  it('到达轮数上限:停止并返回上限说明,不再调 provider', async () => {
    const { spec, calls } = searchTool()
    const script = Array.from({ length: MAX_TOOL_ROUNDS + 3 }, (_, i) => [tu(`t${i}`, `q${i}`), done])
    const res = await runAgent({ ...base(script, spec), onText: () => {} })
    expect(res.error).toContain('上限')
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS)
  })

  it('本轮无输出且 finishReason=length(被截断):自动重试而非静默收尾', async () => {
    const { spec, calls } = searchTool()
    const res = await runAgent({
      ...base([
        [{ type: 'done', finishReason: 'length' }],
        [tu('t1', 'AI'), done],
        [text('查到了'), done]
      ], spec),
      onText: () => {}
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('查到了')
    expect(calls).toEqual([{ query: 'AI' }])
  })

  it('截断重试次数耗尽后:不再无限重试,按空文本正常收尾', async () => {
    const { spec, calls } = searchTool()
    const truncatedRounds = Array.from(
      { length: MAX_TRUNCATED_RETRIES + 2 },
      () => [{ type: 'done', finishReason: 'length' } as StreamChunk]
    )
    const res = await runAgent({ ...base(truncatedRounds, spec), maxToolRounds: 20, onText: () => {} })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('')
    expect(calls).toEqual([])
  })

  it('临近轮数上限时,发给 provider 的 system 里追加轮次预算提醒(不写入 messages 历史)', async () => {
    const { spec } = searchTool()
    const seenSystems: string[] = []
    const provider = {
      async *streamChat(req: { system: string }): AsyncIterable<StreamChunk> {
        seenSystems.push(req.system)
        yield { type: 'tool_use', toolUse: { id: `t${seenSystems.length}`, name: 'search', input: { query: 'q' } } }
        yield { type: 'done' }
      }
    }
    await runAgent({
      provider,
      registry: createToolRegistry([spec]),
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
      maxToolRounds: 3,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onText: () => {}
    })
    expect(seenSystems[0]).toBe('BASE')
    expect(seenSystems[1]).not.toBe('BASE')
    expect(seenSystems[1]).toContain('轮')
    expect(seenSystems[2]).toContain('轮')
  })

  it('工具报错回灌(isError)不终止:模型下一轮正常收场', async () => {
    const { spec } = searchTool(async () => { throw new Error('后端限流') })
    const res = await runAgent({
      ...base([[tu('t1', 'x'), done], [text('查不到,换个话题吧'), done]], spec),
      onText: () => {}
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('查不到,换个话题吧')
  })

  it('工具执行中途外部取消:返回 canceled,不再进下一轮', async () => {
    const ctrl = new AbortController()
    const { spec } = searchTool(async () => { ctrl.abort(); return '太迟了' })
    const opts = base([[tu('t1', 'x'), done], [text('不该出现'), done]], spec)
    const res = await runAgent({ ...opts, signal: ctrl.signal, onText: () => {} })
    expect(res.canceled).toBe(true)
    expect(res.text).not.toContain('不该出现')
  })

  it('第二轮 provider 超时:返回超时错误(每轮独立计时)', async () => {
    // 第一轮正常吐 tool_use;第二轮脚本带 delayMs,拖过 timeoutMs 触发本轮超时
    const { spec } = searchTool()
    const provider = createFakeProvider({
      script: [
        [tu('t1', 'x'), done], // 首轮 2 chunk × 50ms = 100ms < 120ms,能过
        [text('太'), text('慢'), text('的'), text('回'), text('复'), done] // 第二轮 6 chunk × 50ms = 300ms,必超时
      ],
      delayMs: 50
    })
    const res = await runAgent({
      ...base([], spec),
      provider,
      timeoutMs: 120,
      onText: () => {}
    })
    // 无论停在哪一轮,超时都必须以 error 收尾且不静默吞掉
    expect(res.error).toBe('响应超时')
  })

  it('没传 registry(MVP-03 行为):纯文本流保持原样', async () => {
    const res = await runAgent({
      provider: createFakeProvider({ reply: '老样子', chunkSize: 10 }),
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onText: () => {}
    })
    expect(res.text).toBe('老样子')
  })

  it('工具返回 images 时,下一轮 provider 收到的 tool_result 消息携带 images', async () => {
    const imgTool: ToolSpec = {
      name: 'shot',
      description: '截图',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: async () => ({ content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'AAA' }] })
    }
    const seen: unknown[] = []
    const provider = {
      async *streamChat(req: { messages: unknown[] }) {
        seen.push(req.messages)
        if (seen.length === 1) { yield { type: 'tool_use' as const, toolUse: { id: 't1', name: 'shot', input: {} } }; yield { type: 'done' as const } }
        else { yield { type: 'text' as const, text: '看到了' }; yield { type: 'done' as const } }
      }
    }
    await runAgent({
      provider,
      registry: createToolRegistry([imgTool]),
      system: 'sys',
      messages: [{ role: 'user', content: '截个屏' }],
      maxOutputTokens: 100,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onText: () => {}
    })
    const secondCallMessages = seen[1] as Array<{ role: string; images?: unknown }>
    const toolResultMsg = secondCallMessages.find((m) => m.role === 'tool_result')
    expect(toolResultMsg?.images).toEqual([{ mimeType: 'image/jpeg', dataBase64: 'AAA' }])
  })
})
