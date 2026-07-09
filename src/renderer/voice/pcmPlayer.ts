/** 渲染层 PCM 播放,移植自 minimal_tts/electron/PcmPlayer.ts(class 改写成工厂函数,逻辑不变):
 *  int16 PCM → Float32Array,按 Web Audio 时钟顺序调度,取消/替换时停止已排队音频并忽略旧 id 的帧。 */

export interface PcmPlayer {
  start(id: string, sampleRate: number): void
  enqueue(id: string, pcm: ArrayBuffer): void
  cancel(id: string): void
  close(): void
}

export function createPcmPlayer(): PcmPlayer {
  let context: AudioContext | null = null
  let sampleRate = 0
  let activeId: string | null = null
  let nextStartTime = 0
  const sources = new Set<AudioBufferSourceNode>()

  function stopAll(): void {
    for (const source of sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    sources.clear()
    nextStartTime = 0
  }

  return {
    start(id, rate): void {
      if (activeId !== null && activeId !== id) stopAll()
      activeId = id
      sampleRate = rate
      if (!context) context = new AudioContext()
      if (context.state === 'suspended') void context.resume()
      nextStartTime = context.currentTime
    },
    enqueue(id, pcm): void {
      if (id !== activeId || !context) return
      const samples = new Int16Array(pcm)
      const float32 = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i++) float32[i] = samples[i]! / 32768
      const audioBuffer = context.createBuffer(1, float32.length, sampleRate)
      audioBuffer.getChannelData(0).set(float32)
      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      source.addEventListener('ended', () => { sources.delete(source) })
      sources.add(source)
      const startTime = Math.max(nextStartTime, context.currentTime)
      source.start(startTime)
      nextStartTime = startTime + audioBuffer.duration
    },
    cancel(id): void {
      if (id !== activeId) return
      stopAll()
      activeId = null
    },
    close(): void {
      stopAll()
      if (context) { void context.close(); context = null }
      activeId = null
      sampleRate = 0
    }
  }
}
