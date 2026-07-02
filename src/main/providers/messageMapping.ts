import type { AgentMessage } from '@shared/llm'

/**
 * 两家 SDK 的消息形状(结构化最小集,调用处 as 到 SDK 类型)。
 * 纯函数,便于单测;不 import SDK 类型,避免测试拖入 SDK。
 */
export interface AnthropicMessageLike {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

export type OpenAiMessageLike = Record<string, unknown>

/**
 * Anthropic 约束:一轮的多个 tool_use 必须在同一条 assistant 消息里,
 * 全部 tool_result 必须在紧随其后的同一条 user 消息里、与 tool_use 同序。
 * 因此把连续的 assistant_tool_use / tool_result 各自合并。
 */
export function toAnthropicMessages(messages: AgentMessage[]): AnthropicMessageLike[] {
  const out: AnthropicMessageLike[] = []
  for (const m of messages) {
    if (m.role === 'assistant_tool_use') {
      const blocks: Array<Record<string, unknown>> = []
      if (m.text) blocks.push({ type: 'text', text: m.text })
      blocks.push({ type: 'tool_use', id: m.toolUse.id, name: m.toolUse.name, input: m.toolUse.input })
      const last = out[out.length - 1]
      if (last && last.role === 'assistant' && Array.isArray(last.content)) last.content.push(...blocks)
      else out.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool_result') {
      const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }
      if (m.isError) block.is_error = true
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export function toOpenAiMessages(system: string, messages: AgentMessage[]): OpenAiMessageLike[] {
  const out: OpenAiMessageLike[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant_tool_use') {
      const call = {
        id: m.toolUse.id,
        type: 'function',
        function: { name: m.toolUse.name, arguments: JSON.stringify(m.toolUse.input ?? {}) }
      }
      const last = out[out.length - 1] as { role?: string; content?: string | null; tool_calls?: unknown[] }
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(call)
        if (m.text) last.content = (last.content ?? '') + m.text
      } else {
        out.push({ role: 'assistant', content: m.text ?? null, tool_calls: [call] })
      }
    } else if (m.role === 'tool_result') {
      // openai 无 is_error 概念:错误信息就在 content 文本里,模型可读
      out.push({ role: 'tool', tool_call_id: m.toolUseId, content: m.content })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
