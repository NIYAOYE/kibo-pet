import { describe, it, expect } from 'vitest'
import { normalizeAnthropicEvents, type AnthropicStreamEventLike } from './anthropicProvider'
import type { StreamChunk } from '@shared/llm'

async function* feed(events: AnthropicStreamEventLike[]): AsyncIterable<AnthropicStreamEventLike> {
  for (const e of events) yield e
}
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

describe('normalizeAnthropicEvents', () => {
  it('text_delta → text chunk,末尾补 done', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '呀' } }
    ])))
    expect(chunks).toEqual([
      { type: 'text', text: '你好' },
      { type: 'text', text: '呀' },
      { type: 'done' }
    ])
  })

  it('tool_use block:start + input_json_delta 分片聚合,stop 时吐完整 tool_use(不吐半截 JSON)', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'web_search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"que' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'ry":"AI 新闻"}' } },
      { type: 'content_block_stop' }
    ])))
    expect(chunks).toEqual([
      { type: 'tool_use', toolUse: { id: 'tu_1', name: 'web_search', input: { query: 'AI 新闻' } } },
      { type: 'done' }
    ])
  })

  it('文本块与 tool_use 块混合(先说话后调工具)', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '我查查' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_2', name: 'web_search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
      { type: 'content_block_stop' }
    ])))
    expect(chunks[0]).toEqual({ type: 'text', text: '我查查' })
    expect(chunks[1].type).toBe('tool_use')
  })

  it('空 input(无 json delta)解析为 {}', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_3', name: 'read_skill' } },
      { type: 'content_block_stop' }
    ])))
    expect(chunks[0]).toEqual({ type: 'tool_use', toolUse: { id: 'tu_3', name: 'read_skill', input: {} } })
  })
})
