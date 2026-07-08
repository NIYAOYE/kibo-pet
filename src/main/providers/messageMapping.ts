import type { AgentMessage, ImagePart } from '@shared/llm'

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
      const contentBlocks: Array<Record<string, unknown>> = []
      if (m.content) contentBlocks.push({ type: 'text', text: m.content })
      if (m.images && m.images.length > 0) {
        for (const img of m.images) contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 } })
      }
      const block: Record<string, unknown> = m.images && m.images.length > 0
        ? { type: 'tool_result', tool_use_id: m.toolUseId, content: contentBlocks }
        : { type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }
      if (m.isError) block.is_error = true
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    } else if (m.role === 'user' && m.images && m.images.length > 0) {
      const blocks: Array<Record<string, unknown>> = m.images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 }
      }))
      if (m.content) blocks.push({ type: 'text', text: m.content })
      out.push({ role: 'user', content: blocks })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export function toOpenAiMessages(system: string, messages: AgentMessage[]): OpenAiMessageLike[] {
  const out: OpenAiMessageLike[] = [{ role: 'system', content: system }]
  // OpenAI 要求:一批 parallel tool_calls 对应的所有 tool 消息必须紧跟在发起它们的
  // assistant 消息之后连续出现,中间不能插入别的消息。take_screenshot 的图片曾在其
  // 对应的 tool 消息后立即以一条合成 user 消息插入,若该轮还有其他工具且顺序不是最后一个,
  // 就会打断这批 tool 消息的连续性。改为缓冲图片,只在这段连续的 tool_result 结束时
  // (即将处理下一条非 tool_result 消息之前,或数组末尾)才 flush 成一条合成 user 消息。
  let pendingImages: ImagePart[] = []
  const flushPendingImages = (): void => {
    if (pendingImages.length === 0) return
    out.push({
      role: 'user',
      content: pendingImages.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } }))
    })
    pendingImages = []
  }
  for (const m of messages) {
    if (m.role === 'assistant_tool_use') {
      flushPendingImages()
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
      if (m.images && m.images.length > 0) pendingImages.push(...m.images)
    } else if (m.role === 'user' && m.images && m.images.length > 0) {
      flushPendingImages()
      const content: Array<Record<string, unknown>> = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const img of m.images) content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } })
      out.push({ role: 'user', content })
    } else {
      flushPendingImages()
      out.push({ role: m.role, content: m.content })
    }
  }
  flushPendingImages()
  return out
}
