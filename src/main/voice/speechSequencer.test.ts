import { describe, expect, it, vi } from 'vitest'
import { createSpeechSequencer } from './speechSequencer'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'
import type { VoiceSynthesisOutcome } from './voiceProvider'

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
}

interface ControlledSynthesis {
  text: string
  onChunk: (chunk: PcmChunk) => void
  complete: (outcome: VoiceSynthesisOutcome) => void
  fail: (error: Error) => void
}

function makeControllableSpeakOne() {
  const calls: string[] = []
  const syntheses: ControlledSynthesis[] = []
  const speakOne = vi.fn((text: string, onChunk: (chunk: PcmChunk) => void) => {
    calls.push(text)
    return new Promise<VoiceSynthesisOutcome>((resolve, reject) => {
      syntheses.push({ text, onChunk, complete: resolve, fail: reject })
    })
  })

  function synthesisAt(index: number): ControlledSynthesis {
    const synthesis = syntheses[index]
    if (!synthesis) throw new Error(`No synthesis call at index ${index}`)
    return synthesis
  }

  return {
    calls,
    speakOne,
    emit: (index: number, audioBase64?: string) => {
      const synthesis = synthesisAt(index)
      synthesis.onChunk({ audioBase64: audioBase64 ?? synthesis.text, sampleRate: 32000 })
    },
    complete: (index: number, outcome: VoiceSynthesisOutcome = 'spoken') => {
      synthesisAt(index).complete(outcome)
    },
    fail: (index: number) => {
      synthesisAt(index).fail(new Error('synthesis failed'))
    }
  }
}

function createSequencer(
  speakOne: (text: string, onChunk: (chunk: PcmChunk) => void) => Promise<VoiceSynthesisOutcome>,
  onChunk: (chunk: PcmChunk) => void = () => {},
  stopUnderlying: () => void = () => {},
  maxConcurrent = 2
) {
  return createSpeechSequencer({
    speakOne,
    onChunk,
    getSettings: () => DEFAULT_TTS_SETTINGS,
    stopUnderlying,
    maxConcurrent
  })
}

