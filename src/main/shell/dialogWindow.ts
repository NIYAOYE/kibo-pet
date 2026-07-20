import { BrowserWindow, screen, shell } from 'electron'
import { IPC, type ChatMessage } from '@shared/ipc'

const COLLAPSED = { width: 320, height: 56 }
const EXPANDED = { width: 520, height: 470 }
const COLLAPSED_MIN = 44
const COLLAPSED_MAX = 400

export interface DialogController {
  toggle(getPetBounds: () => { x: number; y: number; width: number }): void
  isOpen(): boolean
  setSize(collapsed: boolean): void
  setCollapsedHeight(height: number): void
  pushUpdate(messages: ChatMessage[]): void
  window(): BrowserWindow | null
}

export function createDialogController(opts: {
  preload: string
  url: string | undefined // dialog.html 的 dev URL(含 /dialog.html),打包为 undefined
  dialogHtml: string
  onOpened: () => void
  onClosed: () => void
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
    // 回复里渲染的来源链接:在系统默认浏览器打开,绝不让它导航/替换掉对话框本身。
    // will-navigate 拦截普通 <a> 左键点击(无 target),setWindowOpenHandler 兜住 target=_blank。
    w.webContents.on('will-navigate', (e, url) => {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    })
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
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
      // resizable:false 会让 Windows 下 setSize 被忽略/夹住(尤其是缩小),
      // 临时开启 resizable 再调整,是官方推荐的绕过方式。
      const wasResizable = win.isResizable()
      if (!wasResizable) win.setResizable(true)
      win.setSize(s.width, s.height)
      if (!wasResizable) win.setResizable(false)
    },
    setCollapsedHeight(height: number): void {
      if (!win || !collapsed) return // 仅折叠态生效;展开态忽略上报
      const h = Math.max(COLLAPSED_MIN, Math.min(Math.round(height), COLLAPSED_MAX))
      const wasResizable = win.isResizable()
      if (!wasResizable) win.setResizable(true)
      win.setSize(COLLAPSED.width, h)
      if (!wasResizable) win.setResizable(false)
    },
    pushUpdate(messages: ChatMessage[]): void {
      win?.webContents.send(IPC.CHAT_UPDATE, messages)
    },
    toggle(getPetBounds): void {
      if (win && win.isVisible()) { win.hide(); opts.onClosed(); return }
      if (!win) win = build()
      const pet = getPetBounds()
      const s = collapsed ? COLLAPSED : EXPANDED
      const area = screen.getDisplayMatching({ x: pet.x, y: pet.y, width: pet.width, height: 1 }).workArea
      // Prefer right of the pet; flip to the left if it would overflow the display's right edge.
      let x = pet.x + pet.width
      if (x + s.width > area.x + area.width) x = pet.x - s.width
      x = Math.max(area.x, Math.min(x, area.x + area.width - s.width))
      const y = Math.max(area.y, Math.min(pet.y, area.y + area.height - s.height))
      const wasResizable = win.isResizable()
      if (!wasResizable) win.setResizable(true)
      win.setBounds({ x, y, width: s.width, height: s.height })
      if (!wasResizable) win.setResizable(false)
      win.show()
      win.focus()
      opts.onOpened()
    }
  }
}
