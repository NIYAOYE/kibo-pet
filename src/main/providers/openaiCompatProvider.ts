import OpenAI from 'openai'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

export function createOpenAiCompatProvider(opts: { apiKey: string; baseURL?: string; model: string }): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      try {
        const stream = await client.chat.completions.create(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            stream: true,
            messages: [
              { role: 'system', content: req.system },
              ...req.messages.map((m) => ({ role: m.role, content: m.content }))
            ]
          },
          { signal: req.signal }
        )
        for await (const part of stream) {
          const text = part.choices?.[0]?.delta?.content
          if (text) yield { type: 'text', text }
        }
        yield { type: 'done' }
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
