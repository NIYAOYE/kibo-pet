import { BrowserWindow } from 'electron'

export const PET_WINDOW_SIZE = { width: 256, height: 288 } as const

export function createPetWindow(opts: { preload: string; url: string | undefined; indexHtml: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.indexHtml)
  return win
}
