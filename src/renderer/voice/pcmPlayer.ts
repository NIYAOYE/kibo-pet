import { createPlaybackScheduler } from './playbackScheduler'
import { computeEnvelope, LIP_SYNC_WINDOW_MS } from './lipSyncEnvelope'

export interface PcmPlayer {
  /** 解码一段 base64 float32 PCM 并排队播放,与之前的块无缝衔接。 */
  play(audioBase64: string, sampleRate: number): void
  /** 立即停止所有已排队/正在播放的音频。 */
  stop(): void
  /** 当前播放时刻(AudioContext.currentTime)对应的音量包络值,0~1；没有任何块覆盖
   *  当前时刻(未播放/已播完/已 stop)时返回 0。 */
  getCurrentLevel(): number
}

interface ActiveChunk { startAt: number; durationS: number; envelope: number[] }

export function createPcmPlayer(): PcmPlayer {
  const ctx = new AudioContext()
  const scheduler = createPlaybackScheduler()
  let sources: AudioBufferSourceNode[] = []
  let activeChunks: ActiveChunk[] = []

  function decode(audioBase64: string, sampleRate: number): { buffer: AudioBuffer; floats: Float32Array } {
    const raw = atob(audioBase64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const floats = new Float32Array(bytes.buffer)
    const buffer = ctx.createBuffer(1, floats.length, sampleRate)
    buffer.copyToChannel(floats, 0)
    return { buffer, floats }
  }

  return {
    play(audioBase64: string, sampleRate: number): void {
      const { buffer, floats } = decode(audioBase64, sampleRate)
      const startAt = scheduler.scheduleNext(ctx.currentTime, buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(startAt)
      sources.push(src)
      const chunk: ActiveChunk = { startAt, durationS: buffer.duration, envelope: computeEnvelope(floats, sampleRate, LIP_SYNC_WINDOW_MS) }
      activeChunks.push(chunk)
      src.onended = () => {
        sources = sources.filter((s) => s !== src)
        activeChunks = activeChunks.filter((c) => c !== chunk)
      }
    },
    stop(): void {
      for (const s of sources) { try { s.stop() } catch { /* 已经播完的节点 stop() 会抛,忽略 */ } }
      sources = []
      activeChunks = []
    },
    getCurrentLevel(): number {
      const now = ctx.currentTime
      const chunk = activeChunks.find((c) => now >= c.startAt && now < c.startAt + c.durationS)
      if (!chunk) return 0
      const windowSec = LIP_SYNC_WINDOW_MS / 1000
      const index = Math.min(Math.floor((now - chunk.startAt) / windowSec), chunk.envelope.length - 1)
      return chunk.envelope[index]
    }
  }
}
