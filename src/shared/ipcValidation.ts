import type { MoveDelta, ChatSendPayload } from './ipc'
import type { ProviderSettings, ProviderKind } from './llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']
const MAX_TEXT = 8000
const MAX_KEY = 4000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function validateMoveDelta(v: unknown): MoveDelta | null {
  if (!isObject(v)) return null
  if (!Number.isFinite(v.dx) || !Number.isFinite(v.dy)) return null
  if (v.clamp !== undefined && typeof v.clamp !== 'boolean') return null
  return { dx: v.dx as number, dy: v.dy as number, clamp: v.clamp as boolean | undefined }
}

export function validateBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export function validateChatSend(v: unknown): ChatSendPayload | null {
  if (!isObject(v)) return null
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT) return null
  if (v.attachments !== undefined && !Array.isArray(v.attachments)) return null
  const payload: ChatSendPayload = { text: v.text }
  if (Array.isArray(v.attachments)) payload.attachments = v.attachments as ChatSendPayload['attachments']
  return payload
}

export function validateKey(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_KEY ? v : null
}

export function validateProviderSettings(v: unknown): ProviderSettings | null {
  if (!isObject(v)) return null
  if (!KINDS.includes(v.kind as ProviderKind)) return null
  if (typeof v.model !== 'string' || v.model.length === 0) return null
  if (v.baseURL !== undefined && typeof v.baseURL !== 'string') return null
  return { kind: v.kind as ProviderKind, model: v.model, baseURL: v.baseURL as string | undefined }
}

export function validateTestConnectionArg(v: unknown): { provider: ProviderSettings; key: string } | null {
  if (!isObject(v)) return null
  const provider = validateProviderSettings(v.provider)
  const key = validateKey(v.key)
  if (!provider || key === null) return null
  return { provider, key }
}
