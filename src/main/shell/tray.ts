import { Tray, Menu, nativeImage, app } from 'electron'

export function createTray(iconPath: string): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Pet Agent')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '退出', click: () => app.quit() }]))
  return tray
}
