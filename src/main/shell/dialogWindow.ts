import { BrowserWindow } from 'electron'
import { IPC, type ChatMessage } from '@shared/ipc'

const COLLAPSED = { width: 320, height: 130 }
const EXPANDED = { width: 320, height: 440 }

export interface DialogController {
  toggle(getPetBounds: () => { x: number; y: number; width: number }): void
  isOpen(): boolean
  setSize(collapsed: boolean): void
  pushUpdate(messages: ChatMessage[]): void
  window(): BrowserWindow | null
}

export function createDialogController(opts: {
  preload: string
  url: string | undefined // dialog.html 的 dev URL(含 /dialog.html),打包为 undefined
  dialogHtml: string
  onOpened: () => void
}): DialogController {
  let win: BrowserWindow | null = null
  let collapsed = true

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: COLLAPSED.width,
      height: COLLAPSED.height,
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    if (opts.url) w.loadURL(opts.url)
    else w.loadFile(opts.dialogHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    window: () => win,
    isOpen: () => !!win && win.isVisible(),
    setSize(c: boolean): void {
      collapsed = c
      if (!win) return
      const s = c ? COLLAPSED : EXPANDED
      win.setSize(s.width, s.height)
    },
    pushUpdate(messages: ChatMessage[]): void {
      win?.webContents.send(IPC.CHAT_UPDATE, messages)
    },
    toggle(getPetBounds): void {
      if (win && win.isVisible()) { win.hide(); return }
      if (!win) win = build()
      const pet = getPetBounds()
      const s = collapsed ? COLLAPSED : EXPANDED
      win.setBounds({ x: pet.x + pet.width, y: pet.y, width: s.width, height: s.height })
      win.show()
      win.focus()
      opts.onOpened()
    }
  }
}
