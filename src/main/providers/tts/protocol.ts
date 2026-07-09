/** minimal_tts WebSocket 协议的 wire 类型,移植自 minimal_tts/electron/protocol.ts。 */
import type { TtsLanguage } from '@shared/llm'

export interface ReadyEvent {
  readonly type: 'ready'
  readonly protocol: number
  readonly host: string
  readonly port: number
  readonly token: string
  readonly device: string
  readonly precision: string
}

export interface StartMessage { readonly type: 'start'; readonly id: string; readonly language: TtsLanguage }
export interface EnqueueMessage { readonly type: 'enqueue'; readonly id: string; readonly sequence: number; readonly text: string }
export interface FinishMessage { readonly type: 'finish'; readonly id: string }
export interface CancelMessage { readonly type: 'cancel'; readonly id: string }
export type ClientMessage = StartMessage | EnqueueMessage | FinishMessage | CancelMessage

export interface SegmentStartEvent { readonly type: 'segment_start'; readonly id: string; readonly sequence: number }
export interface AudioStartEvent { readonly type: 'audio_start'; readonly id: string; readonly sampleRate: number; readonly channels: number; readonly format: string }
export interface SegmentEndEvent { readonly type: 'segment_end'; readonly id: string; readonly sequence: number }
export interface DoneEvent { readonly type: 'done'; readonly id: string }
export interface CancelledEvent { readonly type: 'cancelled'; readonly id: string }
export interface ReferenceReadyEvent { readonly type: 'reference_ready'; readonly id: string }
export interface ErrorEvent { readonly type: 'error'; readonly id: string | null; readonly code: string; readonly message: string; readonly fatal: boolean }

export type ServerEvent =
  | SegmentStartEvent
  | AudioStartEvent
  | SegmentEndEvent
  | DoneEvent
  | CancelledEvent
  | ReferenceReadyEvent
  | ErrorEvent

export function isBinaryMessage(data: unknown): data is ArrayBuffer {
  return data instanceof ArrayBuffer
}

export function parseServerEvent(raw: string): ServerEvent {
  const obj = JSON.parse(raw) as Record<string, unknown>
  if (typeof obj['type'] !== 'string') throw new Error('Server event missing type field')
  return obj as unknown as ServerEvent
}
