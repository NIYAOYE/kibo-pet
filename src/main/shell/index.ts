import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type MoveDelta } from '@shared/ipc'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow } from './petWindow'
import { createTray } from './tray'

export function startShell(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url)) // out/main
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const petHtml = join(dirname, '../renderer/index.html')
  const petDir = join(petsDir(appRoot), 'luluka')

  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })

  ipcMain.handle(IPC.GET_PET, async () => loadPet(petDir))
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
    const [x, y] = petWin.getPosition()
    petWin.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
  })
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.QUIT, () => app.quit())

  createTray(join(appRoot, 'resources/tray.png'))
}
