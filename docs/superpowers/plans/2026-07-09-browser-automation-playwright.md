# 浏览器自动化(Playwright)工具集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一套基于 `playwright-core` 的浏览器专用自动化工具集(`browser_navigate`/`click`/`fill_text`/`read_text`/`screenshot`/`scroll`/`wait_for`/`list_tabs`/`open_tab`/`switch_tab`/`close`),与既有 `desktopControl`(OS 级鼠标键盘)、Firecrawl(一次性正文抓取)并存,支持独立实例(默认,隔离 profile)与 CDP 接管真实浏览器两种模式。

**Architecture:** `browserAutomation/browserLifecycle.ts`(纯函数,把 settings 转成启动配置)+ `browserAutomation/browserControl.ts`(状态管理与分支逻辑,依赖一个可注入的最小 `BrowserDriverFactory` 接口,单测用假驱动)+ `browserAutomation/playwrightDriver.ts`(真实 `playwright-core` 适配器,实现该接口,不单测,靠真机验收)+ `tools/browserTools.ts`(`ToolSpec` 包装层,单测注入假 `BrowserControl`)。浏览器实例是主进程单例、跨对话轮次存活(不同于每轮重置的 `screenshotState`)。

**Tech Stack:** TypeScript, Vitest,`playwright-core`(新增运行时依赖),Electron 主进程(不涉及 renderer 的浏览器驱动本身,仅设置 UI 触达 renderer)。

## Global Constraints

- 新增运行时依赖仅 `playwright-core`(不是完整 `playwright`,不下载额外 Chromium)。
- 独立实例模式:`channel:'chrome'` 复用已装浏览器,**不指定 `userDataDir`**(每次全新临时 profile,不持久化),`headless:false`(可见)。
- CDP 模式:`connectOverCDP` 连接用户已启动的调试端口;连接失败**不自动**关闭/重启用户浏览器,只给清晰报错+手动操作指引。
- 浏览器控制单例跨对话轮次存活,关闭时机 = `browser_close` 工具调用 / 设置开关关闭 / app 退出(`will-quit`)。
- 不做浮层可视化标识(不复用 `desktopControl` 的 `controlIndicator`/`toolIndicatorGate`)——可见的浏览器窗口本身就是反馈。
- 所有改动需配套 Vitest 单测(除真实 Playwright 驱动适配器本身,理由见设计文档 §7),遵循仓库现有测试文件的组织与断言风格(`toEqual`/`toContain` 为主,中文 `it()` 描述,注入假依赖测分支逻辑,同 `automation/automationControl.test.ts`/`tools/desktopTools.test.ts` 先例)。
- 设计文档:`docs/superpowers/specs/2026-07-09-browser-automation-playwright-design.md`(本计划的依据,如有疑义以其为准)。

---

### Task 1: 共享类型 + 设置(`BrowserControlSettings`、schemaVersion 8)

**Files:**
- Modify: `src/shared/llm.ts`(新增类型 + `AppSettings`/`DEFAULT_SETTINGS`/`SETTINGS_SCHEMA_VERSION`)
- Modify: `src/main/config/settings.ts`(`normalizeSettings` 新增 `browserControl` 归一化)
- Test: `src/main/config/settings.test.ts`(新增用例)

**Interfaces:**
- Produces: `BrowserControlMode = 'isolated' | 'cdp'`、`BrowserControlSettings { enabled: boolean; mode: BrowserControlMode }`,`AppSettings.browserControl`,供 Task 5(设置 UI)、Task 6(`chat.ts` 门控)使用。

- [ ] **Step 1: 写新增失败用例**

在 `src/main/config/settings.test.ts` 的 `describe('activePetId', ...)` 块之后新增:

```ts
describe('browserControl', () => {
  it('缺省 browserControl → 默认 enabled:false, mode:isolated', () => {
    const f = tmpSettingsFile({ schemaVersion: 7, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: false, mode: 'isolated' })
  })
  it('mode 值非法(不是 isolated/cdp)→ 回退 isolated', () => {
    const f = tmpSettingsFile({ browserControl: { enabled: true, mode: 'weird' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: true, mode: 'isolated' })
  })
  it('保留合法的 cdp 模式', () => {
    const f = tmpSettingsFile({ browserControl: { enabled: true, mode: 'cdp' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: true, mode: 'cdp' })
  })
  it('归一化后 schemaVersion 升为 8', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(8)
  })
})
```

同时把 `settings.test.ts:26` 的 round-trip 用例对象字面量补上 `browserControl: { enabled: false, mode: 'isolated' as const }` 字段(否则 `toEqual` 会因为 `loadSettings` 归一化后多出这个字段而失败)——该行整体改为:

