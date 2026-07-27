import { Tray, Menu, nativeImage, app } from 'electron'

export function createTray(
  iconPath: string,
  handlers: { onSettings: () => void; onTodos: () => void }
): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Tamashii')
  tray.setContextMenu(Menu.buildFromTemplate([
    { type: 'separator' },
    { label: '待办清单', click: () => handlers.onTodos() },
    { label: '设置', click: () => handlers.onSettings() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  return tray
}
