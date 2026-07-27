import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'

/**
 * 头像裁剪弹窗:接收一张已预处理(降采样)过的图片 data URL,弹一个居中小窗口,
 * 渲染层内部把图片黑边居中合成正方形画布,并提供可拖动/缩放的方框选取最终头像区域。
 * 结构与 screenCapture.ts 的 captureRegion() 同一套"弹窗 + promise resolve"模式,
 * 但走独立的 AVATAR_CROP_* 通道(提交的是裁好的图,不是矩形,语义不同不复用 OVERLAY_*)。
 */
export async function openAvatarCropper(opts: {
  preload: string
  cropperHtml: string
  cropperUrl?: string
  imageDataUrl: string
}): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const win = new BrowserWindow({
      width: 440, height: 560,
      resizable: false, alwaysOnTop: true, skipTaskbar: true,
      frame: false, transparent: true, show: false, center: true,
      webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    let settled = false
    const cleanup = (): void => {
      ipcMain.removeListener(IPC.AVATAR_CROP_SUBMIT, onSubmit)
      ipcMain.removeListener(IPC.AVATAR_CROP_CANCEL, onCancel)
    }
    const finish = (v: string | null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!win.isDestroyed()) win.close()
      resolve(v)
    }
    const onSubmit = (e: Electron.IpcMainEvent, raw: unknown): void => {
      if (e.sender !== win.webContents) return
      if (typeof raw !== 'string' || !raw.startsWith('data:image/png;base64,')) return finish(null)
      finish(raw)
    }
    const onCancel = (e: Electron.IpcMainEvent): void => {
      if (e.sender !== win.webContents) return
      finish(null)
    }

    ipcMain.on(IPC.AVATAR_CROP_SUBMIT, onSubmit)
    ipcMain.on(IPC.AVATAR_CROP_CANCEL, onCancel)
    win.on('closed', () => finish(null))
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(IPC.AVATAR_CROP_INIT, { imageDataUrl: opts.imageDataUrl })
    })
    win.webContents.on('did-fail-load', () => finish(null))
    if (opts.cropperUrl) void win.loadURL(opts.cropperUrl)
    else void win.loadFile(opts.cropperHtml)
    win.show()
    win.focus()
  })
}
