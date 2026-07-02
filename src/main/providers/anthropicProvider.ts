import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

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
            messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
          },
          { signal: req.signal }
        )
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          }
        }
        yield { type: 'done' }
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
