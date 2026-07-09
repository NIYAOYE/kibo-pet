/** 把一段中文文本整句翻译成目标语言,复用当前已配置的 LLM provider(不引入新依赖)。
 *  非流式:等模型吐完整段译文再返回,失败(取消/报错/空回复)一律静默返回 null,
 *  调用方据此决定"跳过朗读,只保留文字气泡"。 */
import type { LlmProvider } from '../providers/llmProvider'
import { runAgent } from './agentLoop'

const LANGUAGE_NAMES = { ja: '日语', en: '英语' } as const

export async function translateText(opts: {
  provider: LlmProvider
  text: string
  targetLanguage: 'ja' | 'en'
  signal: AbortSignal
  timeoutMs?: number
}): Promise<string | null> {
  const res = await runAgent({
    provider: opts.provider,
    system: `你是专业翻译。把用户给出的中文文本完整翻译成${LANGUAGE_NAMES[opts.targetLanguage]},只输出译文本身,不要解释、不要加引号或额外说明。`,
    messages: [{ role: 'user', content: opts.text }],
    maxOutputTokens: 1024,
    timeoutMs: opts.timeoutMs ?? 20000,
    signal: opts.signal,
    onText: () => {}
  })
  if (res.canceled || res.error) return null
  const trimmed = res.text.trim()
  return trimmed.length > 0 ? trimmed : null
}
