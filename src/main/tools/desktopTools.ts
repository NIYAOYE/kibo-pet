import type { ToolSpec } from './toolSpec'
import type { AutomationControl } from '../automation/automationControl'
import type { ScreenshotState } from '../automation/screenshotState'
import type { FullScreenShot } from '../media/fullScreenCapture'
import { ALLOWED_KEY_NAMES } from '../automation/keyAllowlist'

export const MAX_TYPE_TEXT_LEN = 2000
const NOT_WINDOWS_ERROR = '此功能仅支持 Windows'

export function createDesktopTools(opts: {
  platform: NodeJS.Platform
  automation: AutomationControl
  screenshotState: ScreenshotState
  captureScreen: () => Promise<FullScreenShot>
}): ToolSpec[] {
  const isWindows = opts.platform === 'win32'

  const takeScreenshot: ToolSpec = {
    name: 'take_screenshot',
    description: '截取当前屏幕(光标所在显示器)的画面,用于查看屏幕上的内容。点击/操作前必须先调用这个工具看清当前画面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const shot = await opts.captureScreen()
      opts.screenshotState.record({
        displayId: shot.displayId, originX: shot.originX, originY: shot.originY,
        physicalWidth: shot.physicalWidth, physicalHeight: shot.physicalHeight,
        imageWidth: shot.imageWidth, imageHeight: shot.imageHeight
      })
      return { content: `已截屏,图像分辨率 ${shot.imageWidth}x${shot.imageHeight}(click_at 的坐标请以此图像为基准)`, images: [shot.image] }
    }
  }

  const listWindows: ToolSpec = {
    name: 'list_windows',
    description: '列出当前所有可见窗口的标题,用于查找要操作的目标应用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const r = await opts.automation.listWindows()
      if (!r.ok) return `列出窗口失败:${r.error}`
      if (!r.titles || r.titles.length === 0) return '当前没有可见窗口'
      return `当前可见窗口:\n${r.titles.map((t) => `- ${t}`).join('\n')}`
    }
  }

  const focusWindow: ToolSpec = {
    name: 'focus_window',
    description: '把标题包含指定文字的窗口切换到前台,便于接下来对它截屏/点击/输入。',
    inputSchema: { type: 'object', properties: { titleContains: { type: 'string' } }, required: ['titleContains'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { titleContains } = input as { titleContains: string }
      const r = await opts.automation.focusWindow(titleContains)
      return r.ok ? `已切换到窗口:${r.title}` : `切换窗口失败:${r.error}`
    }
  }

  const clickAt: ToolSpec = {
    name: 'click_at',
    description: '在最近一次 take_screenshot 返回的图像坐标系里点击指定位置。调用前必须已经调用过 take_screenshot,否则会报错。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string' }, double: { type: 'boolean' }
      },
      required: ['x', 'y']
    },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { x, y, button, double } = input as { x: number; y: number; button?: 'left' | 'right'; double?: boolean }
      const point = opts.screenshotState.toPhysicalPoint(x, y)
      if (!point) return '还没有截屏记录,请先调用 take_screenshot 再点击'
      const r = await opts.automation.click({ x: point.x, y: point.y, button: button ?? 'left', double: double ?? false })
      return r.ok ? `已点击(${button === 'right' ? '右键' : '左键'}${double ? '双击' : ''})` : `点击失败:${r.error}`
    }
  }

  const typeText: ToolSpec = {
    name: 'type_text',
    description: `向当前焦点控件输入文字(最多 ${MAX_TYPE_TEXT_LEN} 字符),输入前请确保通过 click_at 已经点中目标输入框。`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { text } = input as { text: string }
      if (text.length > MAX_TYPE_TEXT_LEN) return `打字内容过长(超过 ${MAX_TYPE_TEXT_LEN} 字符),请分批输入`
      const r = await opts.automation.typeText(text)
      return r.ok ? '已输入文字' : `输入失败:${r.error}`
    }
  }

  const pressKey: ToolSpec = {
    name: 'press_key',
    description: `按下一个键或组合键,仅支持:${ALLOWED_KEY_NAMES.join('、')}。`,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { key } = input as { key: string }
      const r = await opts.automation.pressKey(key)
      return r.ok ? `已按下:${key}` : `按键失败:${r.error}`
    }
  }

  return [takeScreenshot, listWindows, focusWindow, clickAt, typeText, pressKey]
}
