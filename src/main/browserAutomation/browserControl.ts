import type { ImagePart } from '@shared/llm'
import type { BrowserControlSettings } from '@shared/llm'
import { resolveLaunchPlan, type LaunchPlan } from './browserLifecycle'

export interface DriverPage {
  goto(url: string): Promise<void>
  clickByText(text: string): Promise<void>
  clickBySelector(selector: string): Promise<void>
  fillByLabel(text: string, value: string): Promise<void>
  innerText(): Promise<string>
  screenshot(): Promise<Buffer>
  scroll(deltaY: number): Promise<void>
  waitForText(text: string, timeoutMs: number): Promise<void>
  title(): Promise<string>
  url(): string
  close(): Promise<void>
}

export interface DriverBrowser {
  pages(): DriverPage[]
  newPage(url?: string): Promise<DriverPage>
  close(): Promise<void>
}

export interface BrowserDriverFactory {
  launch(plan: LaunchPlan): Promise<DriverBrowser>
}

/** note:动作成功但有模型必须知道的副作用说明(如"点击开出了新标签页,已自动切换") */
export interface BrowserActionResult { ok: boolean; error?: string; note?: string }
/** tab:观察结果所属的标签页上下文——模型每次"看"都自带方位感,防止感知漂移后连错多轮 */
export interface TabContext { index: number; count: number; title: string; url: string }
export interface BrowserReadResult { ok: boolean; text?: string; error?: string; tab?: TabContext }
export interface BrowserScreenshotResult { ok: boolean; image?: ImagePart; error?: string; tab?: TabContext }
export interface TabInfo { index: number; title: string; url: string; active: boolean }
export interface BrowserListTabsResult { ok: boolean; tabs?: TabInfo[]; error?: string }

export interface BrowserControl {
  navigate(url: string): Promise<BrowserActionResult>
  click(input: { text: string; selector?: string }): Promise<BrowserActionResult>
  fillText(input: { text: string; value: string }): Promise<BrowserActionResult>
  readText(): Promise<BrowserReadResult>
  screenshot(): Promise<BrowserScreenshotResult>
  scroll(input: { direction: 'up' | 'down'; amount?: 'page' | 'small' }): Promise<BrowserActionResult>
  waitFor(input: { text: string }): Promise<BrowserActionResult>
  listTabs(): Promise<BrowserListTabsResult>
  openTab(input: { url?: string }): Promise<BrowserActionResult>
  switchTab(input: { index: number }): Promise<BrowserActionResult>
  close(): Promise<BrowserActionResult>
}

const WAIT_TIMEOUT_MS = 10000
const SCROLL_DELTA = { page: 800, small: 200 }
/** 点击后最多等这么久观察有没有新标签页(每 100ms 轮询、发现即早退):
 *  target=_blank 的新页创建略滞后于 click 返回,固定单次检查真机漏检过 */
const NEW_TAB_SETTLE_MS = 800
const NEW_TAB_POLL_MS = 100

function errMsg(e: unknown): string { return String((e as Error)?.message ?? e) }

/** 网址等价判定(去重用):忽略首尾空白与尾斜杠差异,大小写不敏感 */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 只放行 http(s):否则模型可用 file:///、about:、data: 等把浏览器导航到本地文件再用
 *  browser_read_text 读回,越过"网页浏览"这个功能设定读到本地敏感内容。 */
function isAllowedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

