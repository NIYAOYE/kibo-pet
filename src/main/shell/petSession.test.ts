import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/llm'
import { createFakeProvider } from '../providers/fakeProvider'
import { realSpawnProcess, realSpawnGenieProcess, realPostSse } from '../voice/realVoiceTransport'
import type { TodoStore } from '../todos/todoStore'

// createPetSession() 内部构造 memory/chat/appFocusWatcher/petHome 时都会跑真实文件 I/O 或
// 依赖真实宠物包(见 petSession.ts 顶部 import),对着一个假 petId 直接跑会因为找不到真实
// 宠物目录而抛错。dispose() 本身只关心"三个子步骤各跑一次、互相隔离"的控制流,与这些模块
// 的真实实现无关,所以把它们整体 mock 掉,换成可控的假实现/spy。
vi.mock('../pets/petHome', () => ({
  ensurePetHome: vi.fn(() => ({ petHome: '/fake/pet', memoryDir: '/fake/pet/memory' }))
}))

vi.mock('../memory/memoryManager', () => ({
  createMemoryManager: vi.fn(() => ({
    messages: () => [],
    appendMessage: () => {},
    saveFact: () => ({ text: '', deduped: false }),
    recall: async () => ({ facts: [] }),
    maybeSummarize: () => {}
  }))
}))

vi.mock('./chat', () => ({
  createChatStore: vi.fn()
}))

vi.mock('../context/appFocusWatcher', () => ({
  startAppFocusWatcher: vi.fn()
}))

vi.mock('../petLoader', () => ({
  loadPet: vi.fn()
}))

vi.mock('../voice/voiceSidecar', () => ({
  createVoiceSidecar: vi.fn()
}))

vi.mock('../voice/voiceProvider', () => ({
  createVoiceProvider: vi.fn()
}))

vi.mock('../voice/speechSequencer', () => ({
  createSpeechSequencer: vi.fn()
}))

import { createPetSession, type PetSessionDeps } from './petSession'
import { createChatStore } from './chat'
import { startAppFocusWatcher } from '../context/appFocusWatcher'
import { loadPet } from '../petLoader'
import { createVoiceSidecar } from '../voice/voiceSidecar'
import { createVoiceProvider } from '../voice/voiceProvider'
import { createSpeechSequencer } from '../voice/speechSequencer'
import type { VoiceReplyGate } from './replyPresenter'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function makeDeps(): PetSessionDeps {
  return {
    userData: '/fake/userData',
    bundledPetsDir: '/fake/bundled',
    legacyMemoryDir: '/fake/legacy-memory',
    defaultPetId: 'fake-pet-id',
    loadSettings: () => DEFAULT_SETTINGS,
    getKey: () => null,
    getSearchKey: () => null,
    getFirecrawlKey: () => null,
    getEmbedder: () => null,
    skills: { list: () => [], body: () => null },
    todoStore: {
      list: () => [],
      add: (i) => ({ id: 'x', title: i.title, createdAt: 0, dueAt: i.dueAt, done: false, doneAt: null, firedAt: null }),
      toggleDone: () => null,
      remove: () => false,
      markFired: () => {},
      onChange: () => () => {}
    } as TodoStore,
    petWin: {} as BrowserWindow,
    execFile: async () => ({ stdout: '', stderr: '' }),
    createProvider: () => createFakeProvider(),
    buildDesktopTools: () => [],
    wrapDesktopTools: (tools) => tools,
    beginDesktopControlTurn: () => 0,
    endDesktopControlTurn: () => {},
    buildBrowserTools: () => [],
    prepareImages: () => [],
    clipboard: { readText: () => '', writeText: () => {} },
    emitPetEvent: () => {},
    pushUpdate: () => {},
    pushStream: () => {},
    pushStatus: () => {},
    pushDone: () => {},
    pushError: () => {},
    openSettings: () => {},
    onAppFocusMatch: () => {},
    voiceDeps: {
      getVoiceRuntimeState: () => ({ installed: false, installPath: '' }),
      getGenieRuntimeState: () => ({ installed: false, installPath: '' }),
      resolveVoiceBackend: () => null,
      ports: { gsv: 8850, genie: 8851 },
      scriptPaths: { gsv: '', genie: '' },
      spawnGsv: realSpawnProcess,
      spawnGenie: realSpawnGenieProcess,
      postSse: realPostSse,
      onAudioChunk: () => {},
      onAudioError: () => {}
    },
    kiboPetRegistry: {
      registerToken: () => 'fake-token',
      revokeToken: () => {}
    }
  }
}

