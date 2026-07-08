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

  // 真机验证复现的真实 bug:回复因 max_tokens 被截断时 finish_reason 是 "length" 不是
  // "tool_calls",原实现只在 finish_reason==='tool_calls' 时才吐出累积的工具调用——
  // 截断场景下,已经聚合到的部分参数(哪怕不完整)被整个丢弃,agentLoop 那一轮直接
  // 收尾成纯文本回复,模型的工具调用意图完全消失、用户毫无察觉。现在 finish_reason
  // 是 "length" 时也要吐出(参数解析失败则回退 {},交给 registry 校验兜底报错,
  // 模型能看到"缺少必填参数"从而在下一轮重试——总比整个调用凭空消失强)。
  it('finish_reason=length 时仍吐出已聚合的 tool_calls(即便参数不完整)', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'type_text', arguments: '{"text":"部分被截断的很长一段文' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] }
    ])))
    expect(chunks[0].type).toBe('tool_use')
    expect((chunks[0] as { toolUse: { name: string } }).toolUse.name).toBe('type_text')
  })
})
