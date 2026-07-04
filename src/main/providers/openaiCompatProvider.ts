import OpenAI from 'openai'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'
import { toOpenAiMessages } from './messageMapping'
import { describeProviderError } from './errorHint'

/** SDK 流分片的结构化最小集(供归一化与测试) */
export interface OpenAiChunkLike {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
}

/**
 * 聚合 OpenAI 流式 tool_calls 分片:同 index 的 id/name/arguments 逐片拼接,
 * finish_reason==='tool_calls' 时按 index 序吐出完整 ToolUse。
 */
export async function* normalizeOpenAiChunks(parts: AsyncIterable<OpenAiChunkLike>): AsyncIterable<StreamChunk> {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for await (const part of parts) {
    const choice = part.choices?.[0]
    if (!choice) continue
    const text = choice.delta?.content
    if (text) yield { type: 'text', text }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      calls.set(tc.index, slot)
    }
    if (choice.finish_reason === 'tool_calls') {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let input: unknown = {}
        try { input = c.args ? JSON.parse(c.args) : {} } catch { input = {} }
        yield { type: 'tool_use', toolUse: { id: c.id, name: c.name, input } }
      }
      calls.clear()
    }
  }
  yield { type: 'done' }
}

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
            messages: toOpenAiMessages(req.system, req.messages) as never,
            ...(req.tools && req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: 'function' as const,
                    function: { name: t.name, description: t.description, parameters: t.inputSchema }
                  }))
                }
              : {})
          },
          { signal: req.signal }
        )
        yield* normalizeOpenAiChunks(stream as AsyncIterable<OpenAiChunkLike>)
      } catch (err) {
        if (req.signal.aborted) return
        // 不支持 function calling 的端点/模型会在这里报错;文案指向解决办法
        const msg = String((err as Error)?.message ?? err)
        yield { type: 'error', message: describeProviderError(msg) }
      }
    }
  }
}
