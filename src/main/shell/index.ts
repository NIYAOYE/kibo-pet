import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, BrowserWindow, type Tray } from 'electron'
import { join, basename } from 'node:path'
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createAutomationControl } from '../automation/automationControl'
import { runVoiceRuntimeInstall } from '../voice/voiceRuntimeInstall'
import { installWithMirrorFallback, type MirrorCandidate } from '../voice/pipMirrorInstall'
import { importVoiceRuntimeArchive, exportVoiceRuntimeArchive, createAdmZipArchiveIO } from '../voice/voiceRuntimeArchive'
import { parseRuntimeMarker, isRuntimeUsable, serializeRuntimeMarker, VOICE_RUNTIME_MARKER_VERSION } from '../voice/runtimeMarker'
import { realSpawnProcess, realSpawnWarmStart, realPostSse, realDownloadEmbeddablePython, realDetectGpu, realPipInstall, realSpawnGenieProcess, realDownloadGenieData } from '../voice/realVoiceTransport'
import { runGenieRuntimeInstall } from '../voice/genieRuntimeInstall'
import { parseGenieRuntimeMarker, isGenieRuntimeUsable, serializeGenieRuntimeMarker, GENIE_RUNTIME_MARKER_VERSION } from '../voice/genieRuntimeMarker'
import { createProvider } from '../providers/createProvider'
import { createScreenshotState } from '../automation/screenshotState'
import { captureFullScreen } from '../media/fullScreenCapture'
import { createDesktopTools } from '../tools/desktopTools'
import { createControlIndicator } from './controlIndicator'
import { createIndicatorGate, wrapToolsWithGate } from '../automation/toolIndicatorGate'
import { createLastAiPosTracker, startManualOverrideWatch } from '../automation/manualOverrideWatch'
import { createBrowserControl } from '../browserAutomation/browserControl'
import { createPlaywrightDriverFactory } from '../browserAutomation/playwrightDriver'
import { createBrowserTools } from '../tools/browserTools'
import {
  IPC,
  type WindowBounds,
  type SettingsSnapshot,
  type TestResult,
  type VoiceRuntimeState,
  type VoiceArchiveResult,
  type GenieRuntimeState,
  type PetChatListItem
} from '@shared/ipc'
import type { PetEvent, Bounds } from '@shared/petBrain'
import type { PetVoice } from '@shared/petPackage'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow, PET_WINDOW_SIZE } from './petWindow'
import { createTray } from './tray'
import { startIdleWatcher } from '../context/idleWatcher'
import { createSettingsWindow } from './settingsWindow'
import { createDialogController } from './dialogWindow'
import { createBubbleController } from './bubbleWindow'
import { createTodoWindow } from './todoWindow'
import { createPetSession, type PetSession, type PetSessionDeps } from './petSession'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'
import { loadSettings, saveSettings, normalizeSettings } from '../config/settings'
import { createSecretStore } from '../config/secrets'
import { testConnection } from '../agent/testConnection'
import { loadSkills } from '../skills/skillLoader'
import { createOpenAiCompatEmbedder, resolveEmbeddingKey, type Embedder } from '../providers/embedder'
import { createTodoStore } from '../todos/todoStore'
import { createScheduler } from '../todos/scheduler'
import { resolvePetHome } from '../pets/resolvePetHome'
import { listPets, importPetFolder } from '../pets/petCatalog'
import { buildPetChatList } from '../pets/petChatList'
import { createPetAvatarCache, resolvePetDir } from '../pets/petAvatar'
import { loadTranscript } from '../memory/transcriptStore'
import { loadLines, pickLine } from '../lines/linesLoader'
import { prepareImage } from '../media/imagePrep'
import { captureRegion } from '../media/screenCapture'
import { DEFAULT_SETTINGS, type TtsBackend } from '@shared/llm'
import type { ChatSendAttachment } from '@shared/ipc'
import type { TodoItem } from '@shared/todo'
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS,
  validateReactionCategory, validateBubbleHeight, validateCollapsedHeight, validatePetId
} from '@shared/ipcValidation'
import { fixedWindowBounds, isZeroMove } from '@shared/windowPlacement'

// Held at module scope so the Tray isn't garbage-collected (which would make
// the tray icon vanish); mirrors MVP-01's module-level tray reference.
let tray: Tray | null = null

/**
 * 全新安装、且用户还没导入任何宠物包时的降级启动路径:既没有打包内置的宠物包
 * (Part 2 起打包不再带真实宠物包),也没有 userData 里已导入的。只拉起托盘 +
 * 设置窗口,引导用户导入宠物包后重启;不建任何依赖宠物家目录的窗口/服务
 * (宠物精灵窗、对话框、气泡、待办、记忆、agent providers、语音、自动化等)。
 * 用户导入宠物包并点"立即重启"后,下次 startShell() 会通过 resolvePetHome 正常
 * 走 'ready' 分支。
 */
