import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type {
  ChatMessage,
  ChatSendAttachment,
  VoiceRuntimeState,
  GenieRuntimeState,
  VoicePcmChunk
} from '@shared/ipc'
import type { AppSettings, ImagePart, ProviderSettings, TtsBackend } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import type { PetVoice } from '@shared/petPackage'
import { ensurePetHome } from '../pets/petHome'
import { createMemoryManager, type MemoryManager } from '../memory/memoryManager'
import { createChatStore, type ChatStore } from './chat'
import { startAppFocusWatcher } from '../context/appFocusWatcher'
import { loadPersona } from '../persona/personaLoader'
import { generateContextualLine } from '../context/contextualLineGenerator'
import { loadPet } from '../petLoader'
import { createVoiceSidecar } from '../voice/voiceSidecar'
import { createVoiceProvider } from '../voice/voiceProvider'
import { createSpeechSequencer } from '../voice/speechSequencer'
import { createLlmTranslator } from '../voice/translate'
import type { Embedder } from '../providers/embedder'
import type { LlmProvider } from '../providers/llmProvider'
import type { SkillIndex } from '../skills/skillLoader'
import type { TodoStore } from '../todos/todoStore'
import type { ToolSpec } from '../tools/toolSpec'

/** 语音会话依赖:sidecar 端口、脚本路径、真实进程/传输实现、运行时状态查询、音频回推。
 *  这些都不随宠物皮肤变化(端口固定、脚本随打包分发、运行时是设置/安装作用域),由
 *  startShell 建一次后注入每个会话;`resolveVoiceBackend` 是纯函数,同样从 startShell 传入。 */
export interface VoiceSessionDeps {
  getVoiceRuntimeState: () => VoiceRuntimeState
  getGenieRuntimeState: () => GenieRuntimeState
  resolveVoiceBackend: (petVoice: PetVoice, selected: TtsBackend) => 'gsv-tts-lite' | 'genie-tts' | null
  ports: { gsv: number; genie: number }
  scriptPaths: { gsv: string; genie: string }
  spawnGsv: typeof import('../voice/realVoiceTransport').realSpawnProcess
  spawnGenie: typeof import('../voice/realVoiceTransport').realSpawnGenieProcess
  postSse: typeof import('../voice/realVoiceTransport').realPostSse
  onAudioChunk: (c: VoicePcmChunk) => void
  onAudioError: (m: string) => void
}

/** 一个宠物会话所需的全部依赖。宠物作用域件(memory/chat/appFocus/voice)由 `createPetSession`
 *  构造并持有;跨会话共享的全局件(自动化门、浏览器控制、待办、secrets 门面、渲染层推送等)
 *  由 startShell 建一次、以回调/取值器的形式注入,保证换宠物时它们不被重建。 */
export interface PetSessionDeps {
  userData: string
  bundledPetsDir: string
  legacyMemoryDir: string
  defaultPetId: string
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  getFirecrawlKey: () => string | null
  getEmbedder: () => Embedder | null
  skills: SkillIndex
  todoStore: TodoStore
  petWin: BrowserWindow
  // appFocusWatcher(PowerShell 前台窗口检测)专用的 execFile 门面
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
  createProvider: (p: ProviderSettings, key: string) => LlmProvider
  // 全局自动化件(跨会话共享,由 startShell 建一次)
  buildDesktopTools: () => ToolSpec[]
  wrapDesktopTools: (tools: ToolSpec[]) => ToolSpec[]
  beginDesktopControlTurn: () => number
  endDesktopControlTurn: (token: number) => void
  buildBrowserTools: () => ToolSpec[]
  prepareImages: (a: ChatSendAttachment[]) => ImagePart[]
  clipboard: { readText: () => string; writeText: (t: string) => void }
  // 渲染层推送回调(startShell 里已有的那几个)
  emitPetEvent: (e: PetEvent) => void
  pushUpdate: (m: ChatMessage[]) => void
  pushStream: (t: string) => void
  pushStatus: (t: string) => void
  pushDone: () => void
  pushError: (m: string) => void
  openSettings: () => void
  // appFocus 情境信号推送(命中时)
  onAppFocusMatch: (lineText: string) => void
  // 语音接线所需
  voiceDeps: VoiceSessionDeps
}

/** 一个"活跃宠物"的可重建捆绑:家目录 + 记忆 + 聊天 + appFocus 监听 + 语音 sidecar。
 *  换宠物时:先 `dispose()` 旧会话(停 appFocus、停语音释放端口、取消在途聊天),再
 *  `createPetSession(...)` 建新会话、`startVoice()` 起新 sidecar。startVoice 与构造分离,
 *  正是为了让调用方(Task 7)显式保证"旧 sidecar 端口已释放"再起新的。 */
