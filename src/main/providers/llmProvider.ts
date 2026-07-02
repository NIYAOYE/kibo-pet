import type { AgentMessage, StreamChunk, ToolDef } from '@shared/llm'

export interface StreamChatRequest {
  system: string
  messages: AgentMessage[]
  tools?: ToolDef[]
  maxOutputTokens: number
  signal: AbortSignal
}

export interface LlmProvider {
  streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk>
}