describe('createSpeechSequencer', () => {
  it('shows the segment only when its first playable chunk is released, before forwarding that chunk', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const displayed = sequencer.speak('first', () => events.push('display:first'))
    expect(events).toEqual([])

    controlled.emit(0, 'first-a')
    await displayed
    controlled.emit(0, 'first-b')

    expect(events).toEqual(['display:first', 'audio:first-a'])
    controlled.complete(0)
    await flushMicrotasks()
    expect(events).toEqual(['display:first', 'audio:first-a', 'audio:first-b'])
  })

  it('keeps display and audio in source order when a later segment synthesizes first', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const first = sequencer.speak('first', () => events.push('display:first'))
    const second = sequencer.speak('second', () => events.push('display:second'))
    controlled.emit(1)
    controlled.complete(1)
    await flushMicrotasks()
    expect(events).toEqual([])

    controlled.emit(0)
    await first
    expect(events).toEqual(['display:first', 'audio:first'])

    controlled.complete(0)
    await second
    expect(events).toEqual([
      'display:first', 'audio:first',
      'display:second', 'audio:second'
    ])
  })

  it('releases skipped, failed, and no-PCM segments as display-only in source order', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const skipped = sequencer.speak('skipped', () => events.push('display:skipped'))
    const failed = sequencer.speak('failed', () => events.push('display:failed'))
    const empty = sequencer.speak('empty', () => events.push('display:empty'))
    const spoken = sequencer.speak('spoken', () => events.push('display:spoken'))
    expect(controlled.calls).toEqual(['skipped', 'failed'])

    controlled.complete(1, 'failed')
    await flushMicrotasks()
    expect(events).toEqual([])

    controlled.complete(0, 'skipped')
    await flushMicrotasks()
    expect(events).toEqual(['display:skipped', 'display:failed'])
    expect(controlled.calls).toEqual(['skipped', 'failed', 'empty', 'spoken'])

    controlled.emit(3)
    controlled.complete(3)
    controlled.complete(2)
    await Promise.all([skipped, failed, empty, spoken])

    expect(events).toEqual([
      'display:skipped', 'display:failed', 'display:empty',
      'display:spoken', 'audio:spoken'
    ])
  })

  it('treats a rejected synthesis as display-only and continues the queue', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const first = sequencer.speak('first', () => events.push('display:first'))
    const second = sequencer.speak('second', () => events.push('display:second'))
    controlled.emit(1)
    controlled.complete(1)
    controlled.fail(0)

    await Promise.all([first, second])
    expect(events).toEqual(['display:first', 'display:second', 'audio:second'])
  })

  it('discards a later segment\'s buffered PCM when it finishes failed before its turn', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const first = sequencer.speak('first', () => events.push('display:first'))
    const failed = sequencer.speak('failed', () => events.push('display:failed'))
    controlled.emit(1)
    controlled.complete(1, 'failed')
    await flushMicrotasks()
    expect(events).toEqual([])

    controlled.complete(0, 'skipped')
    await Promise.all([first, failed])
    expect(events).toEqual(['display:first', 'display:failed'])
  })

  it('keeps only already forwarded PCM when a current segment later fails, then advances', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const failed = sequencer.speak('failed', () => events.push('display:failed'))
    const next = sequencer.speak('next', () => events.push('display:next'))
    controlled.emit(0, 'failed-a')
    await failed
    controlled.emit(0, 'failed-b')
    expect(events).toEqual(['display:failed', 'audio:failed-a'])

    controlled.complete(0, 'failed')
    controlled.emit(1)
    controlled.complete(1)
    await next
    expect(events).toEqual([
      'display:failed', 'audio:failed-a',
      'display:next', 'audio:next'
    ])
  })

  it('defaults to synthesizing one segment at a time (backends serialize inference)', async () => {
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {}
    })

    sequencer.speak('first', () => {})
    sequencer.speak('second', () => {})
    sequencer.speak('third', () => {})
    expect(controlled.calls).toEqual(['first'])

    controlled.complete(0, 'skipped')
    await flushMicrotasks()
    expect(controlled.calls).toEqual(['first', 'second'])

    controlled.complete(1, 'skipped')
    await flushMicrotasks()
    expect(controlled.calls).toEqual(['first', 'second', 'third'])
  })

  it('respects a configured maxConcurrent above the default', async () => {
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne)

    sequencer.speak('first', () => {})
    sequencer.speak('second', () => {})
    sequencer.speak('third', () => {})
    expect(controlled.calls).toEqual(['first', 'second'])

    controlled.complete(0, 'skipped')
    await flushMicrotasks()
    expect(controlled.calls).toEqual(['first', 'second', 'third'])
  })

  it('stop resolves every speak promise without displaying unreleased segments or forwarding old chunks', async () => {
    const events: string[] = []
    const stopUnderlying = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(
      controlled.speakOne,
      (chunk) => events.push(`audio:${chunk.audioBase64}`),
      stopUnderlying
    )

    const first = sequencer.speak('first', () => events.push('display:first'))
    const second = sequencer.speak('second', () => events.push('display:second'))
    const third = sequencer.speak('third', () => events.push('display:third'))
    sequencer.stop()

    await Promise.all([first, second, third])
    expect(stopUnderlying).toHaveBeenCalledOnce()
    expect(events).toEqual([])

    controlled.emit(0)
    controlled.complete(0)
    controlled.emit(1)
    controlled.complete(1)
    await flushMicrotasks()
    expect(events).toEqual([])
  })

  it('continues to release audio when onDisplay throws', async () => {
    const chunks: PcmChunk[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => chunks.push(chunk))

    const displayed = sequencer.speak('first', () => { throw new Error('render failed') })
    controlled.emit(0)
    await displayed

    expect(chunks).toEqual([{ audioBase64: 'first', sampleRate: 32000 }])
  })

  it('holds buffered chunks after the first until the segment is confirmed spoken', async () => {
    const chunks: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => chunks.push(chunk.audioBase64))

    sequencer.speak('first', () => {})
    sequencer.speak('second', () => {})
    controlled.emit(1, 'second-a')
    controlled.emit(1, 'second-b')
    controlled.complete(0, 'skipped')
    await flushMicrotasks()
    expect(chunks).toEqual(['second-a'])

    controlled.emit(1, 'second-c')
    expect(chunks).toEqual(['second-a'])

    controlled.complete(1)
    await flushMicrotasks()
    expect(chunks).toEqual(['second-a', 'second-b', 'second-c'])
  })

  it('signals normal reply production once only after every PCM chunk has been forwarded', async () => {
    const chunks: string[] = []
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: (chunk) => chunks.push(chunk.audioBase64),
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone
    })

    sequencer.speak('first', () => {})
    const firstFinish = sequencer.finishReply()
    const repeatedFinish = sequencer.finishReply()
    controlled.emit(0, 'first-a')
    controlled.emit(0, 'first-b')
    expect(onProductionDone).not.toHaveBeenCalled()

    controlled.complete(0)
    await Promise.all([firstFinish, repeatedFinish])

    expect(chunks).toEqual(['first-a', 'first-b'])
    expect(onProductionDone).toHaveBeenCalledOnce()
  })

  it('seals a recoverably failed reply but not a stopped reply', async () => {
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone
    })

    sequencer.speak('failed', () => {})
    const failedFinish = sequencer.finishReply()
    controlled.complete(0, 'failed')
    await failedFinish
    expect(onProductionDone).toHaveBeenCalledOnce()

    sequencer.speak('stopped', () => {})
    const stoppedFinish = sequencer.finishReply()
    sequencer.stop()
    await stoppedFinish
    expect(onProductionDone).toHaveBeenCalledOnce()
  })

  it('seals a reply after later recoverable synthesis failure once forwarded PCM is exhausted', async () => {
    const chunks: string[] = []
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: (chunk) => chunks.push(chunk.audioBase64),
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone,
      maxConcurrent: 2
    })

    sequencer.speak('spoken segment', () => {})
    sequencer.speak('failed segment', () => {})
    const finish = sequencer.finishReply()
    controlled.emit(0, 'spoken-pcm')
    controlled.complete(0, 'spoken')
    controlled.complete(1, 'failed')
    await finish

    expect(chunks).toEqual(['spoken-pcm'])
    expect(onProductionDone).toHaveBeenCalledOnce()
  })

  it('finalizes two sequential normal replies independently in one generation', async () => {
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone
    })

    sequencer.speak('first reply', () => {})
    const firstFinish = sequencer.finishReply()
    controlled.emit(0)
    controlled.complete(0)
    await firstFinish

    sequencer.speak('second reply', () => {})
    const secondFinish = sequencer.finishReply()
    controlled.emit(1)
    controlled.complete(1)
    await secondFinish

    expect(onProductionDone).toHaveBeenCalledTimes(2)
  })

  it('allows a normal reply to complete after an earlier reply failed', async () => {
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone
    })

    sequencer.speak('failed reply', () => {})
    const failedFinish = sequencer.finishReply()
    controlled.complete(0, 'failed')
    await failedFinish
    expect(onProductionDone).toHaveBeenCalledOnce()
    onProductionDone.mockClear()

    sequencer.speak('normal reply', () => {})
    const normalFinish = sequencer.finishReply()
    controlled.emit(1)
    controlled.complete(1)
    await normalFinish

    expect(onProductionDone).toHaveBeenCalledOnce()
  })

  it('does not invent production completion when finishReply follows stop', async () => {
    const onProductionDone = vi.fn()
    const controlled = makeControllableSpeakOne()
    const sequencer = createSpeechSequencer({
      speakOne: controlled.speakOne,
      onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS,
      stopUnderlying: () => {},
      onProductionDone
    })

    sequencer.speak('interrupted', () => {})
    sequencer.stop()
    await sequencer.finishReply()

    expect(onProductionDone).not.toHaveBeenCalled()
  })

  it('invalidates an old flush when onDisplay stops and starts a new generation', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))
    let replacement: Promise<void> | undefined

    const first = sequencer.speak('A', () => events.push('display:A'))
    const buffered = sequencer.speak('B', () => {
      events.push('display:B')
      sequencer.stop()
      replacement = sequencer.speak('C', () => events.push('display:C'))
    })
    controlled.emit(1, 'B-a')
    controlled.emit(1, 'B-b')
    controlled.complete(1)
    controlled.complete(0, 'skipped')

    await Promise.all([first, buffered])
    expect(events).toEqual(['display:A', 'display:B'])
    expect(controlled.calls).toEqual(['A', 'B', 'C'])

    let replacementResolved = false
    const replacementPromise = replacement!
    void replacementPromise.then(() => { replacementResolved = true })
    controlled.emit(2)
    await flushMicrotasks()
    expect(replacementResolved).toBe(true)
    expect(events).toEqual(['display:A', 'display:B', 'display:C', 'audio:C'])
    controlled.complete(2)
    await replacementPromise
  })

  it('keeps duplicate text segments distinct by synthesis call order', async () => {
    const events: string[] = []
    const controlled = makeControllableSpeakOne()
    const sequencer = createSequencer(controlled.speakOne, (chunk) => events.push(`audio:${chunk.audioBase64}`))

    const first = sequencer.speak('same text', () => events.push('display:first'))
    const second = sequencer.speak('same text', () => events.push('display:second'))
    controlled.emit(1, 'second-audio')
    controlled.complete(1)
    await flushMicrotasks()
    expect(events).toEqual([])

    controlled.emit(0, 'first-audio')
    await first
    controlled.complete(0)
    await second
    expect(events).toEqual([
      'display:first', 'audio:first-audio',
      'display:second', 'audio:second-audio'
    ])
  })

  it('passes getSettings through unchanged', () => {
    const getSettings = vi.fn(() => DEFAULT_TTS_SETTINGS)
    const sequencer = createSpeechSequencer({
      speakOne: vi.fn(async () => 'skipped' as const),
      onChunk: () => {},
      getSettings,
      stopUnderlying: () => {}
    })

    sequencer.getSettings()
    expect(getSettings).toHaveBeenCalledOnce()
  })
})
