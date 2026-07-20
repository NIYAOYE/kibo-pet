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

import { createPetSession, type PetSessionDeps } from './petSession'
import { createChatStore } from './chat'
import { startAppFocusWatcher } from '../context/appFocusWatcher'

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
