import type { TtsSettings } from '@shared/llm'
import { createSentenceSplitter, createSmartSplitter, type SentenceSplitter } from '../voice/sentenceSplitter'

/** The small part of voice playback that decides when a raw reply segment may appear. */
export interface VoiceReplyGate {
  isReady(): boolean
  getSettings(): TtsSettings
  speak(text: string, onDisplay: () => void): Promise<void>
}

export interface ReplyPresenter {
  append(chunk: string): void
  finish(): Promise<void>
  cancel(): void
  getText(): string
}

interface Segment {
  text: string
  displayReady: boolean
  pushed: boolean
  resolve: () => void
  completion: Promise<void>
}

function createSplitter(settings: TtsSettings): SentenceSplitter {
  return settings.textSplit === 'sentence' ? createSentenceSplitter() : createSmartSplitter()
}

/**
 * Preserves the original LLM stream while delegating the display moment to the
 * speech sequencer. The voice gate normally decides the display moment; a
 * resolved gate that omitted its callback falls back to a source-ordered
 * display so a malformed implementation cannot hide a completed reply.
 */
export function createReplyPresenter(opts: {
  voice?: VoiceReplyGate
  pushStream: (text: string) => void
}): ReplyPresenter {
  const voice = opts.voice
  // Voice capability and its settings are fixed for one LLM reply, so changing
  // a setting midway cannot mix the reply's display and playback policies.
  const voiceReady = voice?.isReady() === true
  const settings = voice ? { ...voice.getSettings() } : null
  const splitter = voiceReady && settings ? createSplitter(settings) : null
  const streamPlayback = settings?.playbackTrigger === 'stream'

  let rawText = ''
  let cancelled = false
  let finished = false
  let finishPromise: Promise<void> | null = null
  let displayCursor = 0
  const segments: Segment[] = []

  function push(text: string): void {
    if (cancelled) return
    try {
      opts.pushStream(text)
    } catch {
      // A renderer callback must not leave speech tasks or finish() hanging.
    }
  }

  function flushDisplays(): void {
    while (!cancelled) {
      const segment = segments[displayCursor]
      if (!segment || !segment.displayReady) return
      displayCursor++
      if (segment.pushed) continue
      segment.pushed = true
      push(segment.text)
    }
  }

  function markForDisplay(segment: Segment): void {
    if (cancelled || segment.displayReady) return
    segment.displayReady = true
    flushDisplays()
  }

  function enqueue(text: string): void {
    if (cancelled || !voice) return

    let resolveCompletion: () => void = () => {}
    const segment: Segment = {
      text,
      displayReady: false,
      pushed: false,
      resolve: () => resolveCompletion(),
      completion: new Promise<void>((resolve) => { resolveCompletion = resolve })
    }
    segments.push(segment)

    let spoken: Promise<void>
    try {
      spoken = voice.speak(text, () => markForDisplay(segment))
    } catch {
      markForDisplay(segment)
      segment.resolve()
      return
    }

    void Promise.resolve(spoken).then(
      () => {
        // SpeechSequencer resolves only after onDisplay under its normal
        // contract. Keep a defensive fallback for another gate that resolves
        // without the callback; flushDisplays still prevents later segments
        // from overtaking an earlier one.
        markForDisplay(segment)
        segment.resolve()
      },
      () => {
        // Synthesis failures fall back to source-order text exactly once.
        markForDisplay(segment)
        segment.resolve()
      }
    )
  }

  function enqueueBatch(): void {
    if (!settings) return
    const batchSplitter = createSplitter(settings)
    for (const segment of batchSplitter.push(rawText)) enqueue(segment)
    const tail = batchSplitter.flush()
    if (tail) enqueue(tail)
  }

  return {
    append(chunk: string): void {
      if (cancelled || finished) return
      rawText += chunk

      if (!voiceReady) {
        push(chunk)
        return
      }

      if (streamPlayback) {
        for (const segment of splitter!.push(chunk)) enqueue(segment)
      }
    },

    finish(): Promise<void> {
      if (finishPromise) return finishPromise
      if (cancelled) {
        finishPromise = Promise.resolve()
        return finishPromise
      }

      finished = true
      if (voiceReady) {
        if (streamPlayback) {
          const tail = splitter!.flush()
          if (tail) enqueue(tail)
        } else {
          enqueueBatch()
        }
      }

      finishPromise = Promise.all(segments.map((segment) => segment.completion)).then(() => undefined)
      return finishPromise
    },

    cancel(): void {
      if (cancelled) return
      cancelled = true
      for (const segment of segments) segment.resolve()
    },

    getText(): string {
      return rawText
    }
  }
}
