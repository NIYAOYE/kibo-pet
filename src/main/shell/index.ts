import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, type Tray } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  IPC,
  type WindowBounds,
  type SettingsSnapshot,
  type TestResult
} from '@shared/ipc'
import type { PetEvent } from '@shared/petBrain'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow } from './petWindow'
import { createTray } from './tray'
import { createSettingsWindow } from './settingsWindow'
import { createDialogController } from './dialogWindow'
import { createTodoWindow } from './todoWindow'
import { createChatStore } from './chat'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'
import { loadSettings, saveSettings, normalizeSettings } from '../config/settings'
import { createSecretStore } from '../config/secrets'
import { testConnection } from '../agent/testConnection'
import { loadSkills } from '../skills/skillLoader'
import { createMemoryManager } from '../memory/memoryManager'
import { createOpenAiCompatEmbedder, resolveEmbeddingKey, type Embedder } from '../providers/embedder'
import { createTodoStore } from '../todos/todoStore'
import { createScheduler } from '../todos/scheduler'
import { ensurePetHome, type PetHomeResult } from '../pets/petHome'
import { listPets, importPetFolder } from '../pets/petCatalog'
import { prepareImage } from '../media/imagePrep'
import { captureRegion } from '../media/screenCapture'
import { DEFAULT_SETTINGS } from '@shared/llm'
import type { ChatSendAttachment } from '@shared/ipc'
import type { TodoItem } from '@shared/todo'
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS
} from '@shared/ipcValidation'

// Held at module scope so the Tray isn't garbage-collected (which would make
// the tray icon vanish); mirrors MVP-01's module-level tray reference.
let tray: Tray | null = null

