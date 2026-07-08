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

describe('图像序列化', () => {
  const img = { mimeType: 'image/jpeg', dataBase64: 'QUJD' }

  it('anthropic:user 图在前、文字在后', () => {
    const out = toAnthropicMessages([{ role: 'user', content: '这是什么', images: [img] }])
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'text', text: '这是什么' }
      ]
    })
  })

  it('openai-compat:user 文字在前、image_url data URL 在后', () => {
    const out = toOpenAiMessages('sys', [{ role: 'user', content: '这是什么', images: [img] }])
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
      ]
    })
  })

  it('无图 user 回合行为不变(字符串 content)', () => {
    expect(toAnthropicMessages([{ role: 'user', content: 'hi' }])[0]).toEqual({ role: 'user', content: 'hi' })
    expect(toOpenAiMessages('s', [{ role: 'user', content: 'hi' }])[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('纯图无文字:不产出空 text block', () => {
    const out = toAnthropicMessages([{ role: 'user', content: '', images: [img] }])
    expect((out[0].content as unknown[]).length).toBe(1)
  })
})

describe('tool_result 带图像', () => {
  const shotMsg: AgentMessage[] = [
    { role: 'tool_result', toolUseId: 'tu_1', content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'QUJD' }] }
  ]

  it('anthropic:tool_result content 数组内追加 image 块', () => {
    const out = toAnthropicMessages(shotMsg)
    expect(out).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'tu_1',
        content: [
          { type: 'text', text: '已截屏' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
        ]
      }]
    }])
  })

  it('openai-compat:tool 消息纯文本,紧随一条合成的 user image 消息', () => {
    const out = toOpenAiMessages('sys', shotMsg)
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '已截屏' })
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]
    })
  })

  it('tool_result 无 images 时行为不变(content 仍是字符串)', () => {
    const plain: AgentMessage[] = [{ role: 'tool_result', toolUseId: 'tu_1', content: '结果A' }]
    expect(toAnthropicMessages(plain)[0]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '结果A' }] })
    expect(toOpenAiMessages('s', plain)[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '结果A' })
  })

  it('并行工具调用:take_screenshot 非最后一个时,合成的 user image 消息不打断连续的 tool 消息(否则 OpenAI 400)', () => {
    const parallel: AgentMessage[] = [
      { role: 'assistant_tool_use', toolUse: { id: 't1', name: 'take_screenshot', input: {} } },
      { role: 'assistant_tool_use', toolUse: { id: 't2', name: 'list_windows', input: {} } },
      { role: 'tool_result', toolUseId: 't1', content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'QUJD' }] },
      { role: 'tool_result', toolUseId: 't2', content: '窗口列表' }
    ]
    const out = toOpenAiMessages('sys', parallel)
    expect(out).toHaveLength(5)
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: '已截屏' })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't2', content: '窗口列表' })
    expect(out[4]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]
    })
  })

  it('anthropic:tool_result content 为空字符串且带图像时,不产出空 text block(避免 Anthropic 400)', () => {
    const emptyTextMsg: AgentMessage[] = [
      { role: 'tool_result', toolUseId: 'tu_1', content: '', images: [{ mimeType: 'image/jpeg', dataBase64: 'QUJD' }] }
    ]
    const out = toAnthropicMessages(emptyTextMsg)
    expect(out).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'tu_1',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
        ]
      }]
    }])
  })
})
