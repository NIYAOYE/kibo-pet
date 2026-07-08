import { BrowserWindow, screen } from 'electron'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildIndicatorHtml(petDisplayName: string): string {
  const safe = escapeHtml(petDisplayName)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:system-ui,sans-serif}
#badge{display:flex;align-items:center;justify-content:center;gap:8px;height:100%;box-sizing:border-box;
  background:rgba(120,60,200,0.92);color:#fff;font-size:13px;border-radius:10px;
  box-shadow:0 2px 10px rgba(0,0,0,0.25)}
</style></head><body><div id="badge">🖱️ ${safe} 正在控制鼠标</div></body></html>`
}

export interface ControlIndicator { show(): void; hide(): void }

const WIDTH = 260
const HEIGHT = 34

/**
 * 置顶、鼠标穿透的静态提示条:执行期间告知用户"宠物在控制鼠标",而非笼统的"AI"。
 * 文案在创建时一次性烘焙进 data: URL(应用生命周期内宠物名不会变),无需 preload/IPC。
 * import electron,不可单测,靠 Task 14/15 真机验收。
 */
export function createControlIndicator(petDisplayName: string): ControlIndicator {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, x: 0, y: 0,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildIndicatorHtml(petDisplayName))}`)

  return {
    show(): void {
      const d = screen.getPrimaryDisplay()
      win.setBounds({
        x: Math.round(d.bounds.x + d.bounds.width / 2 - WIDTH / 2),
        y: d.bounds.y + 8,
        width: WIDTH, height: HEIGHT
      })
      win.showInactive()
    },
    hide(): void { win.hide() }
  }
}
