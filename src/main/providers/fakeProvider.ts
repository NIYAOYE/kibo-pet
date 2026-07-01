import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

export interface FakeProviderOptions {
  reply?: string
  chunkSize?: number
  delayMs?: number
  failWith?: string
  sleep?: (ms: number) => Promise<void>
}

export function createFakeProvider(opts: FakeProviderOptions = {}): LlmProvider {
  const reply = opts.reply ?? '你好,我在。'
  const chunkSize = opts.chunkSize ?? 2
  const delayMs = opts.delayMs ?? 0
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      if (opts.failWith) { yield { type: 'error', message: opts.failWith }; return }
      for (let i = 0; i < reply.length; i += chunkSize) {
        if (req.signal.aborted) return
        if (delayMs > 0) await sleep(delayMs)
        if (req.signal.aborted) return
        yield { type: 'text', text: reply.slice(i, i + chunkSize) }
      }
      yield { type: 'done' }
    }
  }
}
