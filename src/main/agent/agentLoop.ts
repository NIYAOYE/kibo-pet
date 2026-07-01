import type { LlmProvider } from '../providers/llmProvider'
import type { ChatTurn } from '@shared/llm'

export interface AgentRunOptions {
  provider: LlmProvider
  system: string
  messages: ChatTurn[]
  maxOutputTokens: number
  timeoutMs: number
  signal: AbortSignal
  onText: (text: string) => void
}

export interface AgentRunResult { text: string; error?: string; canceled?: boolean }

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.signal.aborted) return { text: '', canceled: true }

  const internal = new AbortController()
  const onExternalAbort = (): void => internal.abort()
  opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; internal.abort() }, opts.timeoutMs)

  let text = ''
  const finish = (partial: AgentRunResult): AgentRunResult => {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onExternalAbort)
    if (opts.signal.aborted && !timedOut) return { text, canceled: true }
    if (timedOut) return { text, error: partial.error ?? '响应超时' }
    return partial
  }

  try {
    for await (const chunk of opts.provider.streamChat({
      system: opts.system,
      messages: opts.messages,
      maxOutputTokens: opts.maxOutputTokens,
      signal: internal.signal
    })) {
      if (chunk.type === 'text') { text += chunk.text; opts.onText(chunk.text) }
      else if (chunk.type === 'error') return finish({ text, error: chunk.message })
      else if (chunk.type === 'done') return finish({ text })
    }
    return finish({ text })
  } catch (err) {
    return finish({ text, error: String((err as Error)?.message ?? err) })
  }
}
