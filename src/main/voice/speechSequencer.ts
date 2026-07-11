import type { TtsSettings } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'

export interface SpeechSequencer {
  getSettings: () => TtsSettings
  speak: (text: string) => void
  stop: () => void
}

/** 最多同时有多少句在合成中("当前应播放的一句" + "预取的下一句")。 */
const MAX_CONCURRENT = 2

interface QueueItem { seq: number; text: string }
interface SeqBuffer { chunks: PcmChunk[]; finished: boolean }

/**
 * 把"哪句先合成完就先播放"改成"永远按文本顺序播放,同时允许最多
 * MAX_CONCURRENT 句在途合成"。
 *
 * 根因:sidecar 端用 threading.Lock 把并发合成请求串行化,但锁的获取顺序不保证
 * 和请求到达顺序一致;渲染层的播放队列又是"谁先到就排谁"——两层叠加导致乱序。
 * 这里用序号 + 缓冲区确保:只有轮到播放的那一句,它的音频块才会被转发;抢先
 * 合成完的下一句先缓冲住,等前一句真正播完再按顺序放出来。
 */
export function createSpeechSequencer(opts: {
  speakOne: (text: string, onChunk: (c: PcmChunk) => void) => Promise<void>
  onChunk: (c: PcmChunk) => void
  getSettings: () => TtsSettings
  stopUnderlying: () => void
}): SpeechSequencer {
  let nextSeq = 0
  let cursor = 0
  let inFlightCount = 0
  const pending: QueueItem[] = []
  const buffers = new Map<number, SeqBuffer>()

  function bufferFor(seq: number): SeqBuffer {
    let b = buffers.get(seq)
    if (!b) { b = { chunks: [], finished: false }; buffers.set(seq, b) }
    return b
  }

  /** 从 cursor 开始,把已经到位的音频块按顺序放出来;遇到还没合成完的就停在原地等下一次。 */
  function flush(): void {
    for (;;) {
      const b = buffers.get(cursor)
      if (!b) return
      if (b.chunks.length > 0) {
        for (const c of b.chunks) opts.onChunk(c)
        b.chunks = []
      }
      if (!b.finished) return
      buffers.delete(cursor)
      cursor++
    }
  }

  function pump(): void {
    while (inFlightCount < MAX_CONCURRENT && pending.length > 0) {
      const item = pending.shift()!
      const seq = item.seq
      inFlightCount++
      void opts.speakOne(item.text, (c) => {
        if (seq < cursor) return // 属于已被 stop() 跳过的旧一轮,丢弃
        bufferFor(seq).chunks.push(c)
        flush()
      }).finally(() => {
        inFlightCount--
        if (seq >= cursor) {
          bufferFor(seq).finished = true
          flush()
        }
        pump()
      }).catch(() => {
        // speakOne 失败(合成出错)时 .finally() 会让 rejection 继续冒泡;
        // voiceProvider 内部已经把错误报给 onError 了,这里只是防止
        // 出现 unhandled promise rejection,不需要再做任何事。
      })
    }
  }

  return {
    getSettings: opts.getSettings,
    speak(text: string): void {
      pending.push({ seq: nextSeq++, text })
      pump()
    },
    stop(): void {
      opts.stopUnderlying()
      pending.length = 0
      buffers.clear()
      cursor = nextSeq
    }
  }
}
