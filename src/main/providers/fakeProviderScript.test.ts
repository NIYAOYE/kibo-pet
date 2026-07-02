import { describe, it, expect } from 'vitest'
import { createFakeProvider } from './fakeProvider'
import type { StreamChunk } from '@shared/llm'

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

describe('fakeProvider script 模式', () => {
  it('每次 streamChat 按序消费一组脚本 chunk', async () => {
    const p = createFakeProvider({
      script: [
        [{ type: 'tool_use', toolUse: { id: 't1', name: 'web_search', input: { query: 'x' } } }, { type: 'done' }],
        [{ type: 'text', text: '查到了' }, { type: 'done' }]
      ]
    })
    const req = { system: '', messages: [], maxOutputTokens: 10, signal: new AbortController().signal }
    const first = await collect(p.streamChat(req))
    expect(first[0].type).toBe('tool_use')
    const second = await collect(p.streamChat(req))
    expect(second[0]).toEqual({ type: 'text', text: '查到了' })
  })

  it('脚本耗尽后重复最后一组', async () => {
    const p = createFakeProvider({ script: [[{ type: 'text', text: 'A' }, { type: 'done' }]] })
    const req = { system: '', messages: [], maxOutputTokens: 10, signal: new AbortController().signal }
    await collect(p.streamChat(req))
    const again = await collect(p.streamChat(req))
    expect(again[0]).toEqual({ type: 'text', text: 'A' })
  })
})
