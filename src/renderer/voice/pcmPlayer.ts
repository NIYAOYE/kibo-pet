import { createPlaybackScheduler } from './playbackScheduler'

export interface PcmPlayer {
  /** 解码一段 base64 float32 PCM 并排队播放,与之前的块无缝衔接。 */
  play(audioBase64: string, sampleRate: number): void
  /** 立即停止所有已排队/正在播放的音频。 */
  stop(): void
}

export function createPcmPlayer(): PcmPlayer {
  const ctx = new AudioContext()
  const scheduler = createPlaybackScheduler()
  let sources: AudioBufferSourceNode[] = []

  function decode(audioBase64: string, sampleRate: number): AudioBuffer {
    const raw = atob(audioBase64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const floats = new Float32Array(bytes.buffer)
    const buffer = ctx.createBuffer(1, floats.length, sampleRate)
    buffer.copyToChannel(floats, 0)
    return buffer
  }

  return {
    play(audioBase64: string, sampleRate: number): void {
      const buffer = decode(audioBase64, sampleRate)
      const startAt = scheduler.scheduleNext(ctx.currentTime, buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(startAt)
      sources.push(src)
      src.onended = () => { sources = sources.filter((s) => s !== src) }
    },
    stop(): void {
      for (const s of sources) { try { s.stop() } catch { /* 已经播完的节点 stop() 会抛,忽略 */ } }
      sources = []
    }
  }
}
