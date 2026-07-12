import type { LlmProvider } from '../providers/llmProvider'
import type { AgentMessage, ToolUse } from '@shared/llm'
import type { ToolRegistry } from '../tools/toolRegistry'
import { pruneStaleImages } from './contextPruning'

/** §5.6 硬循环上限:单次请求最多工具调用轮数 */
export const MAX_TOOL_ROUNDS = 6
/** 单次请求中,"被截断导致本轮无文本无工具调用"这种疑似异常情况最多原地重试几次,防止病态反复截断吃光轮次预算 */
export const MAX_TRUNCATED_RETRIES = 3
/** 临近 maxRounds 时,提前几轮开始在 system 里追加预算提醒 */
const ROUND_BUDGET_WARN_THRESHOLD = 2

const TRUNCATED_RETRY_NUDGE =
  '\n\n(系统提示:你上一轮回复被截断且没有产生任何输出,请直接调用工具继续任务,不要输出多余的思考过程。)'

const REPEATED_FAILURE_NUDGE =
  '\n\n(系统提示:同一个工具用相同参数已连续失败多轮,不要原样重试;请换一种方式——调整参数、先查看当前状态,或向用户说明困难。)'

/**
 * 判定一次工具调用是否失败:registry 的硬失败走 isError;桌面/浏览器工具的
 * "软失败"(点击失败/输入失败等)按约定是把失败原因包成 "XX失败:…" 的普通
 * 文本回灌,agentLoop 只能靠这个文案前缀识别。启发式,仅用于追加提醒,不拦截。
 */
function looksFailed(r: { isError?: boolean; content: string }): boolean {
  return r.isError === true || /失败/.test(r.content.slice(0, 30))
}

function roundBudgetWarning(roundsLeftIncludingThis: number): string {
  return `\n\n(系统提示:本次任务你还剩 ${roundsLeftIncludingThis} 轮工具调用机会,请尽快完成当前动作或总结目前进度。)`
}

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

/** toolsUsed:本次运行按执行顺序实际调用过的工具名(可重复),供调用方落盘做跨回合动作摘要 */
export interface AgentRunResult { text: string; error?: string; canceled?: boolean; toolsUsed?: string[] }

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.signal.aborted) return { text: '', canceled: true }

  const tools = opts.registry?.defs()
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS
  const messages: AgentMessage[] = [...opts.messages]
  let text = ''
  let truncatedRetries = 0
  let pendingRetryNudge = ''
  const toolsUsed: string[] = []
  // 重复失败熔断:上一轮失败过的 (tool, input) 组合;本轮再次失败则下一轮提醒换方式
  let prevFailedKeys = new Set<string>()

  for (let round = 1; round <= maxRounds; round++) {
    // 每轮请求前剥离过期截图:旧图对当前决策几乎无用,却在长任务里每轮全量重发
    pruneStaleImages(messages)
    // system 的临时追加只作用于这一次请求,绝不写回 messages 历史(避免打破 Anthropic
    // 要求 user/assistant 角色交替的约束——tool_result 批次本身就会映射成一条 user 消息,
    // 再插一条独立的 user 消息有连续同角色的风险)。
    let systemThisRound = opts.system + pendingRetryNudge
    pendingRetryNudge = ''
    const roundsLeftIncludingThis = maxRounds - round + 1
    if (roundsLeftIncludingThis <= ROUND_BUDGET_WARN_THRESHOLD) {
      systemThisRound += roundBudgetWarning(roundsLeftIncludingThis)
    }

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
    let finishReason: string | undefined
    try {
      for await (const chunk of opts.provider.streamChat({
        system: systemThisRound,
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: internal.signal
      })) {
        // 取消/超时后立即停手,不再向 UI 推送被弃回复的文本(真实 SDK 不一定及时中止流)
        if (internal.signal.aborted) break
        if (chunk.type === 'text') { roundText += chunk.text; text += chunk.text; opts.onText(chunk.text) }
        else if (chunk.type === 'tool_use') toolUses.push(chunk.toolUse)
        else if (chunk.type === 'error') { cleanup(); return { text, toolsUsed, error: chunk.message } }
        else if (chunk.type === 'done') { finishReason = chunk.finishReason; break }
      }
    } catch (err) {
      cleanup()
      if (opts.signal.aborted && !timedOut) return { text, canceled: true }
      return { text, toolsUsed, error: timedOut ? '响应超时' : String((err as Error)?.message ?? err) }
    }
    cleanup()
    if (opts.signal.aborted && !timedOut) return { text, canceled: true }
    if (timedOut) return { text, toolsUsed, error: '响应超时' }

    console.log(
      `[agentLoop] round ${round}/${maxRounds} finishReason=${finishReason ?? 'n/a'} toolUses=${toolUses.length} textLen=${roundText.length}`
    )

    // 纯文本收尾:正常结束。但 finishReason==='length' 且本轮既无文本也无工具调用时,
    // 大概率是推理/输出预算在生成可见内容前就被耗尽(真机复现:gpt-5.5 多步任务中途
    // 完全静止),而不是模型真的"正常说完了"——原地重试而不是当作收尾直接返回。
    if (toolUses.length === 0) {
      const looksTruncatedEmpty = finishReason === 'length' && roundText.trim() === ''
      if (looksTruncatedEmpty && truncatedRetries < MAX_TRUNCATED_RETRIES) {
        truncatedRetries++
        pendingRetryNudge = TRUNCATED_RETRY_NUDGE
        continue
      }
      return { text, toolsUsed }
    }
    if (!opts.registry) return { text, error: '模型请求调用工具,但当前没有可用工具' }

    // 回灌顺序约束(anthropic):先一组 assistant tool_use,再一组 tool_result,同序配对。
    // 本轮已流出的文本挂在第一条 assistant_tool_use 上(mapper 会合并成一条消息)。
    toolUses.forEach((tu, i) => {
      messages.push({ role: 'assistant_tool_use', text: i === 0 && roundText ? roundText : undefined, toolUse: tu })
    })
    const failedKeys = new Set<string>()
    for (const tu of toolUses) {
      if (opts.signal.aborted) return { text, canceled: true }
      const r = await opts.registry.run(tu.name, tu.input, { signal: opts.signal, onStatus: opts.onStatus })
      if (opts.signal.aborted) return { text, canceled: true }
      toolsUsed.push(tu.name)
      if (looksFailed(r)) {
        const key = `${tu.name}:${JSON.stringify(tu.input ?? {})}`
        failedKeys.add(key)
        if (prevFailedKeys.has(key)) pendingRetryNudge = REPEATED_FAILURE_NUDGE
      }
      // 工具的"软失败"(比如 browser_click 点击失败)不会走 registry 的 isError/抛异常路径——
      // 它们是工具自己把失败原因包成普通文本回灌给模型的,agentLoop 之前完全看不到,只能靠
      // 模型自己的转述猜是什么问题。这里把每次工具调用的原始结果打出来,方便下次真机复现时
      // 直接查日志,而不是从对话里的转述反推。
      console.log(`[tool] ${tu.name} isError=${r.isError ?? false} content=${r.content.slice(0, 200)}`)
      messages.push({ role: 'tool_result', toolUseId: tu.id, content: r.content, isError: r.isError, images: r.images })
    }
    prevFailedKeys = failedKeys
  }

  return { text, toolsUsed, error: '工具调用轮数达到上限,已停止;先基于目前查到的内容回复吧' }
}