```ts
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const } }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: 新增 4 个用例 FAIL(`browserControl` 字段目前不存在/`SETTINGS_SCHEMA_VERSION` 仍是 7),round-trip 用例因缺字段也 FAIL。

- [ ] **Step 3: 实现——`src/shared/llm.ts`**

在 `export interface DesktopControlSettings { enabled: boolean }`(约第 42 行)之后新增:

```ts
export type BrowserControlMode = 'isolated' | 'cdp'
export interface BrowserControlSettings { enabled: boolean; mode: BrowserControlMode }
```

`SETTINGS_SCHEMA_VERSION` 由 `7` 改为 `8`。

`AppSettings` 接口(约第 46 行)追加 `browserControl` 字段,整行改为:

```ts
export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings }
```

`DEFAULT_SETTINGS`(约第 48-57 行)追加一行,`desktopControl: { enabled: false }` 之后补:

```ts
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' }
```

- [ ] **Step 4: 实现——`src/main/config/settings.ts`**

`normalizeSettings` 里,`const dc = ...` / `const desktopControl = ...`(第 37-38 行)之后新增:

```ts
  const bc = (r.browserControl ?? {}) as Record<string, unknown>
  const browserControl = {
    enabled: bc.enabled === true,
    mode: bc.mode === 'cdp' ? 'cdp' as const : 'isolated' as const
  }
```

返回对象(第 39-49 行)的 `desktopControl` 之后追加 `browserControl`:

```ts
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl,
    browserControl
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 补齐另外两处硬编码 `AppSettings` 字面量的测试文件**

新增必填字段 `browserControl` 后,除了 Step 1 已经改过的 `settings.test.ts`,还有两处直接手写 `AppSettings` 字面量会因缺字段报 TS 错误:

`src/main/providers/embedder.test.ts:55-64` 的 `base(...)` 帮助函数,`desktopControl: { enabled: false }`(第 63 行)之后加一行:

```ts
    browserControl: { enabled: false, mode: 'isolated' }
```

`src/main/shell/chat.test.ts:12-21` 的模块级 `settings` 常量,`desktopControl: { enabled: false }`(第 20 行)之后加一行:

```ts
  browserControl: { enabled: false, mode: 'isolated' }
```

- [ ] **Step 7: 跑一遍全量单测 + typecheck,确认没有连带破坏其它文件**

Run: `pnpm typecheck && pnpm vitest run`
Expected: 全部 PASS。若 typecheck 仍报某处缺 `browserControl` 字段(说明代码库里还有本计划编写时没搜到的第三处硬编码字面量),按同样的方式补上 `browserControl: { enabled: false, mode: 'isolated' }` 再重新验证。

