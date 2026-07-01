import type { ChatTurn, StreamChunk } from '@shared/llm'

export interface StreamChatRequest {
  system: string
  messages: ChatTurn[]
  maxOutputTokens: number
  signal: AbortSignal
}

export interface LlmProvider {
  streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk>
}
