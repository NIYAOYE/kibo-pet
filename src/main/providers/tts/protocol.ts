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

/** 判断一条 WebSocket 消息是否为二进制音频帧。
 *
 *  真实的 `ws` 库默认 `binaryType='nodebuffer'`,此时二进制帧交付到
 *  `onmessage` 的 `event.data` 是 Node `Buffer`(`ArrayBufferView` 的子类),
 *  不是 `ArrayBuffer`——调用方(shell/index.ts)已把 `binaryType` 显式设为
 *  `'arraybuffer'` 来避免这种情况,但这里仍额外接受 `ArrayBuffer.isView(data)`
 *  作为防御性兜底,避免未来任何一处 WebSocket 构造遗漏该设置时音频被再次
 *  静默丢弃。命中后应配合 `toArrayBuffer()` 归一化为真正的 `ArrayBuffer`。 */
export function isBinaryMessage(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data)
}

/** 把 `isBinaryMessage` 判定为二进制的数据归一化成真正的 `ArrayBuffer`。
 *  对 `ArrayBufferView`(如 Node `Buffer`)必须按 `byteOffset`/`byteLength`
 *  截取,而不能直接取 `.buffer`——Node 的 `Buffer` 常从共享内存池分配,
 *  `.buffer` 可能比这一帧本身大得多,直接使用会带上池里的无关字节。 */
export function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  const view = data as ArrayBufferView
  const src = view.buffer as ArrayBuffer
  return src.slice(view.byteOffset, view.byteOffset + view.byteLength)
}

export function parseServerEvent(raw: string): ServerEvent {
  const obj = JSON.parse(raw) as Record<string, unknown>
  if (typeof obj['type'] !== 'string') throw new Error('Server event missing type field')
  return obj as unknown as ServerEvent
}
