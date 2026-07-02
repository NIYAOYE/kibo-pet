import { app, ipcMain, safeStorage, screen, type Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IPC,
  type MoveDelta,
  type WindowBounds,
  type ChatSendPayload,
  type SettingsSnapshot,
  type TestResult
} from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow } from './petWindow'
import { createTray } from './tray'
import { createSettingsWindow } from './settingsWindow'
import { createDialogController } from './dialogWindow'
import { createChatStore } from './chat'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'
import { loadSettings, saveSettings } from '../config/settings'
import { createSecretStore } from '../config/secrets'
import { testConnection } from '../agent/testConnection'

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
  const petDir = join(petsDir(appRoot), 'luluka')

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

  const settingsFile = join(app.getPath('userData'), 'settings.json')
  const secrets = createSecretStore(join(app.getPath('userData'), 'secrets.bin'), safeStorage)

  const settings = createSettingsWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/settings.html` : undefined,
    settingsHtml: join(dirname, '../renderer/settings.html')
  })

  const chat = createChatStore({
    petDir,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs),
    pushStream: (t) => dialog.window()?.webContents.send(IPC.CHAT_STREAM, t),
    pushDone: () => dialog.window()?.webContents.send(IPC.CHAT_DONE),
    pushError: (m) => dialog.window()?.webContents.send(IPC.CHAT_ERROR, m),
    openSettings: () => openSettings()
  })

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
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
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
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.TOGGLE_DIALOG, () => toggleDialog())
  ipcMain.on(IPC.CHAT_SEND, (_e, payload: ChatSendPayload) => chat.handleSend(payload))
  ipcMain.on(IPC.CANCEL_CHAT, () => chat.cancel())
  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettings())
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey()
  }))
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, s: AppSettings) => { saveSettings(settingsFile, s) })
  ipcMain.handle(IPC.SET_API_KEY, async (_e, key: string): Promise<boolean> => secrets.setKey(String(key ?? '')))
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, arg: { provider: ProviderSettings; key: string }): Promise<TestResult> =>
    testConnection(arg.provider, arg.key)
  )
  ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, collapsed: boolean) => dialog.setSize(!!collapsed))
  ipcMain.on(IPC.QUIT, () => app.quit())

  registerHotkeys(toggleDialog)
  tray = createTray(join(appRoot, 'resources/tray.png'), openSettings)

  if (!secrets.hasKey()) openSettings()

  app.on('will-quit', () => unregisterHotkeys())
}
