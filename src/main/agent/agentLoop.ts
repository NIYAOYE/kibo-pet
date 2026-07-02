import type { LlmProvider } from '../providers/llmProvider'
import type { AgentMessage, ToolUse } from '@shared/llm'
import type { ToolRegistry } from '../tools/toolRegistry'

/** §5.6 硬循环上限:单次请求最多工具调用轮数 */
export const MAX_TOOL_ROUNDS = 6

export interface AgentRunOptions {
  provider: LlmProvider
  system: string
  messages: AgentMessage[]
  registry?: ToolRegistry
  maxToolRounds?: number
  maxOutputTokens: number
  /** 每轮 provider 调用的超时(工具执行不计入,由取消信号兜底) */
  timeoutMs: number
  signal: AbortSignal
  onText: (text: string) => void
  onStatus?: (text: string) => void
}

export interface AgentRunResult { text: string; error?: string; canceled?: boolean }

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.signal.aborted) return { text: '', canceled: true }

  const tools = opts.registry?.defs()
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS
  const messages: AgentMessage[] = [...opts.messages]
  let text = ''

  for (let round = 1; round <= maxRounds; round++) {
    // 每轮独立的超时/取消桥接(沿用 MVP-03 的模式:外部 signal + 定时器 → 内部 abort)
    const internal = new AbortController()
    const onExternalAbort = (): void => internal.abort()
    opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; internal.abort() }, opts.timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onExternalAbort)
    }

    const toolUses: ToolUse[] = []
    let roundText = ''
    try {
      for await (const chunk of opts.provider.streamChat({
        system: opts.system,
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: internal.signal
      })) {
        // 取消/超时后立即停手,不再向 UI 推送被弃回复的文本(真实 SDK 不一定及时中止流)
        if (internal.signal.aborted) break
        if (chunk.type === 'text') { roundText += chunk.text; text += chunk.text; opts.onText(chunk.text) }
        else if (chunk.type === 'tool_use') toolUses.push(chunk.toolUse)
        else if (chunk.type === 'error') { cleanup(); return { text, error: chunk.message } }
        else if (chunk.type === 'done') break
      }
    } catch (err) {
      cleanup()
      if (opts.signal.aborted && !timedOut) return { text, canceled: true }
      return { text, error: timedOut ? '响应超时' : String((err as Error)?.message ?? err) }
    }
    cleanup()
    if (opts.signal.aborted && !timedOut) return { text, canceled: true }
    if (timedOut) return { text, error: '响应超时' }

    // 纯文本收尾:正常结束
    if (toolUses.length === 0) return { text }
    if (!opts.registry) return { text, error: '模型请求调用工具,但当前没有可用工具' }

    // 回灌顺序约束(anthropic):先一组 assistant tool_use,再一组 tool_result,同序配对。
    // 本轮已流出的文本挂在第一条 assistant_tool_use 上(mapper 会合并成一条消息)。
    toolUses.forEach((tu, i) => {
      messages.push({ role: 'assistant_tool_use', text: i === 0 && roundText ? roundText : undefined, toolUse: tu })
    })
    for (const tu of toolUses) {
      if (opts.signal.aborted) return { text, canceled: true }
      const r = await opts.registry.run(tu.name, tu.input, { signal: opts.signal, onStatus: opts.onStatus })
      if (opts.signal.aborted) return { text, canceled: true }
      messages.push({ role: 'tool_result', toolUseId: tu.id, content: r.content, isError: r.isError })
    }
  }

  return { text, error: '工具调用轮数达到上限,已停止;先基于目前查到的内容回复吧' }
}
