import type { LlmProvider } from '../providers/llmProvider'

export interface GenerateContextualLineOptions {
  personaText: string
  processName: string
  windowTitle: string
  provider: LlmProvider
  /** 默认 5000ms */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const OPENER_INSTRUCTION =
  '用一句话，以你的口吻自然地对用户此刻在做的事搭话或吐槽。不要加引号，不要解释，只输出这一句话。'

/**
 * 借用为多轮工具调用设计的 streamChat 做一次单轮、无 tools 的短补全。
 * 任何失败(无结果/error chunk/超时/抛异常)都返回 null,调用方负责回退到预写台词池——
 * 不在这里重试,避免和上层 app_focus 的冷却节奏叠加出不可预期的调用频率。
 */
export async function generateContextualLine(opts: GenerateContextualLineOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const system = `${opts.personaText}\n\n${OPENER_INSTRUCTION}`
    const stream = opts.provider.streamChat({
      system,
      messages: [{ role: 'user', content: `用户刚切换到：${opts.processName} / ${opts.windowTitle}` }],
      maxOutputTokens: 60,
      signal: controller.signal
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'error') return null
      else if (chunk.type === 'done') break
    }
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
