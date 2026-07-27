import { afterEach, describe, expect, it } from 'vitest'
import { createPcmPlayer, type PcmPlayer } from './pcmPlayer'

class FakeAudioBufferSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null

  connect(): void {}
  start(): void {}
  stop(): void {}
  end(): void { this.onended?.() }
}

class FakeAudioContext {
  currentTime = 0
  destination = {} as AudioDestinationNode
  readonly sources: FakeAudioBufferSource[] = []

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      duration: length / sampleRate,
      copyToChannel: () => {}
    } as unknown as AudioBuffer
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioBufferSource()
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

const originalAudioContext = globalThis.AudioContext

afterEach(() => {
  globalThis.AudioContext = originalAudioContext
})

function float32Base64(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer)
  return btoa(String.fromCharCode(...bytes))
}

function createFakePlayer(onPlaybackIdle: (epoch: number) => void): {
  player: PcmPlayer
  sources: FakeAudioBufferSource[]
} {
  const context = new FakeAudioContext()
  globalThis.AudioContext = class { constructor() { return context } } as unknown as typeof AudioContext
  return { player: createPcmPlayer({ onPlaybackIdle }), sources: context.sources }
}

describe('createPcmPlayer', () => {
  it('reports only the final epoch after every queued source ends', () => {
    const idleEpochs: number[] = []
    const { player, sources } = createFakePlayer((epoch) => idleEpochs.push(epoch))

    player.play(float32Base64([0, 0]), 24000, 41)
    player.play(float32Base64([0, 0]), 24000, 42)

    sources[0].end()
    expect(idleEpochs).toEqual([])
    sources[1].end()
    expect(idleEpochs).toEqual([42])
  })

  it('does not report idle when stop cancels queued sources', () => {
    const idleEpochs: number[] = []
    const { player, sources } = createFakePlayer((epoch) => idleEpochs.push(epoch))

    player.play(float32Base64([0, 0]), 24000, 7)
    player.stop()
    sources[0].end()

    expect(idleEpochs).toEqual([])
  })

  it('ignores a stopped source ending after a replacement epoch is queued', () => {
    const idleEpochs: number[] = []
    const { player, sources } = createFakePlayer((epoch) => idleEpochs.push(epoch))

    player.play(float32Base64([0, 0]), 24000, 7)
    player.stop()
    player.play(float32Base64([0, 0]), 24000, 8)
    sources[0].end()
    expect(idleEpochs).toEqual([])
    sources[1].end()

    expect(idleEpochs).toEqual([8])
  })
})