export function startShell(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url)) // resolves to out/main/ at runtime (electron-vite bundles shell into out/main/index.js)
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const petHtml = join(dirname, '../renderer/index.html')
  const dialogHtml = join(dirname, '../renderer/dialog.html')
  const overlayHtml = join(dirname, '../renderer/regionOverlay.html')
  const overlayUrl = rendererUrl ? `${rendererUrl}/regionOverlay.html` : undefined
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  // 换宠物是"改 settings.json 的 activePetId 后重启"的既定流程,拼错/残留一个未随包分发的
  // id 会让 ensurePetHome 抛错;若不兜底,startShell 的异常会变成无窗口的静默启动失败。故:
  // 配置的宠物包缺失时回退到默认宠物(default 自身仍缺失才真正抛错)。
  const petHomeOpts = { userDataDir: userData, bundledPetsDir: petsDir(appRoot) }
  // MVP-05 的旧全局 userData/memory 是在默认宠物 luluka 下攒的,只在"激活的就是默认宠物"时
  // 一次性迁入,避免把 luluka 的记忆错误搬进另一只宠物的文件夹(spec §3.3:仅对默认宠物迁移)。
  const legacyMemoryDir = join(userData, 'memory')
  const configuredPetId = loadSettings(settingsFile).activePetId
  const defaultPetId = DEFAULT_SETTINGS.activePetId
  let petHomeResult: PetHomeResult
  try {
    petHomeResult = ensurePetHome({
      ...petHomeOpts,
      activePetId: configuredPetId,
      legacyMemoryDir: configuredPetId === defaultPetId ? legacyMemoryDir : undefined
    })
  } catch (err) {
    if (configuredPetId === defaultPetId) throw err
    console.warn(`[pet] activePetId "${configuredPetId}" 无对应宠物包,回退默认 "${defaultPetId}"`, err)
    // 回退到默认宠物 → 此时迁移旧全局记忆(luluka 的)是正确的
    petHomeResult = ensurePetHome({ ...petHomeOpts, activePetId: defaultPetId, legacyMemoryDir })
  }
  const { petHome, memoryDir } = petHomeResult
  const petDir = petHome
  const secrets = createSecretStore(join(userData, 'secrets.bin'), safeStorage)
  const searchSecrets = createSecretStore(join(userData, 'secrets-tavily.bin'), safeStorage)
  const embeddingSecrets = createSecretStore(join(userData, 'secrets-embedding.bin'), safeStorage)
  const firecrawlSecrets = createSecretStore(join(userData, 'secrets-firecrawl.bin'), safeStorage)

  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })

  function emitPetEvent(event: PetEvent): void {
    petWin.webContents.send(IPC.PET_EVENT, event)
  }

  const dialog = createDialogController({
    preload,
    url: rendererUrl ? `${rendererUrl}/dialog.html` : undefined,
    dialogHtml,
    onOpened: () => {
      emitPetEvent('dialogOpen')
      dialog.pushUpdate(chat.messages())
    },
    onClosed: () => emitPetEvent('dialogClose')
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
  const memory = createMemoryManager({ dir: memoryDir, getEmbedder })
  // 待办是用户的、非宠物皮肤的数据——全局存储,换宠物(petHome 会变)也不能丢/分叉待办
  const todoStore = createTodoStore({ file: join(userData, 'todos.json') })

  const chat = createChatStore({
    petDir,
    skills,
    memory,
    todoStore,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    getSearchKey: () => searchSecrets.getKey(),
    getFirecrawlKey: () => firecrawlSecrets.getKey(),
    prepareImages: (atts) => atts.map((a) => prepareImage(a)),
    clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs),
    pushStream: (t) => dialog.window()?.webContents.send(IPC.CHAT_STREAM, t),
    pushStatus: (t) => dialog.window()?.webContents.send(IPC.CHAT_STATUS, t),
    pushDone: () => dialog.window()?.webContents.send(IPC.CHAT_DONE),
    pushError: (m) => dialog.window()?.webContents.send(IPC.CHAT_ERROR, m),
    openSettings: () => openSettings()
  })

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

  ipcMain.handle(IPC.GET_PET, async () => loadPet(petDir))
  ipcMain.handle(IPC.GET_WINDOW_BOUNDS, async (): Promise<WindowBounds> => {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    const workArea = screen.getDisplayMatching({ x, y, width, height }).workArea
    return { workArea, window: { x, y, width, height } }
  })
  ipcMain.on(IPC.MOVE_WINDOW, (_e, raw) => {
    const delta = validateMoveDelta(raw)
    if (!delta) return
    const [x, y] = petWin.getPosition()
    const nx = Math.round(x + delta.dx)
    const ny = Math.round(y + delta.dy)
    if (delta.clamp) {
      // Autonomous walk: hard-limit to the current display's work area against
      // the REAL position (the renderer's predicted X can drift), so the pet
      // never wanders off-screen. Manual drags are intentionally NOT clamped
      // (free movement, matching MVP-01) — clamping them felt "magnetized".
      const [width, height] = petWin.getSize()
      const { workArea } = screen.getDisplayMatching({ x, y, width, height })
      petWin.setPosition(
        Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width - width)),
        Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - height))
      )
    } else {
      petWin.setPosition(nx, ny)
    }
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
    chat.handleSend(payload)
  })
  ipcMain.on(IPC.CANCEL_CHAT, () => chat.cancel())

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
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey()
  }))
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => { saveSettings(settingsFile, normalizeSettings(raw)) })
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
  ipcMain.on(IPC.OPEN_MEMORY_DIR, () => {
    mkdirSync(memoryDir, { recursive: true })
    void electronShell.openPath(memoryDir)
  })
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, raw): Promise<TestResult> => {
    const arg = validateTestConnectionArg(raw)
    if (!arg) return { ok: false, error: 'invalid request' }
    return testConnection(arg.provider, arg.key)
  })
  const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
  ipcMain.on(IPC.RELAUNCH_APP, () => { app.relaunch(); app.quit() })
  ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, raw) => {
    const collapsed = validateBool(raw)
    if (collapsed === null) return
    dialog.setSize(collapsed)
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
      chat.runQuickAction(id)
    },
    onTodos: () => todoWin.open()
  })

  scheduler.start()

  if (!secrets.hasKey()) openSettings()

  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop() })
}
