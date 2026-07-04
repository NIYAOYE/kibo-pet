import type { MoveDelta, ChatSendPayload, ChatSendAttachment, OverlayRect } from './ipc'
import type { ProviderSettings, ProviderKind } from './llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']
const MAX_TEXT = 8000
const MAX_KEY = 4000

export const MAX_ATTACHMENTS = 6
export const MAX_IMAGE_B64 = 14_000_000
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

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

function validateAttachment(v: unknown): { kind: 'image'; mimeType: string; dataBase64: string } | null {
  if (!isObject(v)) return null
  if (v.kind !== 'image') return null
  if (typeof v.mimeType !== 'string' || !IMAGE_MIME.includes(v.mimeType)) return null
  if (typeof v.dataBase64 !== 'string' || v.dataBase64.length === 0 || v.dataBase64.length > MAX_IMAGE_B64) return null
  return { kind: 'image', mimeType: v.mimeType, dataBase64: v.dataBase64 }
}

export function validateChatSend(v: unknown): ChatSendPayload | null {
  if (!isObject(v)) return null
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT) return null
  const payload: ChatSendPayload = { text: v.text }
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments) || v.attachments.length > MAX_ATTACHMENTS) return null
    const atts: ChatSendAttachment[] = []
    for (const a of v.attachments) {
      const att = validateAttachment(a)
      if (!att) return null
      atts.push(att)
    }
    if (atts.length > 0) payload.attachments = atts
  }
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

export function validateOverlayRect(v: unknown): OverlayRect | null {
  if (!isObject(v)) return null
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.width) || !Number.isFinite(v.height)) return null
  return { x: v.x as number, y: v.y as number, width: v.width as number, height: v.height as number }
}
