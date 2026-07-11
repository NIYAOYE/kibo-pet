import type { SseFrame } from './sseParser'
import type { TtsTargetLanguage } from '@shared/llm'

export interface SpeakRequest {
  text: string
  /** 发音语言:zh/ja 时 sidecar 强制整段按该语言发音(纯汉字的日语行会被自动检测误判成中文);auto/en 保持自动检测。 */
  language: TtsTargetLanguage
  isCutText: boolean; cutMinLen: number; cutMute: number
  synthesisChunking: 'token' | 'sentence'
  speed: number; noiseScale: number; temperature: number
  topK: number; topP: number; repetitionPenalty: number
}

export interface PcmChunk { audioBase64: string; sampleRate: number }

export interface VoiceSidecar {
  start(): Promise<void>
  speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void>
  stop(): void
}

export function createVoiceSidecar(opts: {
  port: number
  spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
  postSse: (port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal) => Promise<void>
}): VoiceSidecar {
  let proc: { kill(): void } | null = null

  return {
    async start(): Promise<void> {
      const p = opts.spawnProcess()
      proc = p
      await p.waitReady()
    },
    async speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void> {
      let sseError: string | null = null
      await opts.postSse(opts.port, '/speak', req, (frame) => {
        if (frame.event === 'audio') {
          const parsed = JSON.parse(frame.data) as { audio: string; sampleRate: number }
          onChunk({ audioBase64: parsed.audio, sampleRate: parsed.sampleRate })
        } else if (frame.event === 'error') {
          const parsed = JSON.parse(frame.data) as { error: string }
          sseError = parsed.error
        }
      }, signal)
      if (sseError) throw new Error(sseError)
    },
    stop(): void {
      proc?.kill()
      proc = null
    }
  }
}
