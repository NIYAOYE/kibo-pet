import { describe, it, expect } from 'vitest'
import { toAnthropicMessages, toOpenAiMessages } from './messageMapping'
import type { AgentMessage } from '@shared/llm'

const history: AgentMessage[] = [
  { role: 'user', content: '今天有什么新闻' },
  { role: 'assistant_tool_use', text: '我查查看', toolUse: { id: 'tu_1', name: 'web_search', input: { query: '今日新闻' } } },
  { role: 'assistant_tool_use', toolUse: { id: 'tu_2', name: 'web_search', input: { query: 'AI 新闻' } } },
  { role: 'tool_result', toolUseId: 'tu_1', content: '结果A' },
  { role: 'tool_result', toolUseId: 'tu_2', content: '结果B', isError: true }
]

describe('toAnthropicMessages', () => {
  it('纯文本轮次原样映射', () => {
    expect(toAnthropicMessages([{ role: 'user', content: '嗨' }]))
      .toEqual([{ role: 'user', content: '嗨' }])
  })

  it('连续 assistant_tool_use 合并为一条 assistant 消息(text 块在前),连续 tool_result 合并为一条 user 消息且同序配对', () => {
    const out = toAnthropicMessages(history)
    expect(out).toHaveLength(3)
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '我查查看' },
        { type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: '今日新闻' } },
        { type: 'tool_use', id: 'tu_2', name: 'web_search', input: { query: 'AI 新闻' } }
      ]
    })
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '结果A' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: '结果B', is_error: true }
      ]
    })
  })
})

describe('toOpenAiMessages', () => {
  it('system 消息在最前,tool_result 映射为 role:tool', () => {
    const out = toOpenAiMessages('你是宠物', history)
    expect(out[0]).toEqual({ role: 'system', content: '你是宠物' })
    expect(out[1]).toEqual({ role: 'user', content: '今天有什么新闻' })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: '我查查看',
      tool_calls: [
        { id: 'tu_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"今日新闻"}' } },
        { id: 'tu_2', type: 'function', function: { name: 'web_search', arguments: '{"query":"AI 新闻"}' } }
      ]
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '结果A' })
    expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'tu_2', content: '结果B' })
  })
})