function startOnboarding(opts: {
  appRoot: string
  preload: string
  rendererUrl: string | undefined
  dirname: string
  userData: string
  settingsFile: string
  petCatalogDirs: { bundledPetsDir: string; userPetsDir: string }
}): void {
  const { appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs } = opts

  const secrets = createSecretStore(join(userData, 'secrets.bin'), safeStorage)
  const searchSecrets = createSecretStore(join(userData, 'secrets-tavily.bin'), safeStorage)
  const embeddingSecrets = createSecretStore(join(userData, 'secrets-embedding.bin'), safeStorage)
  const firecrawlSecrets = createSecretStore(join(userData, 'secrets-firecrawl.bin'), safeStorage)

  const settings = createSettingsWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/settings.html` : undefined,
    settingsHtml: join(dirname, '../renderer/settings.html')
  })

  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey(),
    noPetInstalled: listPets(petCatalogDirs).length === 0,
    activePetVoice: undefined
  }))
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => {
    saveSettings(settingsFile, normalizeSettings(raw))
    // 注:正常启动路径下的 SET_SETTINGS 还会在关闭 browserControl.enabled 时调用
    // browserControl.close() —— 这个模式下 browserControl 压根没建过(没有宠物就
    // 没有任何自动化功能可用),不存在"正在运行、需要关掉"的场景,故省略。
  })
  ipcMain.handle(IPC.SET_API_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : secrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_SEARCH_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : searchSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_EMBEDDING_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : embeddingSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_FIRECRAWL_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : firecrawlSecrets.setKey(key)
  })
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, raw): Promise<TestResult> => {
    const arg = validateTestConnectionArg(raw)
    if (!arg) return { ok: false, error: 'invalid request' }
    return testConnection(arg.provider, arg.key)
  })
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
  ipcMain.on(IPC.RELAUNCH_APP, () => { app.relaunch(); app.quit() })
  ipcMain.on(IPC.OPEN_SETTINGS, () => settings.open())

  tray = createTray(join(appRoot, 'resources/tray.png'), {
    onSettings: () => settings.open(),
    onQuickAction: () => settings.open(),
    onTodos: () => settings.open()
  })

  settings.open()
}

export type VoiceBackendChoice = 'gsv-tts-lite' | 'genie-tts'

/** 按用户在设置里选的后端 + 当前宠物包实际提供的模型文件,解出这次要用哪个后端。
 *  选中的后端如果宠物包没提供对应模型文件,返回 null(不可用)——不会退回另一个后端,
 *  这是设计文档明确要求的行为,不是遗漏。
 *  纯函数,独立导出以便单测覆盖这个 PetSession.startVoice() 里最高风险的分支决策。 */
export function resolveVoiceBackend(petVoice: PetVoice, selected: TtsBackend): VoiceBackendChoice | null {
  if (selected === 'genie-tts') return petVoice.onnxModel ? 'genie-tts' : null
  return (petVoice.gptModel && petVoice.sovitsModel) ? 'gsv-tts-lite' : null
}

export function startShell(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url)) // resolves to out/main/ at runtime (electron-vite bundles shell into out/main/index.js)
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const petHtml = join(dirname, '../renderer/index.html')
  const dialogHtml = join(dirname, '../renderer/dialog.html')
  const bubbleHtml = join(dirname, '../renderer/bubble.html')
  const overlayHtml = join(dirname, '../renderer/regionOverlay.html')
  const overlayUrl = rendererUrl ? `${rendererUrl}/regionOverlay.html` : undefined
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }
  // MVP-05 的旧全局 userData/memory 是在默认宠物 luluka 下攒的,只在"激活的就是默认宠物"时
  // 一次性迁入,避免把 luluka 的记忆错误搬进另一只宠物的文件夹(spec §3.3:仅对默认宠物迁移)。
  const legacyMemoryDir = join(userData, 'memory')
  const configuredPetId = loadSettings(settingsFile).activePetId
  const defaultPetId = DEFAULT_SETTINGS.activePetId
  // 换宠物是"改 settings.json 的 activePetId 后重启"的既定流程,拼错/残留一个未随包分发的
  // id、或(自 Part 2 起)全新安装还没导入过任何宠物包,都会让 resolvePetHome 报 onboarding
  // 而不是抛错——此时不继续往下建正常的宠物精灵窗等重家伙,转去引导导入。
  // 注:resolvePetHome 只检查"配置的 id"和"默认 id"这两个特定 id,不像 startOnboarding 里
  // GET_SETTINGS 的 noPetInstalled(靠 listPets 扫描 userData/pets 下所有包)那样看"是否存在
  // 任意可用宠物包"。两者判定口径不同,可能出现"resolvePetHome 判定 onboarding,但
  // noPetInstalled 为 false(因为磁盘上还留着一个无关的、之前导入过的宠物包)"这种边界情况——
  // 属于可接受的降级(用户在"宠物"页选中它、保存、重启即可正常进入),不是 bug。
  const resolved = resolvePetHome({
    userDataDir: userData,
    bundledPetsDir: petCatalogDirs.bundledPetsDir,
    configuredPetId,
    defaultPetId,
    legacyMemoryDir
  })
  if (resolved.mode === 'onboarding') {
    startOnboarding({ appRoot, preload, rendererUrl, dirname, userData, settingsFile, petCatalogDirs })
    return
  }
  // resolvePetHome 可能因 configuredPetId 无对应包而回退到 defaultPetId,故真正落地的宠物
  // 未必是 configuredPetId;从解析出的家目录路径取 basename 得到"实际生效的 petId",传给
  // createPetSession(其内部会再跑一次幂等的 ensurePetHome,已存在则不重复复制/迁移)。
  const effectivePetId = basename(resolved.petHome.petHome)
  const secrets = createSecretStore(join(userData, 'secrets.bin'), safeStorage)
  const searchSecrets = createSecretStore(join(userData, 'secrets-tavily.bin'), safeStorage)
  const embeddingSecrets = createSecretStore(join(userData, 'secrets-embedding.bin'), safeStorage)
  const firecrawlSecrets = createSecretStore(join(userData, 'secrets-firecrawl.bin'), safeStorage)

  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })
  const idleWatcher = startIdleWatcher(petWin)

  const bubble = createBubbleController({
    preload,
    url: rendererUrl ? `${rendererUrl}/bubble.html` : undefined,
    bubbleHtml
  })
  let dialogCollapsed = true   // 镜像对话框折叠态,决定气泡显隐
  let bubbleHasContent = false // 本轮是否已有可显示的回复/状态

  const AMBIENT_TTL_MS = 3500
  let ambientHideTimer: NodeJS.Timeout | null = null
  let lastLineText: string | null = null // 供 pickLine 避免连续复读
  let pendingAppFocusText: string | null = null // appFocusWatcher 已选好的台词,PET_SPEAK('app_focus') 特判读取

  function clearAmbientLine(): void {
    if (ambientHideTimer) { clearTimeout(ambientHideTimer); ambientHideTimer = null }
  }
  function showAmbientLine(text: string): void {
    if (dialog.isOpen()) return // 对话框开着:气泡让位给聊天(planner 已抑制,这里再兜一道)
    clearAmbientLine()
    bubble.clear()
    bubble.pushLine(text)
    bubble.show(petBoundsFull(), petWorkArea())
    ambientHideTimer = setTimeout(() => { ambientHideTimer = null; bubble.hide() }, AMBIENT_TTL_MS)
  }

  function petBoundsFull(): Bounds {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    return { x, y, width, height }
  }
  function petWorkArea(): Bounds {
    const b = petBoundsFull()
    return screen.getDisplayMatching(b).workArea
  }
  function refreshBubble(): void {
    if (dialog.isOpen() && dialogCollapsed && bubbleHasContent) bubble.show(petBoundsFull(), petWorkArea())
    else bubble.hide()
  }

  function emitPetEvent(event: PetEvent): void {
    petWin.webContents.send(IPC.PET_EVENT, event)
    // 送出瞬间保证界面干净:清掉本轮气泡内容并隐藏,待首个流式/状态到达再显示
    if (event === 'messageSent') { clearAmbientLine(); bubbleHasContent = false; bubble.clear(); bubble.hide() }
  }

  const dialog = createDialogController({
    preload,
    url: rendererUrl ? `${rendererUrl}/dialog.html` : undefined,
    dialogHtml,
    onOpened: () => {
      clearAmbientLine()
      emitPetEvent('dialogOpen')
      dialog.pushUpdate(session.messages())
      refreshBubble() // 折叠态打开:此刻无本轮内容 → 保持隐藏(界面干净)
    },
    onClosed: () => {
      emitPetEvent('dialogClose')
      bubbleHasContent = false
      bubble.clear()
      bubble.hide()
    }
  })

  // 产品运行时技能:仓库根 skills/(打包后随 resources 分发,MVP-06 处理拷贝)
  const skills = loadSkills(join(appRoot, 'skills'))

  const settings = createSettingsWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/settings.html` : undefined,
    settingsHtml: join(dirname, '../renderer/settings.html')
  })

  // embedding 按当前设置即时构建(设置可变);未配置返回 null → 召回退化
  function getEmbedder(): Embedder | null {
    const s = loadSettings(settingsFile)
    const emb = s.memory.embedding
    if (!emb) return null
    return createOpenAiCompatEmbedder({
      baseURL: emb.baseURL,
      model: emb.model,
      getKey: () => resolveEmbeddingKey(s, embeddingSecrets.getKey(), secrets.getKey())
    })
  }
  // 待办是用户的、非宠物皮肤的数据——全局存储,换宠物(petHome 会变)也不能丢/分叉待办
  const todoStore = createTodoStore({ file: join(userData, 'todos.json') })

  const execFileP = promisify(execFileCb)
  const automationControl = createAutomationControl({
    // windowsHide:true 是防御性加固:Electron 主进程是 GUI 子系统、没有自己的控制台,
    // spawn 一个控制台子系统程序(powershell.exe)理论上可能被 Windows 弹出一个可见的
    // 控制台窗口、抢到前台焦点。真机诊断这次没有观察到这个现象(GetConsoleWindow 返回
    // null,前台窗口全程未变),但保留这个选项零成本、能防住其他 Windows 版本/配置下的
    // 潜在同类问题,不依赖"这次没测出来"就假设它不会发生。
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr }))
  })

  const browserControl = createBrowserControl({
    driverFactory: createPlaywrightDriverFactory(),
    getSettings: () => loadSettings(settingsFile).browserControl
    // CDP 端口固定用默认值(9222),与设置 UI 上给用户的操作指引一致;不做成可配置项(YAGNI)
  })

  // createControlIndicator bakes the display name into the window's HTML at construction
  // time, so it must not be built until the real name is known — a placeholder assigned
  // by-value here would never propagate into the already-created window. Deferred to the
  // loadPet(...).then() callback; show()/hide() below no-op safely if called before it resolves.
  // controlIndicator 保持全局单例(不进 PetSession):它被 indicatorGate 的 show/hide 闭包引用,
  // 挪进会话会牵连 indicatorGate 的重建。实际构造推迟到下方 session 建好后 loadPet(session.petDir)
  // 的回调里(需要真实宠物名);show()/hide() 在其解析前调用会安全 no-op。已知小瑕疵:换宠物后
  // 指示器显示名停留在初始宠物名——桌面控制默认关闭,优先级低,不在本计划范围内修。
  let controlIndicator: ReturnType<typeof createControlIndicator> | null = null

  const lastAiPos = createLastAiPosTracker()
  let manualOverrideWatch: ReturnType<typeof startManualOverrideWatch> | null = null
  const indicatorGate = createIndicatorGate(
    () => {
      // show 现在只在"一整轮多步任务"里第一次实际调用桌面工具时触发一次(见 toolIndicatorGate
      // 的 beginTurn/endTurn),而不是每个工具调用都触发——所以这里清空的是上一轮已经结束的
      // 残留 lastAiPos,不会清掉同一轮内正在进行中的自动化状态。若不清空,上一轮的旧点击坐标会
      // 被 manualOverrideWatch 拿来跟本轮真实光标比对,用户在两轮之间正常移动鼠标就会被误判为
      // "人工接管",提前 cancel() 本轮尚未开始点击的自动化(fail-safe 但会打断用户)。
      lastAiPos.clear()
      controlIndicator?.show()
      manualOverrideWatch = startManualOverrideWatch({
        getCursorPos: () => {
          const p = screen.getCursorScreenPoint()
          const d = screen.getDisplayNearestPoint(p)
          return { x: Math.round(p.x * d.scaleFactor), y: Math.round(p.y * d.scaleFactor) }
        },
        getLastAiPos: () => lastAiPos.get(),
        onOverride: () => { session.chat.cancel() }
      })
    },
    () => {
      controlIndicator?.hide()
      manualOverrideWatch?.stop()
      manualOverrideWatch = null
    }
  )

  const automationWithTracking = {
    ...automationControl,
    click: async (input: Parameters<typeof automationControl.click>[0]) => {
      lastAiPos.set({ x: input.x, y: input.y })
      return automationControl.click(input)
    }
  }

  // ---- 语音(GSV-TTS-Lite)----
  const VOICE_PORT = 8850
  const voiceScriptPath = join(appRoot, 'resources/voice/gsv_server.py')
  const voiceMarkerFile = (installPath: string): string => join(installPath, 'voice-runtime-marker.json')
  const voicePythonExe = (installPath: string): string => join(installPath, 'python.exe')
  // gsv_tts 基础预训练模型缓存放在安装目录下(而非其默认的全局 ~/.cache/gsv):
  // 1) 随运行时目录一起被导出/导入压缩包打包,做到"一个 zip 开箱即用";
  // 2) 独占、可安全清空重试,不会和用户机器上其它 CPU/GPU 变体的下载互相踩踏。
  const voiceModelsDir = (installPath: string): string => join(installPath, 'models')
  const PYPI_MIRROR_TUNA = 'https://pypi.tuna.tsinghua.edu.cn/simple'
  const PYTORCH_CUDA_MIRROR_ALIYUN = 'https://mirrors.aliyun.com/pytorch-wheels/cu128/'
  const PYTORCH_CUDA_OFFICIAL = 'https://download.pytorch.org/whl/cu128'

  function getVoiceRuntimeState(): VoiceRuntimeState {
    const s = loadSettings(settingsFile)
    const installPath = s.tts.runtimeInstallPath
    if (!installPath || !existsSync(voiceMarkerFile(installPath))) return { installed: false, installPath }
    const marker = parseRuntimeMarker(readFileSync(voiceMarkerFile(installPath), 'utf-8'))
    if (!isRuntimeUsable(marker)) return { installed: false, installPath }
    return { installed: true, installPath, gsvTtsLiteVersion: marker!.gsvTtsLiteVersion, device: marker!.device }
  }

  // ---- 语音(Genie-TTS,第二后端)----
  const GENIE_VOICE_PORT = 8851
  const genieScriptPath = join(appRoot, 'resources/voice/genie_server.py')
  const genieMarkerFile = (installPath: string): string => join(installPath, 'genie-runtime-marker.json')
  const geniePythonExe = (installPath: string): string => join(installPath, 'python.exe')

  function getGenieRuntimeState(): GenieRuntimeState {
    const s = loadSettings(settingsFile)
    const installPath = s.ttsGenie.runtimeInstallPath
    if (!installPath || !existsSync(genieMarkerFile(installPath))) return { installed: false, installPath }
    const marker = parseGenieRuntimeMarker(readFileSync(genieMarkerFile(installPath), 'utf-8'))
    if (!isGenieRuntimeUsable(marker)) return { installed: false, installPath }
    return { installed: true, installPath, genieTtsVersion: marker!.genieTtsVersion }
  }

  // 宠物作用域件(memory/chat/appFocus/voice)全部收进 PetSession 工厂,以便后续任务
  // (Task 7)不重启即可重建这一捆绑来热切换宠物。跨会话共享的全局件(indicatorGate、
  // browserControl、todoStore、secrets 门面、渲染层推送等)在此处建一次,以回调/取值器注入。
  const sessionDeps: PetSessionDeps = {
    userData,
    bundledPetsDir: petCatalogDirs.bundledPetsDir,
    legacyMemoryDir,
    defaultPetId,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    getSearchKey: () => searchSecrets.getKey(),
    getFirecrawlKey: () => firecrawlSecrets.getKey(),
    getEmbedder,
    skills,
    todoStore,
    petWin,
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    createProvider,
    buildDesktopTools: () => createDesktopTools({
      platform: process.platform,
      automation: automationWithTracking,
      screenshotState: createScreenshotState(), // 每次 handleSend 都是全新一个 —— 每轮对话自然重置
      captureScreen: () => captureFullScreen(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    }),
    wrapDesktopTools: (tools) => wrapToolsWithGate(tools, indicatorGate),
    beginDesktopControlTurn: () => indicatorGate.beginTurn(),
    endDesktopControlTurn: (token) => indicatorGate.endTurn(token),
    buildBrowserTools: () => createBrowserTools({ control: browserControl }),
    prepareImages: (atts) => atts.map((a) => prepareImage(a)),
    clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs),
    pushStream: (t) => {
      dialog.window()?.webContents.send(IPC.CHAT_STREAM, t)
      bubbleHasContent = true; refreshBubble(); bubble.pushStream(t)
    },
    pushStatus: (t) => {
      dialog.window()?.webContents.send(IPC.CHAT_STATUS, t)
      bubbleHasContent = true; refreshBubble(); bubble.pushStatus(t)
    },
    pushDone: () => {
      dialog.window()?.webContents.send(IPC.CHAT_DONE)
      bubble.pushDone()
    },
    pushError: (m) => {
      dialog.window()?.webContents.send(IPC.CHAT_ERROR, m)
      bubbleHasContent = true; refreshBubble(); bubble.pushError(m)
    },
    openSettings: () => openSettings(),
    onAppFocusMatch: (lineText) => {
      if (dialog.isOpen()) return // 对话框开着不触发,与 showAmbientLine 的兜底一致
      pendingAppFocusText = lineText
      petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')
    },
    voiceDeps: {
      getVoiceRuntimeState,
      getGenieRuntimeState,
      resolveVoiceBackend,
      ports: { gsv: VOICE_PORT, genie: GENIE_VOICE_PORT },
      scriptPaths: { gsv: voiceScriptPath, genie: genieScriptPath },
      spawnGsv: realSpawnProcess,
      spawnGenie: realSpawnGenieProcess,
      postSse: realPostSse,
      onAudioChunk: (c) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
      onAudioError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
    }
  }

  let session = createPetSession(effectivePetId, sessionDeps)
  session.startVoice()

  const petAvatarCache = createPetAvatarCache()

  ipcMain.handle(IPC.CHAT_LIST_PETS, async (): Promise<PetChatListItem[]> => {
    const pets = listPets(petCatalogDirs)
    return buildPetChatList({
      pets,
      activeId: session.petId,
      activeMessages: session.messages(),
      peekLast: (petId) => {
        const dir = resolvePetDir(petId, petCatalogDirs)
        const t = loadTranscript(join(dir, 'memory', 'transcript.json'))
        return t.messages[t.messages.length - 1]
      },
      avatarOf: (petId) => petAvatarCache.avatarOf(resolvePetDir(petId, petCatalogDirs), petId)
    })
  })

  async function switchPet(petId: string): Promise<boolean> {
    if (petId === session.petId) return false
    if (!listPets(petCatalogDirs).some((p) => p.id === petId)) {
      dialog.window()?.webContents.send(IPC.CHAT_ERROR, '找不到这只宠物')
      return false
    }
    // 先建后弃:新会话构建成功才 dispose 旧的,失败则旧会话原封不动
    let next: PetSession
    try {
      next = createPetSession(petId, sessionDeps)
    } catch (e) {
      console.warn('[switchPet] 新会话构建失败,保留当前宠物', e)
      dialog.window()?.webContents.send(IPC.CHAT_ERROR, '切换失败,已保留当前宠物')
      return false
    }
    await session.dispose()          // 停旧语音(释放端口)、停 appFocus、取消在途
    session = next
    session.startVoice()             // 端口已释放,启新宠物语音(未配置则静默不启)
    saveSettings(settingsFile, { ...loadSettings(settingsFile), activePetId: petId })
    petWin.webContents.send(IPC.PET_CHANGED)     // 渲染层重载精灵
    dialog.pushUpdate(session.messages())        // 右栏历史热切换
    const loaded = await loadPet(session.petDir).catch(() => null)
    dialog.window()?.webContents.send(IPC.PET_SWITCHED, {
      petId, displayName: loaded?.manifest.displayName ?? petId
    })
    // 清跨宠物残留气泡
    clearAmbientLine(); bubbleHasContent = false; bubble.clear(); bubble.hide()
    return true
  }

  ipcMain.handle(IPC.SWITCH_PET, async (_e, raw): Promise<boolean> => {
    const id = validatePetId(raw)
    if (!id) return false
    return switchPet(id)
  })

  // controlIndicator 现在读 session.petDir(与旧 petDir 等价);仍是上面声明的全局单例。
  void loadPet(session.petDir)
    .then((p) => { controlIndicator = createControlIndicator(p.manifest.displayName) })
    .catch(() => { controlIndicator = createControlIndicator('宠物') })

  const todoPanelHtml = join(dirname, '../renderer/todoPanel.html')
  const todoWin = createTodoWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/todoPanel.html` : undefined,
    todoHtml: todoPanelHtml
  })

  // 到点三件套:系统通知 + 宠物 greet + 气泡 + 自动弹面板高亮
  function fireReminder(item: TodoItem): void {
    if (Notification.isSupported()) new Notification({ title: '⏰ 提醒', body: item.title }).show()
    emitPetEvent('remind')
    // 对话框若是刚刚才新建的窗口,渲染进程的监听器还没注册好,直接 send 会被静默丢弃;
    // 只有"本来就已打开"才能立即发送,否则要等 did-finish-load 之后再发
    const wasOpen = dialog.isOpen()
    if (!wasOpen) dialog.toggle(petBounds)
    const win = dialog.window()
    const sendStatus = (): void => { win?.webContents.send(IPC.CHAT_STATUS, `⏰ 提醒:${item.title}`) }
    if (wasOpen) sendStatus()
    else win?.webContents.once('did-finish-load', sendStatus)
    todoWin.open()
    todoWin.pushFired(item.id)
  }
  function catchupReminders(items: TodoItem[]): void {
    const title = items.length > 1 ? `⏰ ${items.length} 条提醒已过期` : '⏰ 提醒'
    const body = items.length > 1 ? items.map((i) => i.title).join('、') : items[0].title
    if (Notification.isSupported()) new Notification({ title, body }).show()
    emitPetEvent('remind')
    todoWin.open()
    todoWin.pushFired(items[0].id)
  }

  const scheduler = createScheduler({
    store: todoStore,
    now: () => Date.now(),
    onFire: fireReminder,
    onCatchup: catchupReminders
  })

  // store 变更(工具/面板/到点)→ 推面板刷新(scheduler 已自行订阅重算)
  todoStore.onChange(() => todoWin.pushUpdate(todoStore.list()))

  function openSettings(): void { settings.open() }

  function petBounds(): { x: number; y: number; width: number } {
    const [x, y] = petWin.getPosition()
    const [width] = petWin.getSize()
    return { x, y, width }
  }
  function toggleDialog(): void { dialog.toggle(petBounds) }

  // Manual drag anchors to a cursor position read from Electron's `screen`
  // module (the same coordinate space as petWin's own position), instead of
  // the renderer's MouseEvent.screenX/Y (Chromium's coordinate space). On a
  // scaled/mixed-DPI multi-monitor setup those two spaces can disagree by a
  // small amount per event; trusting the renderer's deltas compounds that
  // mismatch linearly over the length of the drag (pet drifts from the
  // cursor, further the longer you drag). Re-deriving the delta from a
  // single fixed anchor each move eliminates the compounding.
  let dragAnchor: { cursorX: number; cursorY: number; winX: number; winY: number } | null = null
  // Autonomous walk's precise (unrounded) intended position. Seeded from
  // petWin.getPosition() once, then advanced purely by adding each tick's
  // delta in JS float math — never re-derived from a fresh getPosition()
  // read. On this window (transparent/frameless/always-on-top/non-resizable,
  // under fractional display scaling) getPosition() was observed to echo the
  // PREVIOUS tick's position ~85% of the time when moving in the +X
  // direction (0% moving -X) — a real async read-back lag, not a rounding
  // artifact. Recomputing "start + dx" from that lagged read every tick
  // wastes most rightward ticks re-requesting a target already in flight;
  // accumulating independently of the read-back sidesteps the lag entirely.
  // Invalidated (forces a fresh reseed) whenever a drag takes over the
  // window's position, since that moves it outside this accumulator's view.
  let walkPreciseX: number | null = null
  let walkPreciseY: number | null = null
  ipcMain.on(IPC.DRAG_START, () => {
    const [winX, winY] = petWin.getPosition()
    const { x: cursorX, y: cursorY } = screen.getCursorScreenPoint()
    dragAnchor = { cursorX, cursorY, winX, winY }
    walkPreciseX = null
    walkPreciseY = null
  })
  ipcMain.on(IPC.DRAG_END, () => {
    dragAnchor = null
    walkPreciseX = null
    walkPreciseY = null
  })

  ipcMain.handle(IPC.GET_PET, async () => loadPet(session.petDir))
  ipcMain.handle(IPC.GET_WINDOW_BOUNDS, async (): Promise<WindowBounds> => {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    const workArea = screen.getDisplayMatching({ x, y, width, height }).workArea
    return { workArea, window: { x, y, width, height } }
  })
  ipcMain.handle(IPC.MOVE_WINDOW, (_e, raw): WindowBounds | undefined => {
    const delta = validateMoveDelta(raw)
    if (!delta) return undefined
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    if (isZeroMove(delta)) {
      const workArea = screen.getDisplayMatching({ x, y, width, height }).workArea
      return { workArea, window: { x, y, width, height } }
    }
    const nx = Math.round(x + delta.dx)
    const ny = Math.round(y + delta.dy)
    let finalX: number
    let finalY: number
    let workArea: Bounds
    if (delta.clamp) {
      // Autonomous walk: advance a persistent float accumulator (never
      // re-derived from getPosition(), see comment above walkPreciseX) and
      // hard-limit it to the current display's work area, so the pet never
      // wanders off-screen. Manual drags are intentionally NOT clamped (free
      // movement, matching MVP-01) — clamping them felt "magnetized".
      if (walkPreciseX === null || walkPreciseY === null) { walkPreciseX = x; walkPreciseY = y }
      walkPreciseX += delta.dx
      walkPreciseY += delta.dy
      const roundedX = Math.round(walkPreciseX)
      const roundedY = Math.round(walkPreciseY)
      ;({ workArea } = screen.getDisplayMatching({
        x: roundedX,
        y: roundedY,
        width: PET_WINDOW_SIZE.width,
        height: PET_WINDOW_SIZE.height
      }))
      finalX = Math.max(workArea.x, Math.min(roundedX, workArea.x + workArea.width - PET_WINDOW_SIZE.width))
      finalY = Math.max(workArea.y, Math.min(roundedY, workArea.y + workArea.height - PET_WINDOW_SIZE.height))
      // Keep the accumulator in sync with any clamping so it can't run past the edge.
      walkPreciseX = finalX
      walkPreciseY = finalY
    } else if (dragAnchor) {
      // Free drag: ignore the renderer-computed dx/dy and re-derive the delta
      // from the same anchor, in `screen`-module coordinates throughout.
      const cursor = screen.getCursorScreenPoint()
      finalX = Math.round(dragAnchor.winX + (cursor.x - dragAnchor.cursorX))
      finalY = Math.round(dragAnchor.winY + (cursor.y - dragAnchor.cursorY))
      workArea = screen.getDisplayMatching({ x: finalX, y: finalY, width: PET_WINDOW_SIZE.width, height: PET_WINDOW_SIZE.height }).workArea
    } else {
      // Fallback if DRAG_START wasn't received for some reason — never let a
      // drag silently stop tracking the cursor.
      finalX = nx
      finalY = ny
      workArea = screen.getDisplayMatching({ x: nx, y: ny, width: PET_WINDOW_SIZE.width, height: PET_WINDOW_SIZE.height }).workArea
    }
    petWin.setBounds(fixedWindowBounds(finalX, finalY, PET_WINDOW_SIZE))
    if (bubble.isVisible()) bubble.reposition(petBoundsFull(), petWorkArea())
    return { workArea, window: { x: finalX, y: finalY, width: PET_WINDOW_SIZE.width, height: PET_WINDOW_SIZE.height } }
  })
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, raw) => {
    const ignore = validateBool(raw)
    if (ignore === null) return
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.TOGGLE_DIALOG, () => toggleDialog())
  ipcMain.on(IPC.CHAT_SEND, (_e, raw) => {
    const payload = validateChatSend(raw)
    if (!payload) return
    session.chat.handleSend(payload)
  })
  ipcMain.on(IPC.CANCEL_CHAT, () => {
    session.chat.cancel()
    petWin.webContents.send(IPC.VOICE_PLAYBACK_STOP)
  })
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = category === 'app_focus'
      ? (pendingAppFocusText ? { text: pendingAppFocusText } : null)
      : pickLine(loadLines(session.petDir), category, lastLineText ?? undefined)
    if (category === 'app_focus') pendingAppFocusText = null
    if (!line) return // lines.json 缺失/该 category 为空/app_focus 无暂存台词 → 静默降级
    lastLineText = line.text
    showAmbientLine(line.text)
  })
  ipcMain.on(IPC.BUBBLE_RESIZE, (_e, raw) => {
    const height = validateBubbleHeight(raw)
    if (height === null) return
    bubble.resize(height, petBoundsFull(), petWorkArea())
  })

  function mimeFromPath(p: string): string {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
    return 'image/jpeg'
  }

  ipcMain.handle(IPC.MEDIA_PICK_IMAGE, async (): Promise<ChatSendAttachment[]> => {
    const r = await electronDialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (r.canceled) return []
    const out: ChatSendAttachment[] = []
    for (const p of r.filePaths.slice(0, MAX_ATTACHMENTS)) {
      try {
        const prepped = prepareImage({ mimeType: mimeFromPath(p), dataBase64: readFileSync(p).toString('base64') })
        out.push({ kind: 'image', mimeType: prepped.mimeType, dataBase64: prepped.dataBase64 })
      } catch (e) {
        console.warn('[media] 读取/预处理图片失败', p, e)
      }
    }
    return out
  })

  ipcMain.handle(IPC.MEDIA_CAPTURE_REGION, async (): Promise<ChatSendAttachment | null> => {
    const [x, y] = petWin.getPosition()
    const [w, h] = petWin.getSize()
    const display = screen.getDisplayMatching({ x, y, width: w, height: h })
    return captureRegion({ preload, overlayHtml, overlayUrl, display })
  })

  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettings())
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => {
    let activePetVoice: PetVoice | undefined
    try {
      activePetVoice = (await loadPet(session.petDir)).manifest.voice
    } catch {
      activePetVoice = undefined
    }
    return {
      settings: loadSettings(settingsFile),
      hasKey: secrets.hasKey(),
      hasSearchKey: searchSecrets.hasKey(),
      hasEmbeddingKey: embeddingSecrets.hasKey(),
      hasFirecrawlKey: firecrawlSecrets.hasKey(),
      noPetInstalled: false, // 走到这个 handler 说明 startShell 已经解析出一个可用宠物家目录
      activePetVoice
    }
  })
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => {
    const prev = loadSettings(settingsFile)
    const next = normalizeSettings(raw)
    saveSettings(settingsFile, next)
    if (prev.browserControl.enabled && !next.browserControl.enabled) void browserControl.close()
  })
  ipcMain.handle(IPC.SET_API_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : secrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_SEARCH_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : searchSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_EMBEDDING_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : embeddingSecrets.setKey(key)
  })
  ipcMain.handle(IPC.SET_FIRECRAWL_KEY, async (_e, raw): Promise<boolean> => {
    const key = validateKey(raw); return key === null ? false : firecrawlSecrets.setKey(key)
  })
  ipcMain.handle(IPC.CONFIRM_DESKTOP_CONTROL, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '确认开启'],
      defaultId: 0,
      cancelId: 0,
      title: '开启桌面控制风险提示',
      message: '开启后,AI 可以在对话中自主截屏(屏幕内容会发送给你配置的模型服务商)、控制鼠标点击与键盘输入。',
      detail: '可能造成误操作或截取到敏感信息;开启后随时可在设置里再次关闭。'
    }
    const result = parent ? await electronDialog.showMessageBox(parent, options) : await electronDialog.showMessageBox(options)
    return result.response === 1
  })
  ipcMain.handle(IPC.CONFIRM_BROWSER_CONTROL, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '确认开启'],
      defaultId: 0,
      cancelId: 0,
      title: '开启浏览器自动化风险提示',
      message: '开启后,AI 可以在对话中自主打开独立浏览器窗口浏览/操作网页(点击、填表、翻页)。',
      detail: '默认使用隔离的临时浏览器环境,不会用到你日常浏览器的登录状态;开启后随时可在设置里再次关闭。'
    }
    const result = parent ? await electronDialog.showMessageBox(parent, options) : await electronDialog.showMessageBox(options)
    return result.response === 1
  })
  ipcMain.handle(IPC.CONFIRM_CDP_MODE, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '确认切换'],
      defaultId: 0,
      cancelId: 0,
      title: '切换到「接管真实浏览器」风险提示',
      message: '这个模式会操作你已登录的真实浏览器账号与会话,风险高于默认的隔离浏览器模式。',
      detail: '需要目标浏览器已用调试参数启动;确认前请确保你了解这一模式的操作对象是你的真实浏览器。'
    }
    const result = parent ? await electronDialog.showMessageBox(parent, options) : await electronDialog.showMessageBox(options)
    return result.response === 1
  })
  ipcMain.on(IPC.OPEN_MEMORY_DIR, () => {
    mkdirSync(session.memoryDir, { recursive: true })
    void electronShell.openPath(session.memoryDir)
  })
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, raw): Promise<TestResult> => {
    const arg = validateTestConnectionArg(raw)
    if (!arg) return { ok: false, error: 'invalid request' }
    return testConnection(arg.provider, arg.key)
  })
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
  ipcMain.on(IPC.RELAUNCH_APP, () => { app.relaunch(); app.quit() })

  ipcMain.handle(IPC.VOICE_GET_STATE, async () => getVoiceRuntimeState())

  ipcMain.handle(IPC.VOICE_PICK_INSTALL_PATH, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  ipcMain.on(IPC.VOICE_START_INSTALL, () => {
    const s = loadSettings(settingsFile)
    const destDir = s.tts.runtimeInstallPath
    if (!destDir) { petWin.webContents.send(IPC.VOICE_INSTALL_PROGRESS, { stage: 'done', message: '请先选择安装位置' }); return }
    const win = settings.window()
    void runVoiceRuntimeInstall({
      destDir,
      device: s.tts.device,
      steps: {
        downloadEmbeddablePython: (dir) => realDownloadEmbeddablePython(dir, 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'),
        enablePip: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
            { indexUrl: undefined, label: '官方源', fastFail: false }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['--upgrade', 'pip'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        detectGpu: realDetectGpu,
        installTorch: async (dir, useCuda, onProgress) => {
          const candidates: MirrorCandidate[] = useCuda
            ? [
                { indexUrl: PYTORCH_CUDA_MIRROR_ALIYUN, label: '阿里云镜像', fastFail: true },
                { indexUrl: PYTORCH_CUDA_OFFICIAL, label: '官方源', fastFail: false }
              ]
            : [
                { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
                { indexUrl: undefined, label: '官方源', fastFail: false }
              ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['torch', 'torchvision', 'torchaudio'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        installGsvTtsLite: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
            { indexUrl: undefined, label: '官方源', fastFail: false }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['gsv-tts-lite'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        warmStartModels: async (dir) => {
          // 先清空模型缓存目录再重新触发下载:gsv_tts 自己"目录已存在就跳过下载"的检查
          // 不区分 CPU/GPU 变体、也不清理下载中途失败的残留,不清空的话失败重试会永远卡在
          // 同一个报错——这里保证每次 warm-start 都是真正从头下载,不是断点续传。
          const modelsDir = voiceModelsDir(dir)
          rmSync(modelsDir, { recursive: true, force: true })
          mkdirSync(modelsDir, { recursive: true })
          const probe = realSpawnWarmStart({
            pythonExe: voicePythonExe(dir),
            scriptPath: voiceScriptPath,
            device: s.tts.device,
            useFlashAttn: false,
            modelsDir
          })
          try { await probe.waitReady() } finally { probe.kill() }
        }
      },
      onProgress: (p) => { win?.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p); petWin.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p) }
    }).then((r) => {
      if (r.ok) {
        mkdirSync(destDir, { recursive: true })
        writeFileSync(voiceMarkerFile(destDir), serializeRuntimeMarker({ markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: s.tts.device === 'cpu' ? 'cpu' : 'cuda' }))
      } else {
        const p = { stage: r.stage, message: `安装失败:${r.error}` }
        win?.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p)
        petWin.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p)
      }
    })
  })

  ipcMain.handle(IPC.VOICE_IMPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.tts.runtimeInstallPath) return { ok: false, error: '请先选择安装位置' }
    const r = await electronDialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: '已取消' }
    return importVoiceRuntimeArchive({ zipPath: r.filePaths[0], destDir: s.tts.runtimeInstallPath, io: createAdmZipArchiveIO() })
  })

  ipcMain.handle(IPC.VOICE_EXPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.tts.runtimeInstallPath) return { ok: false, error: '尚未安装,无法导出' }
    const r = await electronDialog.showSaveDialog({ defaultPath: 'voice-runtime.zip', filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' }
    return exportVoiceRuntimeArchive({ srcDir: s.tts.runtimeInstallPath, zipPath: r.filePath, io: createAdmZipArchiveIO() })
  })

  ipcMain.handle(IPC.GENIE_GET_STATE, async () => getGenieRuntimeState())

  ipcMain.handle(IPC.GENIE_PICK_INSTALL_PATH, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.on(IPC.GENIE_START_INSTALL, () => {
    const s = loadSettings(settingsFile)
    const destDir = s.ttsGenie.runtimeInstallPath
    if (!destDir) { petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, { stage: 'done', message: '请先选择安装位置' }); return }
    const win = settings.window()
    void runGenieRuntimeInstall({
      destDir,
      steps: {
        downloadEmbeddablePython: (dir) => realDownloadEmbeddablePython(dir, 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'),
        enablePip: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
            { indexUrl: undefined, label: '官方源', fastFail: false }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['--upgrade', 'pip'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        installGenieTts: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
            { indexUrl: undefined, label: '官方源', fastFail: false }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['genie-tts==2.0.2'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        downloadGenieData: async (dir, onProgress) => {
          await realDownloadGenieData({ pythonExe: geniePythonExe(dir), scriptPath: genieScriptPath, installDir: dir, onProgress })
        }
      },
      onProgress: (p) => { win?.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p); petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p) }
    }).then((r) => {
      if (r.ok) {
        mkdirSync(destDir, { recursive: true })
        writeFileSync(genieMarkerFile(destDir), serializeGenieRuntimeMarker({ markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }))
      } else {
        const p = { stage: r.stage, message: `安装失败:${r.error}` }
        win?.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p)
        petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p)
      }
    })
  })

  ipcMain.handle(IPC.GENIE_IMPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.ttsGenie.runtimeInstallPath) return { ok: false, error: '请先选择安装位置' }
    const r = await electronDialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: '已取消' }
    return importVoiceRuntimeArchive({ zipPath: r.filePaths[0], destDir: s.ttsGenie.runtimeInstallPath, io: createAdmZipArchiveIO() })
  })

  ipcMain.handle(IPC.GENIE_EXPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.ttsGenie.runtimeInstallPath) return { ok: false, error: '尚未安装,无法导出' }
    const r = await electronDialog.showSaveDialog({ defaultPath: 'genie-voice-runtime.zip', filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' }
    return exportVoiceRuntimeArchive({ srcDir: s.ttsGenie.runtimeInstallPath, zipPath: r.filePath, io: createAdmZipArchiveIO() })
  })

  ipcMain.on(IPC.VOICE_STOP, () => session.stopSpeech())
  ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, raw) => {
    const collapsed = validateBool(raw)
    if (collapsed === null) return
    dialog.setSize(collapsed)
    dialogCollapsed = collapsed
    refreshBubble() // 展开→隐藏气泡(回复走对话框 history);折叠→有内容则显示
  })
  ipcMain.on(IPC.DIALOG_REPORT_COLLAPSED_HEIGHT, (_e, raw) => {
    const h = validateCollapsedHeight(raw)
    if (h === null) return
    dialog.setCollapsedHeight(h)
  })
  ipcMain.on(IPC.QUIT, () => app.quit())

  ipcMain.handle(IPC.LIST_TODOS, async () => todoStore.list())
  ipcMain.handle(IPC.ADD_TODO, async (_e, raw) => {
    const input = validateTodoAdd(raw)
    if (input) todoStore.add(input)
    return todoStore.list()
  })
  ipcMain.handle(IPC.TOGGLE_TODO, async (_e, raw) => {
    const id = validateTodoId(raw)
    if (id) todoStore.toggleDone(id)
    return todoStore.list()
  })
  ipcMain.handle(IPC.REMOVE_TODO, async (_e, raw) => {
    const id = validateTodoId(raw)
    if (id) todoStore.remove(id)
    return todoStore.list()
  })
  ipcMain.on(IPC.OPEN_TODO_PANEL, () => todoWin.open())

  registerHotkeys(toggleDialog)
  tray = createTray(join(appRoot, 'resources/tray.png'), {
    onSettings: openSettings,
    onQuickAction: (id) => {
      if (!dialog.isOpen()) dialog.toggle(petBounds) // 没开先弹出,用户才看得到流式结果
      session.chat.runQuickAction(id)
    },
    onTodos: () => todoWin.open()
  })

  scheduler.start()

  if (!secrets.hasKey()) openSettings()

  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close(); void session.dispose() })
}
