import { describe, it, expect } from 'vitest'
import { normalizeOpenAiChunks, type OpenAiChunkLike } from './openaiCompatProvider'
import type { StreamChunk } from '@shared/llm'

async function* feed(parts: OpenAiChunkLike[]): AsyncIterable<OpenAiChunkLike> {
  for (const p of parts) yield p
}
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

describe('normalizeOpenAiChunks', () => {
  it('delta.content → text chunk,末尾补 done', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '呀' }, finish_reason: 'stop' }] }
    ])))
    expect(chunks).toEqual([
      { type: 'text', text: '你好' },
      { type: 'text', text: '呀' },
      { type: 'done' }
    ])
  })

  it('tool_calls 分片(id/name 先到,arguments 分批)按 index 聚合,finish_reason=tool_calls 时吐齐', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"AI 新闻"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])))
    expect(chunks).toEqual([
      { type: 'tool_use', toolUse: { id: 'call_1', name: 'web_search', input: { query: 'AI 新闻' } } },
      { type: 'done' }
    ])
  })

  it('一轮并发两个 tool_calls(index 0/1)全部吐出且按 index 排序', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { tool_calls: [
        { index: 1, id: 'call_b', function: { name: 'read_skill', arguments: '{"name":"web-summary"}' } },
        { index: 0, id: 'call_a', function: { name: 'web_search', arguments: '{"query":"x"}' } }
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])))
    expect(chunks[0]).toEqual({ type: 'tool_use', toolUse: { id: 'call_a', name: 'web_search', input: { query: 'x' } } })
    expect(chunks[1]).toEqual({ type: 'tool_use', toolUse: { id: 'call_b', name: 'read_skill', input: { name: 'web-summary' } } })
  })

  it('arguments 是坏 JSON 时 input 回退 {}(由 registry 校验兜底)', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{oops' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])))
    expect(chunks[0]).toEqual({ type: 'tool_use', toolUse: { id: 'c', name: 'web_search', input: {} } })
  })
})
