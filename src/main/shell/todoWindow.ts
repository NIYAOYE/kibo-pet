import { BrowserWindow } from 'electron'
import { IPC, type TodoItem } from '@shared/ipc'

const SIZE = { width: 360, height: 480 }

export interface TodoWindowController {
  open(): void
  window(): BrowserWindow | null
  pushUpdate(items: TodoItem[]): void
  pushFired(id: string): void
}

export function createTodoWindow(opts: {
  preload: string
  url: string | undefined       // todoPanel.html 的 dev URL(含 /todoPanel.html),打包为 undefined
  todoHtml: string
}): TodoWindowController {
  let win: BrowserWindow | null = null

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: SIZE.width,
      height: SIZE.height,
      frame: false,
      resizable: true,
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
    else w.loadFile(opts.todoHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    window: () => win,
    open(): void {
      if (!win) win = build()
      win.show()
      win.focus()
    },
    pushUpdate(items: TodoItem[]): void {
      win?.webContents.send(IPC.TODO_UPDATE, items)
    },
    pushFired(id: string): void {
      win?.webContents.send(IPC.TODO_FIRED, id)
    }
  }
}