export interface PetSession {
  petId: string
  petDir: string
  memoryDir: string
  memory: MemoryManager
  chat: ChatStore
  messages(): ChatMessage[]
  startVoice(): void
  /** 仅停止主进程侧的语音朗读序列(不取消在途 LLM);服务 IPC.VOICE_STOP。
   *  brief 的 Step 4 调用点枚举漏了这个 handler(它原本直接引用现已搬进会话的
   *  speechSequencerInstance),补一个最小方法把它接回来,行为与原 handler 一致。 */
  stopSpeech(): void
  dispose(): Promise<void>
}

export function createPetSession(petId: string, deps: PetSessionDeps): PetSession {
  const { petHome, memoryDir } = ensurePetHome({
    userDataDir: deps.userData,
    bundledPetsDir: deps.bundledPetsDir,
    activePetId: petId,
    // 旧全局 memory 只在默认宠物首次落地时迁移(与 resolvePetHome 口径一致)
    legacyMemoryDir: petId === deps.defaultPetId ? deps.legacyMemoryDir : undefined
  })
  const petDir = petHome

  const memory = createMemoryManager({ dir: memoryDir, getEmbedder: deps.getEmbedder })

  // 语音会话成员:实例延迟到 startVoice() 才建;makeVoiceFacade / stopVoice 在调用时读这三个 let。
  let voiceProviderInstance: ReturnType<typeof createVoiceProvider> | null = null
  let speechSequencerInstance: ReturnType<typeof createSpeechSequencer> | null = null
  let voiceSidecarInstance: ReturnType<typeof createVoiceSidecar> | null = null

  function makeVoiceFacade(): { getSettings: () => AppSettings['tts']; speak: (text: string) => void; stop: () => void } {
    return {
      getSettings: () => deps.loadSettings().tts,
      speak: (text: string) => speechSequencerInstance?.speak(text),
      stop: () => speechSequencerInstance?.stop()
    }
  }

  function createProviderForVoice(): LlmProvider {
    const s = deps.loadSettings()
    const key = deps.getKey()
    return deps.createProvider(s.provider, key ?? '')
  }

  async function startVoice(): Promise<void> {
    const s = deps.loadSettings()
    if (!s.tts.enabled) return
    let petVoice: PetVoice | undefined
    try {
      petVoice = (await loadPet(petDir)).manifest.voice
    } catch {
      return
    }
    if (!petVoice) return

    const backend = deps.voiceDeps.resolveVoiceBackend(petVoice, s.tts.backend)
    if (backend === null) {
      console.warn(`[voice] 当前宠物不提供 ${s.tts.backend === 'genie-tts' ? 'Genie-TTS' : 'GSV-TTS-Lite'} 需要的模型文件,本次运行语音功能不可用`)
      return
    }
    let sidecar: ReturnType<typeof createVoiceSidecar>

    if (backend === 'genie-tts') {
      const state = deps.voiceDeps.getGenieRuntimeState()
      if (!state.installed) {
        console.warn('[voice] 该宠物需要 Genie-TTS 运行时,请到设置安装;本次运行语音功能不可用')
        return
      }
      sidecar = createVoiceSidecar({
        port: deps.voiceDeps.ports.genie,
        spawnProcess: () => deps.voiceDeps.spawnGenie({
          pythonExe: join(state.installPath, 'python.exe'),
          scriptPath: deps.voiceDeps.scriptPaths.genie,
          port: deps.voiceDeps.ports.genie,
          voice: {
            onnxModel: join(petDir, petVoice!.onnxModel!),
            refAudio: join(petDir, petVoice!.refAudio),
            refText: join(petDir, petVoice!.refText),
            language: petVoice!.language!
          },
          installDir: state.installPath
        }),
        postSse: deps.voiceDeps.postSse
      })
    } else {
      const state = deps.voiceDeps.getVoiceRuntimeState()
      if (!state.installed) return
      sidecar = createVoiceSidecar({
        port: deps.voiceDeps.ports.gsv,
        spawnProcess: () => deps.voiceDeps.spawnGsv({
          pythonExe: join(state.installPath, 'python.exe'),
          scriptPath: deps.voiceDeps.scriptPaths.gsv,
          port: deps.voiceDeps.ports.gsv,
          voice: {
            gptModel: join(petDir, petVoice!.gptModel!),
            sovitsModel: join(petDir, petVoice!.sovitsModel!),
            refAudio: join(petDir, petVoice!.refAudio),
            refText: join(petDir, petVoice!.refText)
          },
          device: s.tts.device,
          useFlashAttn: s.tts.useFlashAttn,
          modelsDir: join(state.installPath, 'models')
        }),
        postSse: deps.voiceDeps.postSse
      })
    }

    // 换宠物快速切换时,旧会话 stop() 是同步 kill、不等 OS 真正释放端口(见 voiceSidecar.ts),
    // 新会话紧跟着起同一端口的 sidecar 可能撞上"端口尚未释放"的瞬时失败——重试几次通常几百毫秒内自愈,
    // 而不是直接判定语音不可用。重试耗尽后仍走原有的 catch-and-warn-and-return 兜底,不改变外部可见行为。
    const START_ATTEMPTS = 3
    const START_RETRY_DELAY_MS = 250
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      try {
        await sidecar.start()
        break
      } catch (e) {
        if (attempt === START_ATTEMPTS) {
          console.warn(`[voice] sidecar 启动失败(已重试 ${START_ATTEMPTS} 次),本次运行语音功能不可用`, e)
          return
        }
        console.warn(`[voice] sidecar 启动失败,第 ${attempt}/${START_ATTEMPTS} 次尝试,${START_RETRY_DELAY_MS}ms 后重试`, e)
        await new Promise((resolve) => setTimeout(resolve, START_RETRY_DELAY_MS))
      }
    }
    voiceSidecarInstance = sidecar

    const translatorProvider = createProviderForVoice()
    voiceProviderInstance = createVoiceProvider({
      sidecar,
      translator: createLlmTranslator(translatorProvider),
      getSettings: () => deps.loadSettings().tts,
      onError: (m) => deps.voiceDeps.onAudioError(m)
    })
    const vp = voiceProviderInstance
    speechSequencerInstance = createSpeechSequencer({
      speakOne: (text, onChunk) => vp.speak(text, onChunk),
      onChunk: (c) => deps.voiceDeps.onAudioChunk(c),
      getSettings: () => deps.loadSettings().tts,
      stopUnderlying: () => vp.stop()
    })
  }

  async function stopVoice(): Promise<void> {
    speechSequencerInstance?.stop()
    await voiceSidecarInstance?.stop()
    voiceSidecarInstance = null
    speechSequencerInstance = null
    voiceProviderInstance = null
  }

  const chat = createChatStore({
    petDir,
    skills: deps.skills,
    memory,
    todoStore: deps.todoStore,
    loadSettings: deps.loadSettings,
    getKey: deps.getKey,
    getSearchKey: deps.getSearchKey,
    getFirecrawlKey: deps.getFirecrawlKey,
    buildDesktopTools: deps.buildDesktopTools,
    wrapDesktopTools: deps.wrapDesktopTools,
    beginDesktopControlTurn: deps.beginDesktopControlTurn,
    endDesktopControlTurn: deps.endDesktopControlTurn,
    buildBrowserTools: deps.buildBrowserTools,
    prepareImages: deps.prepareImages,
    clipboard: deps.clipboard,
    emitPetEvent: deps.emitPetEvent,
    pushUpdate: deps.pushUpdate,
    pushStream: deps.pushStream,
    pushStatus: deps.pushStatus,
    pushDone: deps.pushDone,
    pushError: deps.pushError,
    openSettings: deps.openSettings,
    voice: makeVoiceFacade()
  })

  const appFocusWatcher = startAppFocusWatcher(petDir, {
    execFile: deps.execFile,
    onMatch: (line) => deps.onAppFocusMatch(line.text),
    generateOpener: async ({ processName, windowTitle }) => {
      const s = deps.loadSettings()
      if (!s.appFocusLlmOpener.enabled) return null
      const key = deps.getKey()
      if (!key) return null
      const persona = loadPersona(petDir)
      const provider = deps.createProvider(s.provider, key)
      return generateContextualLine({ personaText: persona.persona, processName, windowTitle, provider })
    }
  })

  return {
    petId,
    petDir,
    memoryDir,
    memory,
    chat,
    messages: () => memory.messages(),
    startVoice,
    stopSpeech: () => speechSequencerInstance?.stop(),
    async dispose(): Promise<void> {
      try { chat.cancel() } catch (e) { console.warn('[petSession] chat.cancel', e) }
      try { appFocusWatcher.stop() } catch (e) { console.warn('[petSession] appFocus.stop', e) }
      try { await stopVoice() } catch (e) { console.warn('[petSession] stopVoice', e) }
    }
  }
}
