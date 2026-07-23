import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TTS_SETTINGS, type TtsSettings } from '@shared/llm'
import { createReplyPresenter, type VoiceReplyGate } from './replyPresenter'

interface ControlledCall {
  text: string
  onDisplay: () => void
  resolve: () => void
  reject: (error: Error) => void
}

function settings(overrides: Partial<TtsSettings> = {}): TtsSettings {
  return { ...DEFAULT_TTS_SETTINGS, ...overrides }
}

function createControlledVoice(config: {
  ready?: boolean
  settings?: TtsSettings
} = {}): { voice: VoiceReplyGate; calls: ControlledCall[]; speak: ReturnType<typeof vi.fn> } {
  const calls: ControlledCall[] = []
  const speak = vi.fn((text: string, onDisplay: () => void) => new Promise<void>((resolve, reject) => {
    calls.push({ text, onDisplay, resolve, reject })
  }))

  return {
    voice: {
      isReady: () => config.ready ?? true,
      getSettings: () => config.settings ?? settings(),
      speak
    },
    calls,
    speak
  }
}

async function settle(call: ControlledCall): Promise<void> {
  call.onDisplay()
  call.resolve()
  await Promise.resolve()
}

describe('createReplyPresenter', () => {
  it('immediately streams each chunk and never speaks when voice is unavailable', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ ready: false })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('first ')
    presenter.append('second')

    expect(pushed).toEqual(['first ', 'second'])
    expect(controlled.speak).not.toHaveBeenCalled()
    expect(presenter.getText()).toBe('first second')
    await presenter.finish()
    expect(pushed).toEqual(['first ', 'second'])
  })

  it('streams complete segments through speech display callbacks and flushes the tail on finish', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('First')
    expect(controlled.calls).toEqual([])
    presenter.append('. Tail')
    expect(controlled.calls.map((call) => call.text)).toEqual(['First.'])
    expect(pushed).toEqual([])

    await settle(controlled.calls[0])
    const finishing = presenter.finish()
    expect(controlled.calls.map((call) => call.text)).toEqual(['First.', ' Tail'])
    await settle(controlled.calls[1])
    await finishing

    expect(pushed).toEqual(['First.', ' Tail'])
    expect(presenter.getText()).toBe('First. Tail')
  })

  it('defers batch speech until finish and queues the original segments in order', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'batch', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('One. Two')
    expect(controlled.calls).toEqual([])

    const finishing = presenter.finish()
    expect(controlled.calls.map((call) => call.text)).toEqual(['One.', ' Two'])
    await settle(controlled.calls[0])
    await settle(controlled.calls[1])
    await finishing

    expect(pushed).toEqual(['One.', ' Two'])
  })

  it('keeps displayed segments in source order when speech display callbacks arrive out of order', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('First. Second.')
    expect(controlled.calls.map((call) => call.text)).toEqual(['First.', ' Second.'])
    controlled.calls[1].onDisplay()
    expect(pushed).toEqual([])
    controlled.calls[0].onDisplay()
    expect(pushed).toEqual(['First.', ' Second.'])

    controlled.calls[1].resolve()
    controlled.calls[0].resolve()
    await presenter.finish()
  })

  it('passes URL-bearing raw segments unchanged to speech and display', async () => {
    const pushed: string[] = []
    const raw = 'See http://localhost:8080/path.'
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append(raw)
    expect(controlled.calls).toEqual([])
    const finishing = presenter.finish()
    expect(controlled.calls[0].text).toBe(raw)
    await settle(controlled.calls[0])
    await finishing

    expect(pushed).toEqual([raw])
  })

  it('keeps cross-chunk URLs and multiline fenced code as complete raw speech segments in batch mode', async () => {
    const pushed: string[] = []
    const url = 'See https://example.com/path.\n'
    const fence = '~~~ts\nconst endpoint = "https://example.com/path"\nconsole.log(endpoint)\n~~~'
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'batch', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('See https://exam')
    presenter.append(`ple.com/path.\n${fence.slice(0, 36)}`)
    presenter.append(fence.slice(36))

    const finishing = presenter.finish()
    expect(controlled.calls.map((call) => call.text)).toEqual([url, fence])

    for (const call of controlled.calls) await settle(call)
    await finishing

    expect(pushed.join('')).toBe(`${url}${fence}`)
  })

  it('waits for queued speech promises and does not display a segment twice across repeated finish calls', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('Only.')
    let resolved = false
    const finishing = presenter.finish().then(() => { resolved = true })
    expect(resolved).toBe(false)
    controlled.calls[0].onDisplay()
    expect(pushed).toEqual(['Only.'])
    expect(resolved).toBe(false)
    controlled.calls[0].resolve()
    await finishing
    await presenter.finish()

    expect(pushed).toEqual(['Only.'])
  })

  it('falls back to display before finish when a normally resolved voice gate omits onDisplay', async () => {
    const pushed: string[] = []
    let releaseDisplay: (() => void) | undefined
    const voice: VoiceReplyGate = {
      isReady: () => true,
      getSettings: () => settings({ playbackTrigger: 'stream', textSplit: 'sentence' }),
      speak: (_text, onDisplay) => {
        releaseDisplay = onDisplay
        return Promise.resolve()
      }
    }
    const presenter = createReplyPresenter({ voice, pushStream: (text) => pushed.push(text) })

    presenter.append('Delayed.')
    await Promise.resolve()
    await presenter.finish()
    expect(pushed).toEqual(['Delayed.'])

    releaseDisplay?.()
    releaseDisplay?.()
    expect(pushed).toEqual(['Delayed.'])
  })

  it('keeps fallback displays in source order when normal voice promises resolve out of order', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('First. Second.')
    controlled.calls[1].resolve()
    await Promise.resolve()
    expect(pushed).toEqual([])

    controlled.calls[0].resolve()
    await presenter.finish()

    expect(pushed).toEqual(['First.', ' Second.'])
  })

  it('blocks delayed callbacks and all later output after cancel', async () => {
    const pushed: string[] = []
    const controlled = createControlledVoice({ settings: settings({ playbackTrigger: 'stream', textSplit: 'sentence' }) })
    const presenter = createReplyPresenter({ voice: controlled.voice, pushStream: (text) => pushed.push(text) })

    presenter.append('Before cancel.')
    presenter.cancel()
    controlled.calls[0].onDisplay()
    controlled.calls[0].resolve()
    presenter.append('After cancel.')
    await presenter.finish()

    expect(pushed).toEqual([])
    expect(controlled.calls).toHaveLength(1)
  })

  it('falls back to one ordered display per segment when speech throws or rejects', async () => {
    const pushed: string[] = []
    let rejectedCallback: (() => void) | undefined
    const speak = vi.fn((text: string, onDisplay: () => void): Promise<void> => {
      if (text === 'First.') throw new Error('synchronous failure')
      rejectedCallback = onDisplay
      return Promise.reject(new Error('asynchronous failure'))
    })
    const voice: VoiceReplyGate = {
      isReady: () => true,
      getSettings: () => settings({ playbackTrigger: 'stream', textSplit: 'sentence' }),
      speak
    }
    const presenter = createReplyPresenter({ voice, pushStream: (text) => pushed.push(text) })

    presenter.append('First. Second.')
    await presenter.finish()
    rejectedCallback?.()

    expect(speak).toHaveBeenCalledTimes(2)
    expect(pushed).toEqual(['First.', ' Second.'])
  })
})
