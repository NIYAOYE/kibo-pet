import { Tray, Menu, nativeImage, app } from 'electron'
import { QUICK_ACTIONS } from './quickActions'

export function createTray(
  iconPath: string,
  handlers: { onSettings: () => void; onQuickAction: (id: string) => void; onTodos: () => void }
): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Kibo')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '快捷加工',
      submenu: QUICK_ACTIONS.map((a) => ({ label: a.label, click: () => handlers.onQuickAction(a.id) }))
    },
    { type: 'separator' },
    { label: '待办清单', click: () => handlers.onTodos() },
    { label: '设置', click: () => handlers.onSettings() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  return tray
}
