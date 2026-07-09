import { chromium, type Browser, type Page } from 'playwright-core'
import type { BrowserDriverFactory, DriverBrowser, DriverPage } from './browserControl'
import type { LaunchPlan } from './browserLifecycle'

function wrapPage(page: Page): DriverPage {
  return {
    goto: (url) => page.goto(url).then(() => undefined),
    clickByText: async (text) => { await page.getByText(text, { exact: false }).first().click({ timeout: 10000 }) },
    clickBySelector: async (selector) => { await page.locator(selector).first().click({ timeout: 10000 }) },
    fillByLabel: async (text, value) => {
      const byLabel = page.getByLabel(text, { exact: false })
      if (await byLabel.count() > 0) { await byLabel.first().fill(value); return }
      await page.getByPlaceholder(text, { exact: false }).first().fill(value)
    },
    innerText: () => page.locator('body').innerText(),
    screenshot: () => page.screenshot({ type: 'jpeg', quality: 70 }),
    scroll: (deltaY) => page.mouse.wheel(0, deltaY),
    waitForText: async (text, timeoutMs) => { await page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs }) },
    title: () => page.title(),
    url: () => page.url(),
    close: () => page.close()
  }
}

function wrapBrowser(browser: Browser, initialPages: Page[]): DriverBrowser {
  let pages = initialPages
  return {
    pages: () => pages.map(wrapPage),
    newPage: async (url) => {
      const context = browser.contexts()[0] ?? await browser.newContext()
      const page = await context.newPage()
      if (url) await page.goto(url)
      pages = [...pages, page]
      return wrapPage(page)
    },
    close: () => browser.close()
  }
}

export function createPlaywrightDriverFactory(): BrowserDriverFactory {
  return {
    async launch(plan: LaunchPlan): Promise<DriverBrowser> {
      if (plan.kind === 'cdp') {
        const browser = await chromium.connectOverCDP(plan.endpointURL)
        const context = browser.contexts()[0]
        const pages = context ? context.pages() : []
        return wrapBrowser(browser, pages.length > 0 ? pages : [await (context ?? await browser.newContext()).newPage()])
      }
      // executablePath(若设置)会让 Playwright 完全绕开 channel 的自动探测——该探测在
      // Windows 上优先检查 %LOCALAPPDATA%,一个损坏的 per-user Chrome 安装会因为"文件存在"
      // 就被选中(不检查能否真的启动),即便系统级安装是好的也会被绕过,见 browserLifecycle.ts。
      const browser = plan.executablePath
        ? await chromium.launch({ executablePath: plan.executablePath, headless: plan.headless })
        : await chromium.launch({ channel: plan.channel, headless: plan.headless })
      const context = await browser.newContext()
      const page = await context.newPage()
      return wrapBrowser(browser, [page])
    }
  }
}
