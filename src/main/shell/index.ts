import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, BrowserWindow, type Tray } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createAutomationControl } from '../automation/automationControl'
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
  type TestResult
} from '@shared/ipc'
import type { PetEvent, Bounds } from '@shared/petBrain'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow, PET_WINDOW_SIZE } from './petWindow'
import { createTray } from './tray'
import { startIdleWatcher } from '../context/idleWatcher'
import { createSettingsWindow } from './settingsWindow'
import { createDialogController } from './dialogWindow'
import { createBubbleController } from './bubbleWindow'
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
import { loadLines, pickLine } from '../lines/linesLoader'
import { prepareImage } from '../media/imagePrep'
import { captureRegion } from '../media/screenCapture'
import { DEFAULT_SETTINGS } from '@shared/llm'
import type { ChatSendAttachment } from '@shared/ipc'
import type { TodoItem } from '@shared/todo'
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS,
  validateReactionCategory, validateBubbleHeight
} from '@shared/ipcValidation'
import { fixedWindowBounds, isZeroMove } from '@shared/windowPlacement'

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
  const bubbleHtml = join(dirname, '../renderer/bubble.html')
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
      dialog.pushUpdate(chat.messages())
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
  const memory = createMemoryManager({ dir: memoryDir, getEmbedder })
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
  let controlIndicator: ReturnType<typeof createControlIndicator> | null = null
  void loadPet(petDir)
    .then((p) => { controlIndicator = createControlIndicator(p.manifest.displayName) })
    .catch(() => { controlIndicator = createControlIndicator('宠物') })

  const lastAiPos = createLastAiPosTracker()
  let manualOverrideWatch: ReturnType<typeof startManualOverrideWatch> | null = null
  const indicatorGate = createIndicatorGate(
    () => {
      // 每轮桌面控制开始时清空上一轮残留的 lastAiPos:否则 manualOverrideWatch 首个 tick 会拿
      // 上一轮点击坐标去比对本轮真实光标——用户在两轮之间正常移动鼠标就会被误判为"人工接管",
      // 提前 cancel() 本轮尚未开始点击的自动化(fail-safe 但会打断用户,见 review finding)。
      lastAiPos.clear()
      controlIndicator?.show()
      manualOverrideWatch = startManualOverrideWatch({
        getCursorPos: () => {
          const p = screen.getCursorScreenPoint()
          const d = screen.getDisplayNearestPoint(p)
          return { x: Math.round(p.x * d.scaleFactor), y: Math.round(p.y * d.scaleFactor) }
        },
        getLastAiPos: () => lastAiPos.get(),
        onOverride: () => { chat.cancel() }
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

  const chat = createChatStore({
    petDir,
    skills,
    memory,
    todoStore,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    getSearchKey: () => searchSecrets.getKey(),
    getFirecrawlKey: () => firecrawlSecrets.getKey(),
    buildDesktopTools: () => createDesktopTools({
      platform: process.platform,
      automation: automationWithTracking,
      screenshotState: createScreenshotState(), // 每次 handleSend 都是全新一个 —— 每轮对话自然重置
      captureScreen: () => captureFullScreen(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    }),
    wrapDesktopTools: (tools) => wrapToolsWithGate(tools, indicatorGate),
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

  ipcMain.handle(IPC.GET_PET, async () => loadPet(petDir))
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
    chat.handleSend(payload)
  })
  ipcMain.on(IPC.CANCEL_CHAT, () => chat.cancel())
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = pickLine(loadLines(petDir), category, lastLineText ?? undefined)
    if (!line) return // lines.json 缺失或该 category 为空 → 静默降级
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
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey()
  }))
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
    dialogCollapsed = collapsed
    refreshBubble() // 展开→隐藏气泡(回复走对话框 history);折叠→有内容则显示
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

  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close() })
}
