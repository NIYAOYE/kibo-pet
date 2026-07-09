import { describe, it, expect, vi } from 'vitest'
import { createBrowserControl } from './browserControl'
import type { BrowserDriverFactory, DriverBrowser, DriverPage } from './browserControl'

function fakePage(overrides: Partial<DriverPage> = {}): DriverPage {
  return {
    goto: vi.fn(async () => {}),
    clickByText: vi.fn(async () => {}),
    clickBySelector: vi.fn(async () => {}),
    fillByLabel: vi.fn(async () => {}),
    innerText: vi.fn(async () => '页面正文'),
    screenshot: vi.fn(async () => Buffer.from('AAA', 'utf-8')),
    scroll: vi.fn(async () => {}),
    waitForText: vi.fn(async () => {}),
    title: vi.fn(async () => '标题'),
    url: vi.fn(() => 'https://example.com'),
    close: vi.fn(async () => {}),
    ...overrides
  }
}

function fakeBrowser(pages: DriverPage[] = [fakePage()]): DriverBrowser {
  let list = pages
  return {
    pages: () => list,
    newPage: vi.fn(async (url?: string) => {
      const p = fakePage(url ? { url: () => url } : {})
      list = [...list, p]
      return p
    }),
    close: vi.fn(async () => {})
  }
}

function fakeFactory(browser: DriverBrowser): BrowserDriverFactory {
  return { launch: vi.fn(async () => browser) }
}

describe('createBrowserControl', () => {
  it('navigate:首次调用懒启动浏览器,goto 目标 URL', async () => {
    const page = fakePage()
    const browser = fakeBrowser([page])
    const factory = fakeFactory(browser)
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    const r = await control.navigate('https://bilibili.com')
    expect(r).toEqual({ ok: true })
    expect(page.goto).toHaveBeenCalledWith('https://bilibili.com')
    expect(factory.launch).toHaveBeenCalledTimes(1)
  })

  it('navigate 两次:第二次复用同一个浏览器,不重新 launch', async () => {
    const page = fakePage()
    const factory = fakeFactory(fakeBrowser([page]))
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    await control.navigate('https://b.com')
    expect(factory.launch).toHaveBeenCalledTimes(1)
    expect(page.goto).toHaveBeenCalledTimes(2)
  })

  it('click:传 text → 走 clickByText;传 selector → 走 clickBySelector,忽略 text', async () => {
    const page = fakePage()
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    await control.click({ text: '登录' })
    expect(page.clickByText).toHaveBeenCalledWith('登录')
    await control.click({ text: '登录', selector: '#submit' })
    expect(page.clickBySelector).toHaveBeenCalledWith('#submit')
  })

  it('click 找不到元素(driver 抛错) → ok:false 带 error,不崩溃', async () => {
    const page = fakePage({ clickByText: vi.fn(async () => { throw new Error('未找到元素') }) })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.click({ text: '不存在的按钮' })
    expect(r).toEqual({ ok: false, error: '未找到元素' })
  })

  it('还没 navigate 过就调用 click:自动懒启动浏览器(空白页)而不是报错', async () => {
    const page = fakePage()
    const factory = fakeFactory(fakeBrowser([page]))
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    const r = await control.click({ text: 'x' })
    expect(factory.launch).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
  })

  it('readText:返回 innerText 结果', async () => {
    const page = fakePage({ innerText: vi.fn(async () => '一些正文') })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    expect(await control.readText()).toEqual({ ok: true, text: '一些正文' })
  })

  it('screenshot:返回 base64 编码的 image', async () => {
    const page = fakePage({ screenshot: vi.fn(async () => Buffer.from('hello')) })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.screenshot()
    expect(r.ok).toBe(true)
    expect(r.image).toEqual({ mimeType: 'image/jpeg', dataBase64: Buffer.from('hello').toString('base64') })
  })

  it('scroll:down → 传正的 deltaY;up → 传负的', async () => {
    const page = fakePage()
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    await control.scroll({ direction: 'down' })
    expect((page.scroll as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeGreaterThan(0)
    await control.scroll({ direction: 'up' })
    expect((page.scroll as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBeLessThan(0)
  })

  it('waitFor 超时(driver 抛错)→ ok:false 带 error,不挂起', async () => {
    const page = fakePage({ waitForText: vi.fn(async () => { throw new Error('等待超时') }) })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.waitFor({ text: '不会出现的文字' })
    expect(r).toEqual({ ok: false, error: '等待超时' })
  })

  it('listTabs:列出所有页面的 index/title/url', async () => {
    const p1 = fakePage({ title: vi.fn(async () => 'A'), url: () => 'https://a.com' })
    const p2 = fakePage({ title: vi.fn(async () => 'B'), url: () => 'https://b.com' })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([p1, p2])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.listTabs()
    expect(r).toEqual({ ok: true, tabs: [{ index: 0, title: 'A', url: 'https://a.com' }, { index: 1, title: 'B', url: 'https://b.com' }] })
  })

  it('openTab 后活动标签页切到新页;switchTab 能切回旧的', async () => {
    const p1 = fakePage()
    const browser = fakeBrowser([p1])
    const control = createBrowserControl({ driverFactory: fakeFactory(browser), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    await control.openTab({ url: 'https://b.com' })
    let tabs = await control.listTabs()
    expect(tabs.tabs).toHaveLength(2)
    await control.click({ text: 'x' }) // 作用于新标签页(第 2 个 fakePage,url() 返回 https://b.com)
    expect((browser.pages()[1].clickByText as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    await control.switchTab({ index: 0 })
    await control.click({ text: 'y' })
    expect((p1.clickByText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('y')
  })

  it('switchTab 传越界 index → ok:false', async () => {
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([fakePage()])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.switchTab({ index: 9 })
    expect(r.ok).toBe(false)
  })

  it('close:关闭浏览器,之后任何调用都报"浏览器已关闭"且能重新懒启动', async () => {
    const browser = fakeBrowser([fakePage()])
    const factory = fakeFactory(browser)
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    await control.close()
    expect(browser.close).toHaveBeenCalledTimes(1)
    const r = await control.navigate('https://b.com')
    expect(r.ok).toBe(true)
    expect(factory.launch).toHaveBeenCalledTimes(2) // 重新懒启动了一次新的
  })

  it('launch 本身失败(driver 抛错)→ 每个方法都优雅返回 ok:false,不抛未捕获异常', async () => {
    const factory: BrowserDriverFactory = { launch: vi.fn(async () => { throw new Error('找不到 Chrome') }) }
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    const r = await control.navigate('https://a.com')
    expect(r).toEqual({ ok: false, error: '找不到 Chrome' })
  })
})
