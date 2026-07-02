import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'
import { toAnthropicMessages } from './messageMapping'

/** SDK 流事件的结构化最小集(供归一化与测试;真实事件结构兼容此形状) */
export interface AnthropicStreamEventLike {
  type: string
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string }
}

/**
 * 把 Anthropic 流事件归一成统一 chunk 协议:
 * tool_use 块从 content_block_start 开始聚合 input_json_delta,到 stop 才吐完整
 * ToolUse(绝不吐半截 JSON);input 解析失败时回退 {},由 registry 校验兜底。
 */
export async function* normalizeAnthropicEvents(
  events: AsyncIterable<AnthropicStreamEventLike>
): AsyncIterable<StreamChunk> {
  let current: { id: string; name: string; json: string } | null = null
  for await (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      current = { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' }
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && current) {
      current.json += event.delta.partial_json ?? ''
    } else if (event.type === 'content_block_stop' && current) {
      let input: unknown = {}
      try { input = current.json ? JSON.parse(current.json) : {} } catch { input = {} }
      yield { type: 'tool_use', toolUse: { id: current.id, name: current.name, input } }
      current = null
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text ?? '' }
    }
  }
  yield { type: 'done' }
}

export function createAnthropicProvider(opts: { apiKey: string; baseURL?: string; model: string }): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      try {
        const stream = client.messages.stream(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: toAnthropicMessages(req.messages) as never,
            ...(req.tools && req.tools.length > 0
              ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) as never }
              : {})
          },
          { signal: req.signal }
        )
        yield* normalizeAnthropicEvents(stream as AsyncIterable<AnthropicStreamEventLike>)
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