describe('createPetSession().dispose()', () => {
  let cancelSpy: ReturnType<typeof vi.fn>
  let stopSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    cancelSpy = vi.fn()
    stopSpy = vi.fn()
    vi.mocked(createChatStore).mockReturnValue({
      messages: () => [],
      handleSend: vi.fn(),
      runQuickAction: vi.fn(),
      cancel: cancelSpy
    })
    vi.mocked(startAppFocusWatcher).mockReturnValue({ stop: stopSpy })
  })

  it('调用一次 dispose() 会各调用 chat.cancel() 和 appFocusWatcher.stop() 一次', async () => {
    const session = createPetSession('fake-pet-id', makeDeps())
    await session.dispose()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('chat.cancel() 抛错时,dispose() 仍会调用 appFocusWatcher.stop() 且自身不抛错(子步骤隔离)', async () => {
    cancelSpy.mockImplementation(() => { throw new Error('boom') })
    const session = createPetSession('fake-pet-id', makeDeps())
    await expect(session.dispose()).resolves.toBeUndefined()
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('连续调用两次 dispose() 两次都不抛错(幂等)', async () => {
    const session = createPetSession('fake-pet-id', makeDeps())
    await expect(session.dispose()).resolves.toBeUndefined()
    await expect(session.dispose()).resolves.toBeUndefined()
    expect(cancelSpy).toHaveBeenCalledTimes(2)
    expect(stopSpy).toHaveBeenCalledTimes(2)
  })
})

describe('createPetSession() 的 kibo-pet:// token 生命周期', () => {
  it('构造时铸造 token,dispose() 时撤销', async () => {
    const registerToken = vi.fn(() => 'minted-token-123')
    const revokeToken = vi.fn()
    const deps = { ...makeDeps(), kiboPetRegistry: { registerToken, revokeToken } }
    const session = createPetSession('fake-pet-id', deps)

    expect(registerToken).toHaveBeenCalledTimes(1)
    expect(registerToken).toHaveBeenCalledWith('/fake/pet')
    expect(session.resourceToken).toBe('minted-token-123')

    await session.dispose()
    expect(revokeToken).toHaveBeenCalledWith('minted-token-123')
  })
})

describe('createPetSession() voice facade', () => {
  function facade(): VoiceReplyGate {
    const config = vi.mocked(createChatStore).mock.calls.at(-1)?.[0]
    return config?.voice as unknown as VoiceReplyGate
  }

  function enabledDeps(): PetSessionDeps {
    return {
      ...makeDeps(),
      loadSettings: () => ({ ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, enabled: true } }),
      voiceDeps: {
        ...makeDeps().voiceDeps,
        getVoiceRuntimeState: () => ({ installed: true, installPath: '/fake/runtime' }),
        resolveVoiceBackend: () => 'gsv-tts-lite'
      }
    }
  }

  beforeEach(() => {
    vi.mocked(createChatStore).mockReturnValue({ cancel: vi.fn() } as never)
    vi.mocked(startAppFocusWatcher).mockReturnValue({ stop: vi.fn() })
    vi.mocked(loadPet).mockReset()
    vi.mocked(createVoiceSidecar).mockReset()
    vi.mocked(createVoiceProvider).mockReset()
    vi.mocked(createSpeechSequencer).mockReset()
  })

  it('reports unavailable while TTS is disabled or the pet has no matching voice model', async () => {
    const disabled = createPetSession('fake-pet-id', makeDeps())
    expect(facade().isReady()).toBe(false)

    const noModel = createPetSession('fake-pet-id', enabledDeps())
    await (noModel.startVoice as () => Promise<void>)()
    expect(facade().isReady()).toBe(false)
    expect(vi.mocked(createSpeechSequencer)).not.toHaveBeenCalled()

    await disabled.dispose()
    await noModel.dispose()
  })

  it('becomes ready only after sequencer construction and wires synthesis instead of legacy speak', async () => {
    const synthesize = vi.fn(async () => 'spoken' as const)
    const legacySpeak = vi.fn(async () => {})
    const sequencer = { speak: vi.fn(async () => {}), stop: vi.fn() }
    vi.mocked(loadPet).mockResolvedValue({
      manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
    } as never)
    vi.mocked(createVoiceSidecar).mockReturnValue({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as never)
    vi.mocked(createVoiceProvider).mockReturnValue({ synthesize, speak: legacySpeak, stop: vi.fn() } as never)
    vi.mocked(createSpeechSequencer).mockReturnValue(sequencer as never)

    const session = createPetSession('fake-pet-id', enabledDeps())
    expect(facade().isReady()).toBe(false)
    await (session.startVoice as () => Promise<void>)()

    expect(facade().isReady()).toBe(true)
    const sequenceConfig = vi.mocked(createSpeechSequencer).mock.calls[0]?.[0]
    await sequenceConfig?.speakOne('Hello.', () => {})
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(legacySpeak).not.toHaveBeenCalled()
  })

  it('stays unavailable when its sidecar exhausts startup retries', async () => {
    vi.mocked(loadPet).mockResolvedValue({
      manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
    } as never)
    vi.mocked(createVoiceSidecar).mockReturnValue({ start: vi.fn(async () => { throw new Error('port busy') }), stop: vi.fn(async () => {}) } as never)

    const session = createPetSession('fake-pet-id', enabledDeps())
    await (session.startVoice as () => Promise<void>)()

    expect(facade().isReady()).toBe(false)
    expect(vi.mocked(createVoiceProvider)).not.toHaveBeenCalled()
    expect(vi.mocked(createSpeechSequencer)).not.toHaveBeenCalled()
  })

  it('does not create voice resources when a delayed pet load resolves after dispose', async () => {
    const loading = deferred<unknown>()
    vi.mocked(loadPet).mockReturnValue(loading.promise as never)

    const session = createPetSession('fake-pet-id', enabledDeps())
    const starting = (session.startVoice as () => Promise<void>)()
    await Promise.resolve()
    await session.dispose()
    loading.resolve({
      manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
    })
    await starting

    expect(facade().isReady()).toBe(false)
    expect(vi.mocked(createVoiceSidecar)).not.toHaveBeenCalled()
    expect(vi.mocked(createVoiceProvider)).not.toHaveBeenCalled()
    expect(vi.mocked(createSpeechSequencer)).not.toHaveBeenCalled()
  })

  it('stops a still-starting sidecar immediately on dispose before a new session starts', async () => {
    const firstReady = deferred<void>()
    const firstSidecar = {
      start: vi.fn(() => firstReady.promise),
      stop: vi.fn()
    }
    const secondSidecar = {
      start: vi.fn(async () => {}),
      stop: vi.fn()
    }
    vi.mocked(loadPet).mockResolvedValue({
      manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
    } as never)
    vi.mocked(createVoiceSidecar)
      .mockImplementationOnce(() => firstSidecar as never)
      .mockImplementationOnce(() => secondSidecar as never)
    vi.mocked(createVoiceProvider).mockReturnValue({ synthesize: vi.fn(), stop: vi.fn() } as never)
    vi.mocked(createSpeechSequencer).mockReturnValue({ speak: vi.fn(), stop: vi.fn() } as never)

    const firstSession = createPetSession('first-pet', enabledDeps())
    const firstStart = (firstSession.startVoice as () => Promise<void>)()
    await vi.waitFor(() => expect(firstSidecar.start).toHaveBeenCalledTimes(1))
    await firstSession.dispose()

    expect(firstSidecar.stop).toHaveBeenCalledTimes(1)

    const secondSession = createPetSession('second-pet', enabledDeps())
    const secondStart = (secondSession.startVoice as () => Promise<void>)()
    await vi.waitFor(() => expect(secondSidecar.start).toHaveBeenCalledTimes(1))

    firstReady.resolve()
    await firstStart
    await secondStart
    expect(firstSidecar.stop).toHaveBeenCalledTimes(1)
    await secondSession.dispose()
  })

  it('stops a sidecar whose delayed start resolves after dispose without installing voice', async () => {
    const startingSidecar = deferred<void>()
    const sidecar = {
      start: vi.fn(() => startingSidecar.promise),
      stop: vi.fn(async () => {})
    }
    vi.mocked(loadPet).mockResolvedValue({
      manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
    } as never)
    vi.mocked(createVoiceSidecar).mockReturnValue(sidecar as never)

    const session = createPetSession('fake-pet-id', enabledDeps())
    const starting = (session.startVoice as () => Promise<void>)()
    await vi.waitFor(() => expect(sidecar.start).toHaveBeenCalledTimes(1))
    await session.dispose()
    startingSidecar.resolve()
    await starting

    expect(sidecar.stop).toHaveBeenCalledTimes(1)
    expect(facade().isReady()).toBe(false)
    expect(vi.mocked(createVoiceProvider)).not.toHaveBeenCalled()
    expect(vi.mocked(createSpeechSequencer)).not.toHaveBeenCalled()
  })
})
