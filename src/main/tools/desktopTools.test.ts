import { describe, it, expect, vi } from 'vitest'
import { createDesktopTools } from './desktopTools'
import { createScreenshotState } from '../automation/screenshotState'
import type { AutomationControl } from '../automation/automationControl'

const ctx = { signal: new AbortController().signal }

function fakeAutomation(overrides: Partial<AutomationControl> = {}): AutomationControl {
  return {
    click: vi.fn(async () => ({ ok: true })),
    typeText: vi.fn(async () => ({ ok: true })),
    pressKey: vi.fn(async () => ({ ok: true })),
    listWindows: vi.fn(async () => ({ ok: true, titles: ['记事本'] })),
    focusWindow: vi.fn(async () => ({ ok: true, title: '记事本' })),
    ...overrides
  }
}

const fakeShot = {
  image: { mimeType: 'image/jpeg', dataBase64: 'AAA' },
  displayId: '1', originX: 0, originY: 0,
  physicalWidth: 1920, physicalHeight: 1080,
  imageWidth: 960, imageHeight: 540
}

function tools(overrides: Parameters<typeof createDesktopTools>[0] extends infer T ? Partial<T> : never = {}) {
  const screenshotState = createScreenshotState()
  const automation = fakeAutomation()
  const captureScreen = vi.fn(async () => fakeShot)
  const all = createDesktopTools({ platform: 'win32', automation, screenshotState, captureScreen, ...overrides })
  return { all, screenshotState, automation, captureScreen }
}

describe('createDesktopTools', () => {
  it('返回六个工具,名字固定', () => {
    const { all } = tools()
    expect(all.map((t) => t.name)).toEqual(['take_screenshot', 'list_windows', 'focus_window', 'click_at', 'type_text', 'press_key'])
  })

  it('非 Windows 平台:所有工具直接报错,不调用底层依赖', async () => {
    const automation = fakeAutomation()
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'darwin', automation, screenshotState: createScreenshotState(), captureScreen })
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    const r = await shotTool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('仅支持 Windows')
    expect(captureScreen).not.toHaveBeenCalled()
  })

  it('take_screenshot:返回 content+images,并记录 screenshotState', async () => {
    const { all, screenshotState } = tools()
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    const r = await shotTool.run({}, ctx)
    expect(typeof r).not.toBe('string')
    const out = r as { content: string; images?: unknown[] }
    expect(out.images).toEqual([fakeShot.image])
    expect(screenshotState.current()).not.toBeNull()
  })

  it('click_at:未先截屏时报错要求先截屏,不调用 automation.click', async () => {
    const { all, automation } = tools()
    const clickTool = all.find((t) => t.name === 'click_at')!
    const r = await clickTool.run({ x: 1, y: 1 }, ctx)
    const content = typeof r === 'string' ? r : r.content
    expect(content).toContain('先')
    expect(content).toContain('截屏')
    expect(automation.click).not.toHaveBeenCalled()
  })

  it('click_at:已截屏后按 screenshotState 换算坐标再点击', async () => {
    const { all, automation } = tools()
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    await shotTool.run({}, ctx)
    const clickTool = all.find((t) => t.name === 'click_at')!
    await clickTool.run({ x: 100, y: 50 }, ctx)
    expect(automation.click).toHaveBeenCalledWith({ x: 200, y: 100, button: 'left', double: false })
  })

  it('type_text:超过 2000 字符直接拒绝,不调用 automation.typeText', async () => {
    const { all, automation } = tools()
    const typeTool = all.find((t) => t.name === 'type_text')!
    const r = await typeTool.run({ text: 'a'.repeat(2001) }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('过长')
    expect(automation.typeText).not.toHaveBeenCalled()
  })

  it('press_key:automation 拒绝白名单外键时把错误原样回灌', async () => {
    const automation = fakeAutomation({ pressKey: vi.fn(async () => ({ ok: false, error: '不支持的按键:Alt+F4。可用:Enter、Tab' })) })
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'win32', automation, screenshotState: createScreenshotState(), captureScreen })
    const pressTool = all.find((t) => t.name === 'press_key')!
    const r = await pressTool.run({ key: 'Alt+F4' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('不支持的按键')
  })

  it('list_windows:把标题列表格式化为文本', async () => {
    const { all } = tools()
    const listTool = all.find((t) => t.name === 'list_windows')!
    const r = await listTool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('记事本')
  })

  it('focus_window:找不到窗口时报错', async () => {
    const automation = fakeAutomation({ focusWindow: vi.fn(async () => ({ ok: false, error: '没找到标题包含"不存在"的窗口' })) })
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'win32', automation, screenshotState: createScreenshotState(), captureScreen })
    const focusTool = all.find((t) => t.name === 'focus_window')!
    const r = await focusTool.run({ titleContains: '不存在' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('没找到')
  })
})
