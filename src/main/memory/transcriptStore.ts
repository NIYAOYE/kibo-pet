import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatMessage } from '@shared/ipc'

export const TRANSCRIPT_MAX = 200

export interface TranscriptFile { schemaVersion: 1; totalCount: number; messages: ChatMessage[] }

export function emptyTranscript(): TranscriptFile {
  return { schemaVersion: 1, totalCount: 0, messages: [] }
}

export function parseTranscript(raw: unknown): TranscriptFile {
  const r = (raw ?? {}) as Record<string, unknown>
  const messages = Array.isArray(r.messages)
    ? (r.messages as ChatMessage[]).filter(
        (m) => m && (m.role === 'user' || m.role === 'pet') && typeof m.text === 'string'
      ).map((m) => (typeof m.timestamp === 'number' ? { role: m.role, text: m.text, timestamp: m.timestamp } : { role: m.role, text: m.text }))
    : []
  const totalCount =
    typeof r.totalCount === 'number' && r.totalCount >= messages.length
      ? Math.trunc(r.totalCount)
      : messages.length
  return { schemaVersion: 1, totalCount, messages }
}

/** totalCount 是累计序号(单调递增),裁剪不回退——摘要的 coveredCount 依赖它对齐 */
export function appendMessage(t: TranscriptFile, msg: ChatMessage, max = TRANSCRIPT_MAX): TranscriptFile {
  const entry = typeof msg.timestamp === 'number'
    ? { role: msg.role, text: msg.text, timestamp: msg.timestamp }
    : { role: msg.role, text: msg.text }
  const messages = [...t.messages, entry]
  return {
    schemaVersion: 1,
    totalCount: t.totalCount + 1,
    messages: messages.length > max ? messages.slice(messages.length - max) : messages
  }
}

export function loadTranscript(path: string): TranscriptFile {
  try {
    return parseTranscript(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return emptyTranscript()
  }
}

export function saveTranscript(path: string, t: TranscriptFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(t, null, 2), 'utf-8')
  renameSync(tmp, path)
}
