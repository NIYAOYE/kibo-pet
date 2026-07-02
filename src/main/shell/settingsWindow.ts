import { BrowserWindow } from 'electron'

export interface SettingsController { open(): void }

export function createSettingsWindow(opts: {
  preload: string
  url: string | undefined // dev: `${rendererUrl}/settings.html`
  settingsHtml: string
}): SettingsController {
  let win: BrowserWindow | null = null

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: 460,
      height: 520,
      title: '设置',
      resizable: false,
      skipTaskbar: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    if (opts.url) w.loadURL(opts.url)
    else w.loadFile(opts.settingsHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    open(): void {
      if (!win) win = build()
      win.show()
      win.focus()
    }
  }
}
