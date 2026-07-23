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

/** A TTS segment must either start producing audio or finish within this bound. */
export const DEFAULT_FIRST_PCM_TIMEOUT_MS = 20_000

export interface VoiceSidecar {
  start(): Promise<void>
  speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void>
  stop(): void
}

export function createVoiceSidecar(opts: {
  port: number
  spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
  postSse: (port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal) => Promise<void>
  /** Test override; production uses DEFAULT_FIRST_PCM_TIMEOUT_MS. */
  firstPcmTimeoutMs?: number
}): VoiceSidecar {
  let proc: { kill(): void } | null = null

  return {
    async start(): Promise<void> {
      const p = opts.spawnProcess()
      proc = p
      await p.waitReady()
    },
    async speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error('TTS request cancelled')
      let sseError: string | null = null
      const request = new AbortController()
      const firstPcmTimeoutMs = opts.firstPcmTimeoutMs ?? DEFAULT_FIRST_PCM_TIMEOUT_MS
      let timeout: ReturnType<typeof setTimeout> | null = null
      let receivedPcm = false
      let finished = false

      const clearFirstPcmTimeout = (): void => {
        if (timeout === null) return
        clearTimeout(timeout)
        timeout = null
      }
      const abortRequest = (): void => request.abort()
      const onCallerAbort = (): void => abortRequest()
      if (signal.aborted) abortRequest()
      else signal.addEventListener('abort', onCallerAbort, { once: true })

      let rejectForCallerAbort: (reason: Error) => void = () => {}
      const onCallerAbortForRace = (): void => rejectForCallerAbort(new Error('TTS request cancelled'))
      const callerAbort = new Promise<never>((_resolve, reject) => {
        rejectForCallerAbort = reject
        if (signal.aborted) reject(new Error('TTS request cancelled'))
        else signal.addEventListener('abort', onCallerAbortForRace, { once: true })
      })
      const firstPcmTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          if (finished || receivedPcm || signal.aborted) return
          abortRequest()
          reject(new Error(`TTS first audio timeout after ${firstPcmTimeoutMs}ms`))
        }, firstPcmTimeoutMs)
      })

      try {
        const requestComplete = Promise.resolve().then(() => {
          if (request.signal.aborted) throw new Error('TTS request cancelled')
          return opts.postSse(opts.port, '/speak', req, (frame) => {
            if (request.signal.aborted) return
            if (frame.event === 'audio') {
              const parsed = JSON.parse(frame.data) as { audio: string; sampleRate: number }
              receivedPcm = true
              clearFirstPcmTimeout()
              onChunk({ audioBase64: parsed.audio, sampleRate: parsed.sampleRate })
            } else if (frame.event === 'error') {
              const parsed = JSON.parse(frame.data) as { error: string }
              sseError = parsed.error
            }
          }, request.signal)
        })
        await Promise.race([requestComplete, firstPcmTimeout, callerAbort])
        finished = true
      } finally {
        finished = true
        clearFirstPcmTimeout()
        signal.removeEventListener('abort', onCallerAbort)
        signal.removeEventListener('abort', onCallerAbortForRace)
      }
      if (sseError) throw new Error(sseError)
    },
    stop(): void {
      proc?.kill()
      proc = null
    }
  }
}
