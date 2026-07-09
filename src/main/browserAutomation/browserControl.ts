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

export interface BrowserActionResult { ok: boolean; error?: string }
export interface BrowserReadResult { ok: boolean; text?: string; error?: string }
export interface BrowserScreenshotResult { ok: boolean; image?: ImagePart; error?: string }
export interface TabInfo { index: number; title: string; url: string }
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

function errMsg(e: unknown): string { return String((e as Error)?.message ?? e) }

export function createBrowserControl(opts: {
  driverFactory: BrowserDriverFactory
  /** 每次懒启动时都重新读取(同 chat.ts 的 loadSettings() 用法),而不是构造时快照一份——
   *  否则用户在设置里切换模式(独立实例↔CDP)在浏览器还没重新懒启动前不会生效,行为会跟
   *  其它设置项(如 desktopControl.enabled)不一致,让人以为改了没生效。 */
  getSettings: () => Pick<BrowserControlSettings, 'mode'>
  cdpPort?: number
}): BrowserControl {
  let browser: DriverBrowser | null = null
  let activeIndex = 0

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

  async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: errMsg(e) } }
  }

  return {
    async navigate(url) {
      const r = await guard(async () => { const p = await activePage(); await p.goto(url) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async click(input) {
      const r = await guard(async () => {
        const p = await activePage()
        if (input.selector) return p.clickBySelector(input.selector)
        return p.clickByText(input.text)
      })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async fillText(input) {
      const r = await guard(async () => { const p = await activePage(); await p.fillByLabel(input.text, input.value) })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async readText() {
      const r = await guard(async () => { const p = await activePage(); return p.innerText() })
      return r.ok ? { ok: true, text: r.value } : { ok: false, error: r.error }
    },
    async screenshot() {
      const r = await guard(async () => { const p = await activePage(); return p.screenshot() })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, image: { mimeType: 'image/jpeg', dataBase64: r.value.toString('base64') } }
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
        return Promise.all(pages.map(async (p, index) => ({ index, title: await p.title(), url: p.url() })))
      })
      return r.ok ? { ok: true, tabs: r.value } : { ok: false, error: r.error }
    },
    async openTab(input) {
      const r = await guard(async () => {
        const b = await ensureBrowser()
        await b.newPage(input.url)
        activeIndex = b.pages().length - 1
      })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async switchTab(input) {
      const b = await ensureBrowser()
      const pages = b.pages()
      if (input.index < 0 || input.index >= pages.length) return { ok: false, error: `标签页序号越界:${input.index}(当前共 ${pages.length} 个)` }
      activeIndex = input.index
      return { ok: true }
    },
    async close() {
      const r = await guard(async () => { if (browser) await browser.close() })
      browser = null
      activeIndex = 0
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  }
}
