import { BrowserWindow } from 'electron'

export function createPetWindow(opts: {
  preload: string
  url: string | undefined
  indexHtml: string
  initialSize: { width: number; height: number }
}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.initialSize.width,
    height: opts.initialSize.height,
    transparent: true,
    frame: false,
    resizable: true, // 尺寸变化只在 setBounds() 时一次性发生(首次加载/热切换提交),不运行时切换 setResizable
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