- [ ] **Step 8: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts
git commit -m "feat(settings): 新增 browserControl 设置项(schemaVersion 7→8)"
```

---

### Task 2: `browserAutomation/browserLifecycle.ts`(纯函数:settings → 启动配置)

**Files:**
- Create: `src/main/browserAutomation/browserLifecycle.ts`
- Test: `src/main/browserAutomation/browserLifecycle.test.ts`

**Interfaces:**
- Consumes: `BrowserControlSettings`(Task 1)。
- Produces: `LaunchPlan` 联合类型 + `resolveLaunchPlan(settings: Pick<BrowserControlSettings, 'mode'>, opts: { cdpPort?: number }): LaunchPlan`,供 Task 3 的 `browserControl.ts`/`playwrightDriver.ts` 使用。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { resolveLaunchPlan, DEFAULT_CDP_PORT } from './browserLifecycle'

describe('resolveLaunchPlan', () => {
  it('mode:isolated → isolated 计划,channel chrome,不指定 userDataDir', () => {
    const plan = resolveLaunchPlan({ mode: 'isolated' }, {})
    expect(plan).toEqual({ kind: 'isolated', channel: 'chrome', headless: false })
  })

  it('mode:cdp 未传端口 → 用默认端口 9222 拼出 endpoint', () => {
    const plan = resolveLaunchPlan({ mode: 'cdp' }, {})
    expect(plan).toEqual({ kind: 'cdp', endpointURL: `http://127.0.0.1:${DEFAULT_CDP_PORT}` })
  })

  it('mode:cdp 传自定义端口 → 拼进 endpoint', () => {
    const plan = resolveLaunchPlan({ mode: 'cdp' }, { cdpPort: 9333 })
    expect(plan).toEqual({ kind: 'cdp', endpointURL: 'http://127.0.0.1:9333' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/browserAutomation/browserLifecycle.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
import type { BrowserControlSettings } from '@shared/llm'

export const DEFAULT_CDP_PORT = 9222

export type LaunchPlan =
  | { kind: 'isolated'; channel: 'chrome'; headless: false }
  | { kind: 'cdp'; endpointURL: string }

export function resolveLaunchPlan(
  settings: Pick<BrowserControlSettings, 'mode'>,
  opts: { cdpPort?: number }
): LaunchPlan {
  if (settings.mode === 'cdp') {
    const port = opts.cdpPort ?? DEFAULT_CDP_PORT
    return { kind: 'cdp', endpointURL: `http://127.0.0.1:${port}` }
  }
  return { kind: 'isolated', channel: 'chrome', headless: false }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/browserAutomation/browserLifecycle.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/browserAutomation/browserLifecycle.ts src/main/browserAutomation/browserLifecycle.test.ts
git commit -m "feat(browser-automation): resolveLaunchPlan 纯函数(settings→启动配置)"
```

---

### Task 3: `browserAutomation/browserControl.ts` + `playwrightDriver.ts`

**Files:**
- Create: `src/main/browserAutomation/browserControl.ts`
- Create: `src/main/browserAutomation/playwrightDriver.ts`
- Test: `src/main/browserAutomation/browserControl.test.ts`

**Interfaces:**
- Consumes: `LaunchPlan`(Task 2)。
- Produces:
  - `BrowserControl` 接口(`navigate`/`click`/`fillText`/`readText`/`screenshot`/`scroll`/`waitFor`/`listTabs`/`openTab`/`switchTab`/`close`),供 Task 4 的 `tools/browserTools.ts` 消费。
  - `DriverPage`/`DriverBrowser`/`BrowserDriverFactory` 接口——`browserControl.ts` 只依赖这三个小接口,不直接依赖 `playwright-core` 的真实类型,测试注入假实现。
  - `createPlaywrightDriverFactory(): BrowserDriverFactory` —— `playwrightDriver.ts` 里对 `playwright-core` 的真实包装,`createBrowserControl` 生产环境默认注入它。

**这是本计划里最核心、风险最高的任务**,浏览器控制的所有状态管理与分支逻辑都在这里,务必按下面的接口定义实现,不要现场发明不同的方法名/字段名(下游 Task 4 会按这里定义的确切签名调用)。

- [ ] **Step 1: 定义并写下 `DriverPage`/`DriverBrowser`/`BrowserDriverFactory`(先写类型,不是测试,是为了让 Step 2 的假驱动有类型可循)**

创建 `src/main/browserAutomation/browserControl.ts`,先写入类型定义部分(完整文件见 Step 4,这里说明设计意图):`DriverPage` 是对 Playwright `Page` 的最小抽象(`goto`/`clickByText`/`clickBySelector`/`fillByLabel`/`innerText`/`screenshot`/`scroll`/`waitForText`/`title`/`url`/`close`),`DriverBrowser` 是对 `Browser`+当前 `BrowserContext` 的最小抽象(`pages`/`newPage`/`close`),`BrowserDriverFactory` 是对 `chromium.launch`/`chromium.connectOverCDP` 的抽象(`launch(plan)`)。`browserControl.ts` 只依赖这三个接口,真实 Playwright 细节全部关在 `playwrightDriver.ts` 里。

- [ ] **Step 2: 写失败测试(假驱动)**

创建 `src/main/browserAutomation/browserControl.test.ts`:

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/main/browserAutomation/browserControl.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 4: 实现 `browserControl.ts`**

```ts
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/browserAutomation/browserControl.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 实现真实驱动 `playwrightDriver.ts`(无测试,真机验收)**

```ts
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
      const browser = await chromium.launch({ channel: plan.channel, headless: plan.headless })
      const context = await browser.newContext()
      const page = await context.newPage()
      return wrapBrowser(browser, [page])
    }
  }
}
```

- [ ] **Step 7: 运行全量单测 + typecheck 确认没有破坏其它文件**

Run: `pnpm typecheck && pnpm vitest run`
Expected: 全部 PASS(此时 `playwright-core` 还未加进 `package.json`,如果 typecheck 报"找不到模块 playwright-core",先跳到 Task 7 把依赖装上再回来完成本任务的 typecheck 验证——两个任务之间允许这一次例外的顺序调整,因为类型声明必须要有真实包才能解析)。

- [ ] **Step 8: Commit**

```bash
git add src/main/browserAutomation/browserControl.ts src/main/browserAutomation/browserControl.test.ts src/main/browserAutomation/playwrightDriver.ts
git commit -m "feat(browser-automation): browserControl 状态机(可测)+ playwrightDriver 真实驱动适配器"
```

---

### Task 4: `tools/browserTools.ts`(11 个 `ToolSpec`)

**Files:**
- Create: `src/main/tools/browserTools.ts`
- Test: `src/main/tools/browserTools.test.ts`

**Interfaces:**
- Consumes: `BrowserControl`(Task 3)。
- Produces: `createBrowserTools(opts: { control: BrowserControl }): ToolSpec[]`,供 Task 6 的 `chat.ts` 接入。

- [ ] **Step 1: 写失败测试**

```ts
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

  it('browser_fill_text:透传 text/value', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_fill_text')!
    await tool.run({ text: '用户名', value: 'alice' }, ctx)
    expect(control.fillText).toHaveBeenCalledWith({ text: '用户名', value: 'alice' })
  })

  it('browser_read_text:返回正文', async () => {
    const control = fakeControl({ readText: vi.fn(async () => ({ ok: true, text: '一些正文' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_read_text')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('一些正文')
  })

  it('browser_screenshot:content+images 都有,images 透传 control 返回的 image', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_screenshot')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? undefined : r.images).toEqual([{ mimeType: 'image/jpeg', dataBase64: 'AAA' }])
  })

  it('browser_scroll:透传 direction/amount', async () => {
    const control = fakeControl()
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_scroll')!
    await tool.run({ direction: 'down', amount: 'small' }, ctx)
    expect(control.scroll).toHaveBeenCalledWith({ direction: 'down', amount: 'small' })
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

  it('browser_click:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ click: vi.fn(async () => ({ ok: false, error: '未找到元素' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_click')!
    const r = await tool.run({ text: '登录' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('未找到元素')
  })

  it('browser_fill_text:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ fillText: vi.fn(async () => ({ ok: false, error: '找不到输入框' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_fill_text')!
    const r = await tool.run({ text: '用户名', value: 'alice' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('找不到输入框')
  })

  it('browser_read_text:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ readText: vi.fn(async () => ({ ok: false, error: '页面未加载' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_read_text')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('页面未加载')
  })

  it('browser_screenshot:失败 → 返回纯字符串错误(不带 images)', async () => {
    const control = fakeControl({ screenshot: vi.fn(async () => ({ ok: false, error: '截图失败原因' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_screenshot')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('截图失败原因')
  })

  it('browser_scroll:失败 → 报错文案里带 error', async () => {
    const control = fakeControl({ scroll: vi.fn(async () => ({ ok: false, error: '滚动出错' })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_scroll')!
    const r = await tool.run({ direction: 'down' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('滚动出错')
  })

  it('browser_list_tabs:空列表 → 提示当前没有打开的标签页', async () => {
    const control = fakeControl({ listTabs: vi.fn(async () => ({ ok: true, tabs: [] })) })
    const tool = createBrowserTools({ control }).find((t) => t.name === 'browser_list_tabs')!
    const r = await tool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('当前没有打开的标签页')
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/tools/browserTools.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
import type { ToolSpec } from './toolSpec'
import type { BrowserControl } from '../browserAutomation/browserControl'

export function createBrowserTools(opts: { control: BrowserControl }): ToolSpec[] {
  const c = opts.control

  const navigate: ToolSpec = {
    name: 'browser_navigate',
    description: '让浏览器跳转到指定网址。首次调用会自动启动浏览器。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async (input) => {
      const { url } = input as { url: string }
      const r = await c.navigate(url)
      return r.ok ? `已跳转到:${url}` : `跳转失败:${r.error}`
    }
  }

  const click: ToolSpec = {
    name: 'browser_click',
    description: '按可见文字点击页面元素(按钮/链接等);不需要坐标。也可传 selector 用 CSS 选择器精确定位(高级用法)。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, selector: { type: 'string' } },
      required: ['text']
    },
    run: async (input) => {
      const { text, selector } = input as { text: string; selector?: string }
      const r = await c.click({ text, selector })
      return r.ok ? `已点击:${selector ?? text}` : `点击失败:${r.error}`
    }
  }

  const fillText: ToolSpec = {
    name: 'browser_fill_text',
    description: '按标签/占位符文字定位输入框并填入内容。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, value: { type: 'string' } }, required: ['text', 'value'] },
    run: async (input) => {
      const { text, value } = input as { text: string; value: string }
      const r = await c.fillText({ text, value })
      return r.ok ? `已在"${text}"填入内容` : `填写失败:${r.error}`
    }
  }

  const readText: ToolSpec = {
    name: 'browser_read_text',
    description: '读取当前页面可见正文,用于判断页面内容或验证操作结果。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.readText()
      return r.ok ? `页面正文:\n${r.text}` : `读取失败:${r.error}`
    }
  }

  const screenshot: ToolSpec = {
    name: 'browser_screenshot',
    description: '截取当前页面的画面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.screenshot()
      if (!r.ok || !r.image) return `截图失败:${r.error}`
      return { content: '已截取当前页面', images: [r.image] }
    }
  }

  const scroll: ToolSpec = {
    name: 'browser_scroll',
    description: '上下滚动当前页面。',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string' }, amount: { type: 'string' } },
      required: ['direction']
    },
    run: async (input) => {
      const { direction, amount } = input as { direction: 'up' | 'down'; amount?: 'page' | 'small' }
      const r = await c.scroll({ direction, amount })
      return r.ok ? `已${direction === 'down' ? '向下' : '向上'}滚动` : `滚动失败:${r.error}`
    }
  }

  const waitFor: ToolSpec = {
    name: 'browser_wait_for',
    description: '等待指定文字出现在页面上,应对页面动态加载;超时会报错。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (input) => {
      const { text } = input as { text: string }
      const r = await c.waitFor({ text })
      return r.ok ? `已等到:${text}` : `等待失败:${r.error}`
    }
  }

  const listTabs: ToolSpec = {
    name: 'browser_list_tabs',
    description: '列出当前打开的所有标签页(序号/标题/网址)。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.listTabs()
      if (!r.ok || !r.tabs) return `列出标签页失败:${r.error}`
      if (r.tabs.length === 0) return '当前没有打开的标签页'
      return `当前标签页:\n${r.tabs.map((t) => `[${t.index}] ${t.title} (${t.url})`).join('\n')}`
    }
  }

  const openTab: ToolSpec = {
    name: 'browser_open_tab',
    description: '新开一个标签页并设为当前操作对象,可选立即跳转到指定网址。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
    run: async (input) => {
      const { url } = input as { url?: string }
      const r = await c.openTab({ url })
      return r.ok ? '已新开标签页' : `新开标签页失败:${r.error}`
    }
  }

  const switchTab: ToolSpec = {
    name: 'browser_switch_tab',
    description: '把已有的某个标签页切为当前操作对象(序号来自 browser_list_tabs)。',
    inputSchema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
    run: async (input) => {
      const { index } = input as { index: number }
      const r = await c.switchTab({ index })
      return r.ok ? `已切换到标签页 [${index}]` : `切换失败:${r.error}`
    }
  }

  const close: ToolSpec = {
    name: 'browser_close',
    description: '主动结束本次浏览器自动化会话(关闭浏览器)。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.close()
      return r.ok ? '已关闭浏览器' : `关闭失败:${r.error}`
    }
  }

  return [navigate, click, fillText, readText, screenshot, scroll, waitFor, listTabs, openTab, switchTab, close]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/tools/browserTools.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/browserTools.ts src/main/tools/browserTools.test.ts
git commit -m "feat(browser-automation): browserTools 十一个 ToolSpec 包装"
```

---

### Task 5: IPC + preload + 设置 UI(开关 + 模式选择 + 两级风险确认)

**Files:**
- Modify: `src/shared/ipc.ts`(新增 IPC 常量 + `SettingsApi` 方法)
- Modify: `src/preload/index.ts`(暴露新方法)
- Modify: `src/main/shell/index.ts`(新增两个 `ipcMain.handle`)
- Modify: `src/renderer/settings.html`(新增 UI)
- Modify: `src/renderer/settings.ts`(新增交互逻辑)

**Interfaces:**
- Produces: `IPC.CONFIRM_BROWSER_CONTROL`/`IPC.CONFIRM_CDP_MODE`,`SettingsApi.confirmBrowserControl(): Promise<boolean>`/`confirmCdpMode(): Promise<boolean>`。

- [ ] **Step 1: `src/shared/ipc.ts` 新增 IPC 常量**

在 `CONFIRM_DESKTOP_CONTROL: 'settings:confirm-desktop-control',`(第 34 行)之后新增:

```ts
  CONFIRM_BROWSER_CONTROL: 'settings:confirm-browser-control',
  CONFIRM_CDP_MODE: 'settings:confirm-cdp-mode',
```

`SettingsApi` 接口(第 145-158 行)里 `confirmDesktopControl(): Promise<boolean>` 之后新增:

```ts
  confirmBrowserControl(): Promise<boolean>
  confirmCdpMode(): Promise<boolean>
```

- [ ] **Step 2: `src/preload/index.ts` 暴露新方法**

找到 `confirmDesktopControl: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_DESKTOP_CONTROL),`(第 66 行),之后新增:

```ts
  confirmBrowserControl: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_BROWSER_CONTROL),
  confirmCdpMode: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_CDP_MODE),
```

- [ ] **Step 3: `src/main/shell/index.ts` 新增两个 IPC handler**

找到 `ipcMain.handle(IPC.CONFIRM_DESKTOP_CONTROL, ...)` 整块(第 508-521 行),在其后(`ipcMain.on(IPC.OPEN_MEMORY_DIR, ...)` 之前)插入:

```ts
  ipcMain.handle(IPC.CONFIRM_BROWSER_CONTROL, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '确认开启'],
      defaultId: 0,
      cancelId: 0,
      title: '开启浏览器自动化风险提示',
      message: '开启后,AI 可以在对话中自主打开独立浏览器窗口浏览/操作网页(点击、填表、翻页)。',
      detail: '默认使用隔离的临时浏览器环境,不会用到你日常浏览器的登录状态;开启后随时可在设置里再次关闭。'
    }
    const result = parent ? await electronDialog.showMessageBox(parent, options) : await electronDialog.showMessageBox(options)
    return result.response === 1
  })
  ipcMain.handle(IPC.CONFIRM_CDP_MODE, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '确认切换'],
      defaultId: 0,
      cancelId: 0,
      title: '切换到「接管真实浏览器」风险提示',
      message: '这个模式会操作你已登录的真实浏览器账号与会话,风险高于默认的隔离浏览器模式。',
      detail: '需要目标浏览器已用调试参数启动;确认前请确保你了解这一模式的操作对象是你的真实浏览器。'
    }
    const result = parent ? await electronDialog.showMessageBox(parent, options) : await electronDialog.showMessageBox(options)
    return result.response === 1
  })
```

- [ ] **Step 4: `src/renderer/settings.html` 新增 UI**

找到 `desktopControlEnabled` 所在的风险区块(约第 103-110 行,`<div style="margin-top:14px;padding:10px;border:1px solid rgba(255,140,140,0.5)...">...</div>`),在其后(该 `</div>` 之后、`</section>` 之前)新增一个平行的风险区块:

```html
            <div style="margin-top:14px;padding:10px;border:1px solid rgba(255,140,140,0.5);border-radius:8px;background:rgba(255,80,80,0.08)">
              <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
                <input id="browserControlEnabled" type="checkbox" style="width:auto" />
                <span>允许宠物自主浏览/操作网页(高风险)</span>
              </label>
              <div class="hint" style="margin-top:6px">
                开启后 AI 可能自主打开浏览器窗口浏览网页、点击、填表。默认使用隔离的临时浏览器环境,
                不影响你日常浏览器的登录状态。默认关闭,开启前会再次弹窗确认。
              </div>
              <label id="browserControlModeRow" style="display:none;margin-top:8px">浏览器接管方式
                <select id="browserControlMode">
                  <option value="isolated">独立隔离浏览器(推荐,不影响你的真实浏览器)</option>
                  <option value="cdp">接管我正在用的真实浏览器(高风险,能用到已登录账号)</option>
                </select>
              </label>
            </div>
```

- [ ] **Step 5: `src/renderer/settings.ts` 新增交互逻辑**

在 `desktopControlEnabled.addEventListener('change', ...)` 块(第 76-82 行)之后新增:

```ts
const browserControlEnabled = $<HTMLInputElement>('browserControlEnabled')
const browserControlMode = $<HTMLSelectElement>('browserControlMode')
const browserControlModeRow = $<HTMLLabelElement>('browserControlModeRow')

function syncBrowserControlModeRow(): void {
  browserControlModeRow.style.display = browserControlEnabled.checked ? '' : 'none'
}
browserControlEnabled.addEventListener('change', () => {
  syncBrowserControlModeRow()
  if (!browserControlEnabled.checked) return
  void (async () => {
    const confirmed = await window.settingsApi.confirmBrowserControl()
    if (!confirmed) { browserControlEnabled.checked = false; syncBrowserControlModeRow(); return }
  })()
})
browserControlMode.addEventListener('change', () => {
  if (browserControlMode.value !== 'cdp') return
  void (async () => {
    const confirmed = await window.settingsApi.confirmCdpMode()
    if (!confirmed) browserControlMode.value = 'isolated'
  })()
})
```

在保存设置的对象字面量(第 160 行附近,`desktopControl: { enabled: desktopControlEnabled.checked }` 所在的 `settingsApi.setSettings(...)` 调用)里追加一行:

```ts
      browserControl: { enabled: browserControlEnabled.checked, mode: browserControlMode.value as 'isolated' | 'cdp' }
```

在回填快照的位置(第 196 行附近,`desktopControlEnabled.checked = snap.settings.desktopControl.enabled` 所在处)之后追加:

```ts
  browserControlEnabled.checked = snap.settings.browserControl.enabled
  browserControlMode.value = snap.settings.browserControl.mode
  syncBrowserControlModeRow()
```

- [ ] **Step 6: 运行 typecheck 确认无类型错误**

Run: `pnpm typecheck`
Expected: 通过(渲染层没有 Vitest 单测覆盖这类 DOM 交互,仿照 `desktopControlEnabled` 现有做法,靠 typecheck + 真机验收,不额外补渲染层单测)。

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(settings-ui): 浏览器自动化开关 + 模式选择 + 两级风险确认弹窗"
```

---

### Task 6: `chat.ts` 接入 + `shell/index.ts` 单例生命周期

**Files:**
- Modify: `src/main/shell/chat.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `createBrowserTools`(Task 4)、`createBrowserControl`+`createPlaywrightDriverFactory`(Task 3)、`settings.browserControl`(Task 1)。

- [ ] **Step 1: `chat.ts` 新增可选注入点**

`ChatStore` 工厂 `createChatStore` 的 `opts` 里,`buildDesktopTools`/`wrapDesktopTools` 字段(约第 62-65 行)之后新增:

```ts
  /** 浏览器自动化工具的真实构造器;未注入则该能力永不出现,与 settings 开关无关 */
  buildBrowserTools?: () => import('../tools/toolSpec').ToolSpec[]
```

`handleSend` 里 `if (settings.desktopControl.enabled && opts.buildDesktopTools) {...}` 块(约第 207-210 行)之后新增:

```ts
      if (settings.browserControl.enabled && opts.buildBrowserTools) {
        tools.push(...opts.buildBrowserTools())
      }
```

`maxToolRounds`/`maxOutputTokens` 那一行(约第 229-230 行)的判断条件从只看 `desktopControl.enabled` 扩成两者任一:

```ts
        const needsBiggerBudget = settings.desktopControl.enabled || settings.browserControl.enabled
```

并把 `maxToolRounds: settings.desktopControl.enabled ? 20 : undefined` 改为 `maxToolRounds: needsBiggerBudget ? 20 : undefined`,`maxOutputTokens: settings.desktopControl.enabled ? DESKTOP_CONTROL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS` 改为 `maxOutputTokens: needsBiggerBudget ? DESKTOP_CONTROL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS`(常量名不改,沿用既有命名,只是触发条件扩大——独立改名属于超出本任务范围的重命名,不做)。

- [ ] **Step 2: 扩展 `makeStore` 测试帮助函数支持注入 `buildBrowserTools`,并补回归用例**

`chat.test.ts` 里的 `makeStore` 签名(第 32-37 行)从:

```ts
function makeStore(
  provider: LlmProvider,
  seen: StreamChatRequest[],
  clip?: { readText?: () => string; writeText?: (t: string) => void },
  desktop?: { buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]; wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[] }
) {
```

改为(同一个 `desktop` 参数对象新增 `buildBrowserTools` 字段,不改参数名/参数个数):

```ts
function makeStore(
  provider: LlmProvider,
  seen: StreamChatRequest[],
  clip?: { readText?: () => string; writeText?: (t: string) => void },
  desktop?: {
    buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]
    wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[]
    buildBrowserTools?: () => import('../tools/toolSpec').ToolSpec[]
  }
) {
```

函数体内 `createChatStore({...})` 调用里,`buildDesktopTools: desktop?.buildDesktopTools,`(第 58 行)之后新增:

```ts
    buildBrowserTools: desktop?.buildBrowserTools,
```

然后在现有的 `desktopControl 开启时挂载...`/`desktopControl 关闭时不挂载...` 两个用例(第 163-187 行)所在的 `describe` 块内,紧随其后新增两个平行用例(照抄同样的 `settings.xxx = {...}` 直接赋值 + `await finished` 写法,`fakeDesktopTool` 帮助函数——第 158-161 行——直接复用,不用改名):

```ts
  it('browserControl 关闭时不挂载,即便注入了 buildBrowserTools', async () => {
    settings.browserControl = { enabled: false, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).not.toContain('browser_navigate')
  })

  it('browserControl 开启时挂载 buildBrowserTools 返回的工具', async () => {
    settings.browserControl = { enabled: true, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).toContain('browser_navigate')
    settings.browserControl = { enabled: false, mode: 'isolated' } // 复位
  })

  it('browserControl 开启时(即便 desktopControl 关闭)轮数上限也提升到 20,超过 6 轮的工具循环仍能继续', async () => {
    settings.browserControl = { enabled: true, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    const script: StreamChunk[][] = Array.from({ length: 10 }, (_, i) => [
      { type: 'tool_use' as const, toolUse: { id: `t${i}`, name: 'browser_navigate', input: {} } }
    ])
    script.push([{ type: 'text' as const, text: '看完了' }, { type: 'done' as const }])
    const { store, finished } = makeStore(createFakeProvider({ script }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: '帮我搜一下' })
    await finished
    const petMsgs = store.messages().filter((m) => m.role === 'pet')
    expect(petMsgs[petMsgs.length - 1]?.text).toBe('看完了') // 未被"轮数上限"错误打断
    settings.browserControl = { enabled: false, mode: 'isolated' } // 复位
  })
```

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: 全部 PASS。

- [ ] **Step 3: `shell/index.ts` 创建单例 + 接入 `createChatStore` + 退出清理**

顶部 import 区(第 7-13 行 automation 相关 import 附近)新增:

```ts
import { createBrowserControl } from '../browserAutomation/browserControl'
import { createPlaywrightDriverFactory } from '../browserAutomation/playwrightDriver'
import { createBrowserTools } from '../tools/browserTools'
```

在 `const automationControl = createAutomationControl({...})`(第 189-196 行)之后新增单例创建(浏览器控制不需要像 `automationWithTracking` 那样包裹追踪逻辑,也不需要 `controlIndicator`/`indicatorGate`,按设计文档 §4 不做浮层标识):

```ts
  const browserControl = createBrowserControl({
    driverFactory: createPlaywrightDriverFactory(),
    getSettings: () => loadSettings(settingsFile).browserControl
    // CDP 端口固定用默认值(9222),与设置 UI 上给用户的操作指引一致;不做成可配置项(YAGNI)
  })
```

`createChatStore({...})` 调用里,`buildDesktopTools`/`wrapDesktopTools` 字段(第 250-256 行)之后新增:

```ts
    buildBrowserTools: () => createBrowserTools({ control: browserControl }),
```

`app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop() })`(第 580 行)改为:

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close() })
```

- [ ] **Step 4: 运行全量单测 + typecheck**

Run: `pnpm typecheck && pnpm vitest run`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/chat.test.ts src/main/shell/index.ts
git commit -m "feat(browser-automation): chat.ts 门控接入 + shell 单例生命周期(will-quit 清理)"
```

---

### Task 7: 依赖 + 打包配置

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml`

**Interfaces:** 无(纯配置)。

- [ ] **Step 1: 加依赖**

```bash
pnpm add playwright-core
```

Run: `git diff package.json pnpm-lock.yaml | head -40` 确认 `playwright-core` 出现在 `dependencies`(不是 `devDependencies`)。

- [ ] **Step 2: 回头补完 Task 3 里被跳过的 typecheck 验证**

Run: `pnpm typecheck`
Expected: 通过(`playwright-core` 的类型声明现在能解析了)。

- [ ] **Step 3: `electron-builder.yml` 加 `asarUnpack`**

在 `files:` 块之后、`extraResources:` 块之前新增:

```yaml
asarUnpack:
  - '**/node_modules/playwright-core/**'
```

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm vitest run && pnpm build`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml electron-builder.yml
git commit -m "chore(deps): 新增 playwright-core 依赖 + asarUnpack 打包配置"
```

---

### Task 8(真机验证 + 打包冒烟,非自动化任务,人工执行)

自动化测试无法覆盖真实浏览器行为与打包产物。此任务不产出代码提交,只在实施完 Task 1-7 后,由人工在真实 Windows 环境下验证(对照设计文档 §7):

- [ ] **独立实例模式**:设置里开启开关(触发确认弹窗)→ 用一个多步任务("打开B站搜索XX并点第一个视频")让模型跑一遍 → 确认:浏览器窗口可见、每步是真实点击/导航而非坐标蒙猜、任务跨多轮对话时标签页状态保持、`browser_close` 后浏览器进程真的退出(任务管理器确认)、app 退出时没有孤儿浏览器进程残留。
- [ ] **CDP 模式**:按提示手动带调试参数重启 Chrome(如 `chrome.exe --remote-debugging-port=9222`)→ 切换模式触发额外强确认弹窗 → 确认能操作到真实已登录页面 → 目标浏览器未带调试参数时,报错文案和操作指引是否清晰可执行。
- [ ] **弱模型友好性**:用 gpt-5.4-mini 跑一遍"打开B站"这类任务,对比之前用 `desktopControl`(截图+坐标点击)时的成功率是否有提升。
- [ ] **打包产物冒烟**:`pnpm build` 后跑一次 NSIS 打包或至少检查 `dist/win-unpacked/`,确认浏览器自动化工具能在打包产物里正常触发(验证 Task 7 的 `asarUnpack` 配置生效,不是只在 `pnpm dev`/`pnpm preview` 下能跑)。
- [ ] 若真机验证发现新问题,回到 brainstorming 流程另开一轮设计,不在本计划内直接改代码。
