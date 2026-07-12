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

  it('navigate 非 http(s)(file:///)被拒绝,不启动浏览器也不 goto', async () => {
    const page = fakePage()
    const factory = fakeFactory(fakeBrowser([page]))
    const control = createBrowserControl({ driverFactory: factory, getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    const r = await control.navigate('file:///C:/Windows/win.ini')
    expect(r.ok).toBe(false)
    expect(factory.launch).not.toHaveBeenCalled()
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('openTab 传非 http(s) 网址被拒绝,不新开标签页', async () => {
    const browser = fakeBrowser([fakePage()])
    const control = createBrowserControl({ driverFactory: fakeFactory(browser), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    const r = await control.openTab({ url: 'file:///etc/passwd' })
    expect(r.ok).toBe(false)
    expect(browser.newPage).not.toHaveBeenCalled()
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

  it('click 触发页面跳转导致 "Execution context was destroyed"(Playwright 已知误报)→ 当成成功,不是失败', async () => {
    // 真机复现:点一个搜索结果链接,点击本身触发了跳转,但 Playwright 的 click() 因为
    // 执行上下文在跳转过程中被销毁而报错——这基本总是意味着点击其实生效了(跳转发生了),
    // 不应该当成真失败让模型误以为点击没生效,浪费一轮去"换路线重试"。
    const page = fakePage({ clickByText: vi.fn(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.') }) })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([page])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.click({ text: '第一条搜索结果' })
    expect(r).toEqual({ ok: true })
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
    const r = await control.readText()
    expect(r.ok).toBe(true)
    expect(r.text).toBe('一些正文')
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

  it('listTabs:列出所有页面的 index/title/url,并标记当前活动页', async () => {
    const p1 = fakePage({ title: vi.fn(async () => 'A'), url: () => 'https://a.com' })
    const p2 = fakePage({ title: vi.fn(async () => 'B'), url: () => 'https://b.com' })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([p1, p2])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.listTabs()
    expect(r).toEqual({
      ok: true,
      tabs: [
        { index: 0, title: 'A', url: 'https://a.com', active: true },
        { index: 1, title: 'B', url: 'https://b.com', active: false }
      ]
    })
  })

  it('openTab 去重:目标网址已在某个标签页打开 → 切换过去而不是重复新开', async () => {
    // 真机复现:模型撞上登录墙后重跑"打开首页"流程,同一网址被开了两次
    const home = fakePage({ url: () => 'https://www.bilibili.com/' })
    const browser = fakeBrowser([home])
    const control = createBrowserControl({ driverFactory: fakeFactory(browser), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://www.bilibili.com/')
    const r = await control.openTab({ url: 'https://www.bilibili.com' }) // 差一个尾斜杠也该视为同一网址
    expect(r.ok).toBe(true)
    expect(r.note).toContain('已')
    expect(browser.newPage).not.toHaveBeenCalled()
    expect(browser.pages()).toHaveLength(1)
  })

  it('openTab 目标网址未打开:照常新开', async () => {
    const home = fakePage({ url: () => 'https://a.com' })
    const browser = fakeBrowser([home])
    const control = createBrowserControl({ driverFactory: fakeFactory(browser), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const r = await control.openTab({ url: 'https://b.com' })
    expect(r.ok).toBe(true)
    expect(browser.newPage).toHaveBeenCalledTimes(1)
  })

  it('readText/screenshot 携带当前标签页上下文(第几页/共几页/网址)', async () => {
    const p1 = fakePage({ title: vi.fn(async () => 'A'), url: () => 'https://a.com', innerText: vi.fn(async () => '正文A') })
    const p2 = fakePage({ title: vi.fn(async () => 'B'), url: () => 'https://b.com' })
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([p1, p2])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com')
    const rt = await control.readText()
    expect(rt.tab).toEqual({ index: 0, count: 2, title: 'A', url: 'https://a.com' })
    const rs = await control.screenshot()
    expect(rs.tab).toEqual({ index: 0, count: 2, title: 'A', url: 'https://a.com' })
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

  it('点击后网站自己开了新标签页(target=_blank):自动切换过去并在结果里说明', async () => {
    // 真机复现(B 站):点视频卡片→新标签页由网站打开→旧实现的 activeIndex 停在首页,
    // 截图/读文本全是旧页,模型误判"点击没生效"反复重试,开出一堆重复标签页。
    const videoPage = fakePage({ innerText: vi.fn(async () => '视频播放页正文'), url: () => 'https://b.com/video' })
    let list: DriverPage[] = []
    const home = fakePage({
      innerText: vi.fn(async () => '首页正文'),
      clickByText: vi.fn(async () => { list.push(videoPage) }) // 模拟网站开新标签
    })
    list = [home]
    const browser: DriverBrowser = {
      pages: () => list,
      newPage: vi.fn(async () => { const p = fakePage(); list.push(p); return p }),
      close: vi.fn(async () => {})
    }
    const control = createBrowserControl({
      driverFactory: fakeFactory(browser),
      getSettings: () => ({ enabled: true, mode: 'isolated' }),
      newTabSettleMs: 0
    })
    await control.navigate('https://a.com')
    const r = await control.click({ text: '视频卡片' })
    expect(r.ok).toBe(true)
    expect(r.note).toContain('新')
    const rt = await control.readText()
    expect(rt.ok).toBe(true)
    expect(rt.text).toBe('视频播放页正文')
  })

  it('点击没有开新标签页:不切换、结果不带 note', async () => {
    const page = fakePage()
    const control = createBrowserControl({
      driverFactory: fakeFactory(fakeBrowser([page])),
      getSettings: () => ({ enabled: true, mode: 'isolated' }),
      newTabSettleMs: 0
    })
    await control.navigate('https://a.com')
    const r = await control.click({ text: '普通按钮' })
    expect(r).toEqual({ ok: true })
  })

  it('switchTab 传越界 index → ok:false,且不破坏当前活动标签页', async () => {
    const p0 = fakePage()
    const p1 = fakePage()
    const control = createBrowserControl({ driverFactory: fakeFactory(fakeBrowser([p0, p1])), getSettings: () => ({ enabled: true, mode: 'isolated' }) })
    await control.navigate('https://a.com') // activeIndex = 0
    const r = await control.switchTab({ index: 9 }) // 越界,应该是 no-op
    expect(r.ok).toBe(false)
    await control.click({ text: 'y' })
    expect(p0.clickByText).toHaveBeenCalledWith('y') // 若 activeIndex 被越界值污染,会落到 p1 上,断言失败
    expect(p1.clickByText).not.toHaveBeenCalled()
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
