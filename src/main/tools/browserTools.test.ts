import { describe, it, expect, vi } from 'vitest'
import { createBrowserTools } from './browserTools'
import type { BrowserControl } from '../browserAutomation/browserControl'

const ctx = { signal: new AbortController().signal }

function fakeControl(overrides: Partial<BrowserControl> = {}): BrowserControl {
  return {
    navigate: vi.fn(async () => ({ ok: true })),
    click: vi.fn(async () => ({ ok: true })),
    fillText: vi.fn(async () => ({ ok: true })),
    readText: vi.fn(async () => ({ ok: true, text: '正文' })),
    screenshot: vi.fn(async () => ({ ok: true, image: { mimeType: 'image/jpeg', dataBase64: 'AAA' } })),
    scroll: vi.fn(async () => ({ ok: true })),
    waitFor: vi.fn(async () => ({ ok: true })),
    listTabs: vi.fn(async () => ({ ok: true, tabs: [{ index: 0, title: 'A', url: 'https://a.com' }] })),
    openTab: vi.fn(async () => ({ ok: true })),
    switchTab: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    ...overrides
  }
}

describe('createBrowserTools', () => {
  it('返回十一个工具,名字固定', () => {
    const all = createBrowserTools({ control: fakeControl() })
    expect(all.map((t) => t.name)).toEqual([
      'browser_navigate', 'browser_click', 'browser_fill_text', 'browser_read_text',
      'browser_screenshot', 'browser_scroll', 'browser_wait_for',
      'browser_list_tabs', 'browser_open_tab', 'browser_switch_tab', 'browser_close'
    ])
  })

  it('browser_navigate:成功 → 提示已跳转', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_navigate')!
    const r = await tool.run({ url: 'https://bilibili.com' }, ctx)
    expect(control.navigate).toHaveBeenCalledWith('https://bilibili.com')
    expect(typeof r === 'string' ? r : r.content).toContain('bilibili.com')
  })

  it('browser_navigate:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ navigate: vi.fn(async () => ({ ok: false, error: '连接失败' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_navigate')!
    const r = await tool.run({ url: 'https://x.com' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('连接失败')
  })

  it('browser_click:透传 text/selector', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_click')!
    await tool.run({ text: '登录', selector: '#a' }, ctx)
    expect(control.click).toHaveBeenCalledWith({ text: '登录', selector: '#a' })
  })

  it('browser_click:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ click: vi.fn(async () => ({ ok: false, error: '未找到元素' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_click')!
    const r = await tool.run({ text: '登录' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('未找到元素')
  })

  it('browser_fill_text:透传 text/value', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_fill_text')!
    await tool.run({ text: '用户名', value: 'alice' }, ctx)
    expect(control.fillText).toHaveBeenCalledWith({ text: '用户名', value: 'alice' })
  })

  it('browser_fill_text:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ fillText: vi.fn(async () => ({ ok: false, error: '找不到输入框' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_fill_text')!
    const r = await tool.run({ text: '用户名', value: 'alice' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('找不到输入框')
  })

  it('browser_read_text:返回正文', async () => {
    const control = fakeControl({ readText: vi.fn(async () => ({ ok: true, text: '一些正文' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_read_text')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('一些正文')
  })

  it('browser_read_text:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ readText: vi.fn(async () => ({ ok: false, error: '页面未加载' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_read_text')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('页面未加载')
  })

  it('browser_screenshot:content+images 都有,images 透传 control 返回的 image', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_screenshot')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? undefined : r.images).toEqual([{ mimeType: 'image/jpeg', dataBase64: 'AAA' }])
  })

  it('browser_screenshot:失败 → 返回纯字符串错误(不带 images)', async () => {
    const control = fakeControl({ screenshot: vi.fn(async () => ({ ok: false, error: '截图失败原因' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_screenshot')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('截图失败原因')
  })

  it('browser_scroll:透传 direction/amount', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_scroll')!
    await tool.run({ direction: 'down', amount: 'small' }, ctx)
    expect(control.scroll).toHaveBeenCalledWith({ direction: 'down', amount: 'small' })
  })

  it('browser_scroll:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ scroll: vi.fn(async () => ({ ok: false, error: '滚动出错' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_scroll')!
    const r = await tool.run({ direction: 'down' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('滚动出错')
  })

  it('browser_wait_for 超时失败 → 报错文案带 error', async () => {
    const control = fakeControl({ waitFor: vi.fn(async () => ({ ok: false, error: '等待超时' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_wait_for')!
    const r = await tool.run({ text: 'x' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('等待超时')
  })

  it('browser_list_tabs:列成可读文本', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_list_tabs')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('A')
  })

  it('browser_list_tabs:空列表 → 提示当前没有打开的标签页', async () => {
    const control = fakeControl({ listTabs: vi.fn(async () => ({ ok: true, tabs: [] })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_list_tabs')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('当前没有打开的标签页')
  })

  it('browser_open_tab / browser_switch_tab / browser_close:分别透传入参并成功', async () => {
    const control = fakeControl()
    const tools = createBrowserTools({ control })
    await tools.find((t) => t.name === 'browser_open_tab')!.run({ url: 'https://b.com' }, ctx)
    expect(control.openTab).toHaveBeenCalledWith({ url: 'https://b.com' })
    await tools.find((t) => t.name === 'browser_switch_tab')!.run({ index: 1 }, ctx)
    expect(control.switchTab).toHaveBeenCalledWith({ index: 1 })
    await tools.find((t) => t.name === 'browser_close')!.run({}, ctx)
    expect(control.close).toHaveBeenCalledTimes(1)
  })

  it('browser_open_tab:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ openTab: vi.fn(async () => ({ ok: false, error: '新开标签页出错' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_open_tab')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('新开标签页出错')
  })

  it('browser_switch_tab:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ switchTab: vi.fn(async () => ({ ok: false, error: '标签页序号越界' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_switch_tab')!
    const r = await tool.run({ index: 9 }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('标签页序号越界')
  })

  it('browser_close:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ close: vi.fn(async () => ({ ok: false, error: '关闭出错' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_close')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('关闭出错')
  })
})
