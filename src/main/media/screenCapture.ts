import { BrowserWindow, desktopCapturer, ipcMain, type Display } from 'electron'
import { IPC, type ChatSendAttachment } from '@shared/ipc'
import { validateOverlayRect } from '@shared/ipcValidation'
import { prepareImage } from './imagePrep'

/**
 * 框选截屏:抓当前显示器全分辨率截图 → 弹全屏透明覆盖层 → 用户拖矩形 →
 * 按 scaleFactor 换算到设备像素裁剪 → prepareImage(JPEG)。Esc/空选/关窗 → null。
 * native + GUI,靠真机验收。限当前显示器(多显示器 deferred)。
 */
export async function captureRegion(opts: {
  preload: string
  overlayHtml: string
  overlayUrl?: string
  display: Display
}): Promise<ChatSendAttachment | null> {
  const { display } = opts
  const scale = display.scaleFactor
  const full = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full })
  const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!src) return null
  const shot = src.thumbnail // 全分辨率 nativeImage

  return await new Promise<ChatSendAttachment | null>((resolve) => {
    const win = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y,
      width: display.bounds.width, height: display.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, resizable: false, movable: false, enableLargerThanScreen: true,
      webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    let settled = false
    const cleanup = (): void => {
      ipcMain.removeListener(IPC.OVERLAY_SUBMIT, onSubmit)
      ipcMain.removeListener(IPC.OVERLAY_CANCEL, onCancel)
    }
    const finish = (v: ChatSendAttachment | null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!win.isDestroyed()) win.close()
      resolve(v)
    }
    const onSubmit = (e: Electron.IpcMainEvent, raw: unknown): void => {
      if (e.sender !== win.webContents) return
      const rect = validateOverlayRect(raw)
      if (!rect) return finish(null)
      const dx = Math.round(rect.x * scale), dy = Math.round(rect.y * scale)
      const dw = Math.round(rect.width * scale), dh = Math.round(rect.height * scale)
      if (dw < 2 || dh < 2) return finish(null)
      try {
        const cropped = shot.crop({ x: dx, y: dy, width: dw, height: dh })
        const prepped = prepareImage({ mimeType: 'image/jpeg', dataBase64: cropped.toJPEG(85).toString('base64') })
        finish({ kind: 'image', mimeType: prepped.mimeType, dataBase64: prepped.dataBase64 })
      } catch {
        finish(null)
      }
    }
    const onCancel = (e: Electron.IpcMainEvent): void => {
      if (e.sender !== win.webContents) return
      finish(null)
    }

    ipcMain.on(IPC.OVERLAY_SUBMIT, onSubmit)
    ipcMain.on(IPC.OVERLAY_CANCEL, onCancel)
    win.on('closed', () => finish(null))
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(IPC.OVERLAY_INIT, {
        screenshotDataUrl: shot.toDataURL(),
        width: display.bounds.width,
        height: display.bounds.height
      })
    })
    win.webContents.on('did-fail-load', () => finish(null))
    if (opts.overlayUrl) void win.loadURL(opts.overlayUrl)
    else void win.loadFile(opts.overlayHtml)
    win.show()
    win.focus()
  })
}
