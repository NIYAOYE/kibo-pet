import type { TtsSettings } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'
import type { VoiceSynthesisOutcome } from './voiceProvider'

export interface SpeechSequencer {
  getSettings: () => TtsSettings
  speak: (text: string, onDisplay: () => void) => Promise<void>
  stop: () => void
}

/** The current sentence plus one prefetched sentence may synthesize at once. */
const MAX_CONCURRENT = 2

interface QueueItem {
  seq: number
  text: string
  onDisplay: () => void
  resolve: () => void
  displayed: boolean
  resolved: boolean
  outcome?: VoiceSynthesisOutcome
  hasPcm: boolean
  firstPcmForwarded: boolean
  chunks: PcmChunk[]
  finished: boolean
}

/**
 * Buffers prefetched PCM so both text and audio reach the renderer in the
 * original LLM order, even when synthesis completes out of order.
 */
export function createSpeechSequencer(opts: {
  speakOne: (text: string, onChunk: (c: PcmChunk) => void) => Promise<VoiceSynthesisOutcome>
  onChunk: (c: PcmChunk) => void
  getSettings: () => TtsSettings
  stopUnderlying: () => void
}): SpeechSequencer {
  let nextSeq = 0
  let cursor = 0
  let inFlightCount = 0
  let generation = 0
  const pending: QueueItem[] = []
  const items = new Map<number, QueueItem>()

  function releaseDisplay(item: QueueItem): void {
    if (item.displayed) return
    item.displayed = true
    try {
      item.onDisplay()
    } catch {
      // Rendering must not be able to block later text or audio from releasing.
    }
    if (!item.resolved) {
      item.resolved = true
      item.resolve()
    }
  }

  function resolveWithoutDisplay(item: QueueItem): void {
    if (item.resolved) return
    item.resolved = true
    item.resolve()
  }

  function isCurrentFlushItem(item: QueueItem, flushGeneration: number): boolean {
    return generation === flushGeneration && cursor === item.seq && items.get(item.seq) === item
  }

  /** Release every fully ordered item that is ready, stopping at the first gap. */
  function flush(): void {
    const flushGeneration = generation
    for (;;) {
      if (generation !== flushGeneration) return
      const item = items.get(cursor)
      if (!item) return

      const shouldDiscardPcm = item.outcome === 'failed' || item.outcome === 'skipped'
      if (shouldDiscardPcm) {
        item.chunks.length = 0
      } else if (item.chunks.length > 0) {
        releaseDisplay(item)
        if (!isCurrentFlushItem(item, flushGeneration)) return
        if (!item.firstPcmForwarded) {
          item.firstPcmForwarded = true
          opts.onChunk(item.chunks.shift()!)
          if (!isCurrentFlushItem(item, flushGeneration)) return
        }

        // The first chunk starts playback promptly. Keep the remainder until
        // synthesis confirms that this is a spoken segment, so a later failure
        // cannot release speculative buffered audio.
        if (item.outcome !== 'spoken') return

        const chunks = item.chunks.splice(0)
        for (const chunk of chunks) {
          opts.onChunk(chunk)
          if (!isCurrentFlushItem(item, flushGeneration)) return
        }
      }

      if (!item.finished) return

      // Skipped, failed, and no-PCM successful syntheses become display-only
      // precisely when all earlier source segments have been released.
      releaseDisplay(item)
      if (!isCurrentFlushItem(item, flushGeneration)) return
      items.delete(cursor)
      cursor++
    }
  }

  function finishSynthesis(item: QueueItem, outcome: VoiceSynthesisOutcome, runGeneration: number): void {
    if (runGeneration !== generation || !items.has(item.seq)) return
    item.outcome = outcome
    item.finished = true
    flush()
  }

  function startSynthesis(item: QueueItem): void {
    const runGeneration = generation
    inFlightCount++

    const onChunk = (chunk: PcmChunk) => {
      if (runGeneration !== generation || !items.has(item.seq)) return
      item.hasPcm = true
      item.chunks.push(chunk)
      flush()
    }

    const onSettled = () => {
      if (runGeneration !== generation) return
      inFlightCount--
      pump()
    }

    try {
      void opts.speakOne(item.text, onChunk).then(
        (outcome) => finishSynthesis(item, outcome, runGeneration),
        () => finishSynthesis(item, 'failed', runGeneration)
      ).then(onSettled, onSettled)
    } catch {
      finishSynthesis(item, 'failed', runGeneration)
      onSettled()
    }
  }

  function pump(): void {
    while (inFlightCount < MAX_CONCURRENT && pending.length > 0) {
      startSynthesis(pending.shift()!)
    }
  }

  return {
    getSettings: opts.getSettings,
    speak(text: string, onDisplay: () => void): Promise<void> {
      return new Promise<void>((resolve) => {
        const item: QueueItem = {
          seq: nextSeq++,
          text,
          onDisplay,
          resolve,
          displayed: false,
          resolved: false,
          hasPcm: false,
          firstPcmForwarded: false,
          chunks: [],
          finished: false
        }
        items.set(item.seq, item)
        pending.push(item)
        pump()
      })
    },
    stop(): void {
      // Invalidate callbacks before asking the provider to abort, because its
      // abort path can synchronously invoke a pending callback.
      generation++
      pending.length = 0
      for (const item of items.values()) resolveWithoutDisplay(item)
      items.clear()
      cursor = nextSeq
      inFlightCount = 0
      opts.stopUnderlying()
    }
  }
}
