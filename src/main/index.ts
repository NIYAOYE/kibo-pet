import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type MoveDelta } from '@shared/ipc'
import { loadPet, petsDir } from './petLoader'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// 开发期 appRoot = 项目根;打包后再调整(MVP-06 处理)
const appRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')

let win: BrowserWindow | null = null
let tray: Tray | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 256,
    height: 288,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => { win = null })
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(appRoot, 'resources/tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Pet Agent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '退出', click: () => app.quit() }
  ]))
}

function registerIpc(): void {
  ipcMain.handle(IPC.GET_PET, async () => loadPet(join(petsDir(appRoot), 'luluka')))
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
    if (!win) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
  })
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    // forward:true keeps mousemove events flowing so the renderer can detect
    // when the cursor re-enters the pet and turn interactivity back on.
    win?.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.QUIT, () => app.quit())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  createTray()
})

app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
