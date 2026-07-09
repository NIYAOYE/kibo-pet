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

  it('message_delta 的 stop_reason 透传到 done(max_tokens 归一为 length)', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '嗯' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
    ])))
    expect(chunks).toEqual([
      { type: 'text', text: '嗯' },
      { type: 'done', finishReason: 'length' }
    ])
  })

  it('正常结束(end_turn)时 finishReason 原样透传,不归一', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])))
    expect(chunks).toEqual([{ type: 'done', finishReason: 'end_turn' }])
  })

  it('tool_use 块中途因 max_tokens 截断(content_block_stop 未到达):流结束时兜底 flush 出已聚合的部分', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_9', name: 'type_text' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"text":"被截断的很长一段文' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
      // 注意:没有 content_block_stop 事件——真实截断场景下它不会到来
    ])))
    expect(chunks[0].type).toBe('tool_use')
    expect((chunks[0] as { toolUse: { name: string; id: string; input: unknown } }).toolUse).toEqual({
      name: 'type_text',
      id: 'tu_9',
      input: {} // JSON 不完整(截断在字符串中间),解析失败回退 {},交给 registry 校验兜底报错
    })
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done', finishReason: 'length' })
  })
})
