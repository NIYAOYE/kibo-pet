import { describe, expect, it } from 'vitest'
import { createChatHideAfterVoiceGate } from './chatHideAfterVoice'

describe('createChatHideAfterVoiceGate', () => {
  it('allows a text-only reply to start its hide delay immediately', () => {
    const gate = createChatHideAfterVoiceGate()

    expect(gate.noteReplyDone()).toBe(true)
  })

  it('waits for the latest audio epoch after the reply is done', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(4)
    gate.noteAudioChunk(5)

    expect(gate.noteReplyDone()).toBe(false)
    expect(gate.notePlaybackIdle(4)).toBe(false)
    expect(gate.notePlaybackIdle(5)).toBe(false)
    expect(gate.noteAudioProductionDone()).toBe(true)
  })

  it('does not let an old epoch complete a newer reply', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(20)

    expect(gate.noteReplyDone()).toBe(false)
    expect(gate.notePlaybackIdle(19)).toBe(false)
    expect(gate.notePlaybackIdle(20)).toBe(false)
    expect(gate.noteAudioProductionDone()).toBe(true)
  })

  it('requires a later chunk after an earlier idle report', () => {
    const gate = createChatHideAfterVoiceGate()
    expect(gate.noteReplyDone()).toBe(true)
    gate.noteAudioChunk(51)

    expect(gate.notePlaybackIdle(50)).toBe(false)
    expect(gate.notePlaybackIdle(51)).toBe(false)
    expect(gate.noteAudioProductionDone()).toBe(true)
  })

  it('forgets cancelled work so a new text-only reply is not delayed', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(30)
    gate.reset()

    expect(gate.notePlaybackIdle(30)).toBe(false)
    expect(gate.noteReplyDone()).toBe(true)
  })

  it('ignores stale reports after reset before a newer voiced reply', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(30)
    gate.reset(30)
    gate.noteAudioChunk(30)

    expect(gate.noteReplyDone()).toBe(true)

    gate.reset(30)

    expect(gate.notePlaybackIdle(30)).toBe(false)
    gate.noteAudioChunk(31)
    expect(gate.noteReplyDone()).toBe(false)
    expect(gate.notePlaybackIdle(31)).toBe(false)
    expect(gate.noteAudioProductionDone()).toBe(true)
  })

  it('does not schedule when PCM drains before production is complete', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(7)

    expect(gate.noteReplyDone()).toBe(false)
    expect(gate.notePlaybackIdle(7)).toBe(false)
  })

  it('schedules once production completes after the renderer is already idle', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(7)
    gate.noteReplyDone()
    gate.notePlaybackIdle(7)

    expect(gate.noteAudioProductionDone()).toBe(true)
  })

  it('resets production completion and preserves the epoch watermark', () => {
    const gate = createChatHideAfterVoiceGate()
    gate.noteAudioChunk(30)
    gate.noteReplyDone()
    gate.notePlaybackIdle(30)
    gate.noteAudioProductionDone()
    gate.reset(30)

    expect(gate.notePlaybackIdle(30)).toBe(false)
    gate.noteAudioChunk(31)
    expect(gate.noteReplyDone()).toBe(false)
    expect(gate.notePlaybackIdle(31)).toBe(false)
    expect(gate.noteAudioProductionDone()).toBe(true)
  })
})