export function createBrowserControl(opts: {
  driverFactory: BrowserDriverFactory
  /** 每次懒启动时都重新读取(同 chat.ts 的 loadSettings() 用法),而不是构造时快照一份——
   *  否则用户在设置里切换模式(独立实例↔CDP)在浏览器还没重新懒启动前不会生效,行为会跟
   *  其它设置项(如 desktopControl.enabled)不一致,让人以为改了没生效。 */
  getSettings: () => Pick<BrowserControlSettings, 'mode' | 'chromePath'>
  cdpPort?: number
  /** 测试注入缝:点击后等待新标签页出现的时长 */
  newTabSettleMs?: number
}): BrowserControl {
  let browser: DriverBrowser | null = null
  let activeIndex = 0
  const settleMs = opts.newTabSettleMs ?? NEW_TAB_SETTLE_MS

  async function ensureBrowser(): Promise<DriverBrowser> {
    if (browser) return browser
    const plan = resolveLaunchPlan(opts.getSettings(), { cdpPort: opts.cdpPort })
    browser = await opts.driverFactory.launch(plan)
    activeIndex = 0
    return browser
  }

  async function activePage(): Promise<DriverPage> {
    const b = await ensureBrowser()
    const pages = b.pages()
    if (pages.length === 0) return b.newPage()
    return pages[Math.min(activeIndex, pages.length - 1)]
  }

  async function activeTabContext(): Promise<TabContext> {
    const b = await ensureBrowser()
    const pages = b.pages()
    const index = Math.min(activeIndex, Math.max(pages.length - 1, 0))
    const p = pages[index]
    return { index, count: pages.length, title: p ? await p.title() : '', url: p ? p.url() : '' }
  }

  async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: errMsg(e) } }
  }

  return {
    async navigate(url) {
      if (!isAllowedUrl(url)) return { ok: false, error: `只能访问 http/https 网址,拒绝导航到:${url}` }
      const r = await guard(async () => { const p = await activePage(); await p.goto(url) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async click(input) {
      const pagesBefore = browser ? browser.pages().length : 0
      const r = await guard(async () => {
        const p = await activePage()
        if (input.selector) return p.clickBySelector(input.selector)
        return p.clickByText(input.text)
      })
      // "Execution context was destroyed, most likely because of a navigation." 是 Playwright
      // 点击触发页面跳转时的已知误报:执行上下文在跳转过程中被销毁导致 click() 本身报错,
      // 但这基本总是意味着点击其实生效了(跳转确实发生了)。当成失败会让模型误以为没点中,
      // 浪费一整轮去"换个地方重试",真机验收复现过这个浪费轮次的模式。
      const clicked = r.ok || r.error.includes('Execution context was destroyed')
      if (!clicked) return { ok: false, error: r.ok ? undefined : r.error }
      // 点击的常见副作用:网站用 target=_blank 自开新标签页(真机复现:B 站视频卡片)。
      // 不自动跟过去的话,截图/读文本全停留在旧页,模型会误判"点击没生效"反复重试。
      // 轮询早退:开了新页的点击几乎立刻返回,没开的最多多等 settleMs。
      const deadline = Date.now() + settleMs
      let pagesAfter = browser ? browser.pages().length : 0
      while (pagesAfter <= pagesBefore && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, NEW_TAB_POLL_MS))
        pagesAfter = browser ? browser.pages().length : 0
      }
      if (pagesAfter > pagesBefore) {
        activeIndex = pagesAfter - 1
        return { ok: true, note: '点击后网站新开了标签页,已自动切换到新标签页;请重新截图/读取以查看新页面内容' }
      }
      return { ok: true }
    },
    async fillText(input) {
      const r = await guard(async () => { const p = await activePage(); await p.fillByLabel(input.text, input.value) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async readText() {
      const r = await guard(async () => {
        const p = await activePage()
        return { text: await p.innerText(), tab: await activeTabContext() }
      })
      return r.ok ? { ok: true, text: r.value.text, tab: r.value.tab } : { ok: false, error: r.error }
    },
    async screenshot() {
      const r = await guard(async () => {
        const p = await activePage()
        return { shot: await p.screenshot(), tab: await activeTabContext() }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, image: { mimeType: 'image/jpeg', dataBase64: r.value.shot.toString('base64') }, tab: r.value.tab }
    },
    async scroll(input) {
      const magnitude = SCROLL_DELTA[input.amount ?? 'page']
      const deltaY = input.direction === 'down' ? magnitude : -magnitude
      const r = await guard(async () => { const p = await activePage(); await p.scroll(deltaY) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async waitFor(input) {
      const r = await guard(async () => { const p = await activePage(); await p.waitForText(input.text, WAIT_TIMEOUT_MS) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async listTabs() {
      const r = await guard(async () => {
        const b = await ensureBrowser()
        const pages = b.pages()
        const active = Math.min(activeIndex, Math.max(pages.length - 1, 0))
        return Promise.all(pages.map(async (p, index) => ({ index, title: await p.title(), url: p.url(), active: index === active })))
      })
      return r.ok ? { ok: true, tabs: r.value } : { ok: false, error: r.error }
    },
    async openTab(input) {
      if (input.url !== undefined && !isAllowedUrl(input.url)) {
        return { ok: false, error: `只能访问 http/https 网址,拒绝打开:${input.url}` }
      }
      const r = await guard(async () => {
        const b = await ensureBrowser()
        // 去重:目标网址已开着就切过去。真机复现:模型撞上登录墙后重跑"打开首页"
        // 流程,同一网址被开了两次;对模型而言"打开 X"的意图本就是"让 X 可操作"。
        if (input.url !== undefined) {
          const existing = b.pages().findIndex((p) => sameUrl(p.url(), input.url!))
          if (existing >= 0) {
            activeIndex = existing
            return `该网址已在标签页 [${existing}] 打开,已切换过去,没有重复新开`
          }
        }
        await b.newPage(input.url)
        activeIndex = b.pages().length - 1
        return undefined
      })
      if (!r.ok) return { ok: false, error: r.error }
      return r.value ? { ok: true, note: r.value } : { ok: true }
    },
    async switchTab(input) {
      const r = await guard(async () => {
        const b = await ensureBrowser()
        const pages = b.pages()
        if (input.index < 0 || input.index >= pages.length) throw new Error(`标签页序号越界:${input.index}(当前共 ${pages.length} 个)`)
        activeIndex = input.index
      })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async close() {
      const r = await guard(async () => { if (browser) await browser.close() })
      browser = null
      activeIndex = 0
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  }
}
