import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatMessage } from '@shared/ipc'
import type { LlmProvider } from '../providers/llmProvider'

export const SUMMARY_TRIGGER = 8
export const SUMMARY_MAX_TOKENS = 256
export const SUMMARY_TIMEOUT_MS = 30000

const SUMMARY_SYSTEM =
  '你是对话摘要器。把「已有摘要」与「新增对话」合并成一段简洁的中文工作记忆摘要:' +
  '只保留稳定事实、话题走向与未完成事项;不虚构、不评论;150 字以内;直接输出摘要正文。'

export interface SummaryFile { schemaVersion: 1; text: string; coveredCount: number; updatedAt: string }

export function emptySummary(): SummaryFile {
  return { schemaVersion: 1, text: '', coveredCount: 0, updatedAt: '' }
}

export function parseSummary(raw: unknown): SummaryFile {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    schemaVersion: 1,
    text: typeof r.text === 'string' ? r.text : '',
    coveredCount: typeof r.coveredCount === 'number' && r.coveredCount >= 0 ? Math.trunc(r.coveredCount) : 0,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ''
  }
}

/**
 * 溢出判定:窗口(windowTurns)之外、尚未被摘要覆盖(coveredCount,全局累计序号)的消息
 * ≥ trigger 条时,返回需总结的 messages 本地下标范围 [start, end) 与新的覆盖序号。
 * transcript 裁剪后 messages[0] 的全局序号 = totalCount - messagesLen,据此换算。
 */
export function overflowRange(
  t: { totalCount: number; messagesLen: number },
  coveredCount: number,
  windowTurns: number,
  trigger = SUMMARY_TRIGGER
): { start: number; end: number; newCoveredCount: number } | null {
  const base = t.totalCount - t.messagesLen
  const endGlobal = t.totalCount - windowTurns
  if (endGlobal - coveredCount < trigger) return null
  const startGlobal = Math.max(coveredCount, base)
  if (endGlobal <= startGlobal) return null
  return { start: startGlobal - base, end: endGlobal - base, newCoveredCount: endGlobal }
}

/** 失败/空回复返回 null,调用方保留旧摘要(§5.6:失败即状态,不重试) */
export async function summarize(opts: {
  provider: LlmProvider
  prevSummary: string
  messages: ChatMessage[]
  signal: AbortSignal
}): Promise<string | null> {
  const lines = opts.messages.map((m) => `${m.role === 'user' ? '用户' : '宠物'}:${m.text}`)
  const user =
    (opts.prevSummary ? `已有摘要:\n${opts.prevSummary}\n\n` : '') + `新增对话:\n${lines.join('\n')}`
  let text = ''
  try {
    for await (const chunk of opts.provider.streamChat({
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxOutputTokens: SUMMARY_MAX_TOKENS,
      signal: opts.signal
    })) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'error') return null
      else if (chunk.type === 'done') break
    }
  } catch {
    return null
  }
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function loadSummary(path: string): SummaryFile {
  try {
    return parseSummary(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return emptySummary()
  }
}

export function saveSummary(path: string, s: SummaryFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
  renameSync(tmp, path)
}
