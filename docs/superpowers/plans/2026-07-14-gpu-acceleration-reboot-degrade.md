# GPU 硬件加速"重启降级"机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `app.disableHardwareAcceleration()` 从"全局硬编码禁用"改成"默认仍禁用，用户可在设置里勾选实验性开关主动尝试硬件加速；一旦这次启动没能撑到窗口正常渲染，下次启动自动强制降级回软件渲染并关闭该开关"，为后续 Live2D(WebGL) 集成铺路，同时保证不勾选开关的用户行为与今天完全一致。

**Architecture:** 新增一个纯决策函数 `decideGpuBoot()`（给定"用户是否想试硬件加速"+"上次启动的标记文件是否还在"，算出这次该不该用硬件加速、该不该写/清标记文件）；`main/index.ts` 在 `app.whenReady()` 之前用这个函数做决策，标记文件存在 `userData` 下，用户意愿存在 `settings.json` 的新字段 `gpuAcceleration.experimental` 里；确认"这次启动成功"用 Electron 全局事件 `app.on('browser-window-created', ...)` 挂在首个窗口的 `did-finish-load` 上，不需要改动 `startShell()`。

**Tech Stack:** Electron + TypeScript，沿用项目现有 pnpm/Vitest 工具链，不引入新依赖。

## Global Constraints

- 不勾选新设置项的用户，行为必须与改动前完全一致：无条件 `app.disableHardwareAcceleration()`，不产生任何标记文件，不多读任何多余的文件。
- 任何读取 `userData`/`settings.json`/标记文件的新增逻辑都必须包在 try/catch 里；失败时一律退回"不使用硬件加速"这个安全默认值，只记日志，绝不能让新逻辑本身的异常导致启动失败或行为比今天更差。
- `app.disableHardwareAcceleration()` 的调用（或不调用）必须发生在 `app.whenReady()` 之前——这是 Electron 的硬性要求，本次改动不能破坏这个时序。
- 不修改 `src/main/shell/index.ts` 的 `startShell()` 函数签名或内部逻辑。
- 新设置项默认 `false`，勾选后需要重启才能生效——不做热切换，UI 上直接在 checkbox 文案里注明"重启后生效"，参照现有 `当前宠物(重启后生效)` 的措辞习惯，不新增专门的重启提示横幅逻辑。
- `SETTINGS_SCHEMA_VERSION` 从 13 bump 到 14。

---

### Task 1: 纯逻辑——GPU 启动决策函数

**Files:**
- Create: `src/shared/gpuBootDecision.ts`
- Test: `src/shared/gpuBootDecision.test.ts`

**Interfaces:**
- Produces: `export interface GpuBootDecision { useHardwareAcceleration: boolean; markerAction: 'write' | 'clear-and-disable-setting' | 'none' }`；`export function decideGpuBoot(opts: { experimentalHardwareAcceleration: boolean; markerPresent: boolean }): GpuBootDecision`。Task 3 会调用它做主进程启动决策。

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/gpuBootDecision.test.ts
import { describe, it, expect } from 'vitest'
import { decideGpuBoot } from './gpuBootDecision'

describe('decideGpuBoot', () => {
  it('实验开关关闭 -> 不用硬件加速,不碰标记文件', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: false, markerPresent: false })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'none' })
  })

  it('实验开关关闭,即使标记文件残留也不管(开关本身就是唯一开关)', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: false, markerPresent: true })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'none' })
  })

  it('实验开关开启且无残留标记 -> 尝试硬件加速并写标记', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: true, markerPresent: false })
    expect(d).toEqual({ useHardwareAcceleration: true, markerAction: 'write' })
  })

  it('实验开关开启且标记残留(上次启动没能清掉) -> 强制降级+清标记+关开关', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: true, markerPresent: true })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'clear-and-disable-setting' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/gpuBootDecision.test.ts`
Expected: FAIL，报 `Cannot find module './gpuBootDecision'` 或类似的"模块不存在"错误。

- [ ] **Step 3: 写最小实现**

```ts
// src/shared/gpuBootDecision.ts
export interface GpuBootDecision {
  useHardwareAcceleration: boolean
  markerAction: 'write' | 'clear-and-disable-setting' | 'none'
}

export function decideGpuBoot(opts: {
  experimentalHardwareAcceleration: boolean
  markerPresent: boolean
}): GpuBootDecision {
  if (!opts.experimentalHardwareAcceleration) {
    return { useHardwareAcceleration: false, markerAction: 'none' }
  }
  if (opts.markerPresent) {
    return { useHardwareAcceleration: false, markerAction: 'clear-and-disable-setting' }
  }
  return { useHardwareAcceleration: true, markerAction: 'write' }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/gpuBootDecision.test.ts`
Expected: PASS，4 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/shared/gpuBootDecision.ts src/shared/gpuBootDecision.test.ts
git commit -m "test(gpu-accel): 新增 GPU 启动决策纯函数 decideGpuBoot"
```

---

### Task 2: 设置 schema——新增 `gpuAcceleration` 字段

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify: `src/main/config/settings.test.ts`
- Modify: `src/main/providers/embedder.test.ts`
- Modify: `src/main/shell/chat.test.ts`

**Interfaces:**
- Consumes: 无新接口，是对既有 `AppSettings`/`normalizeSettings`/`DEFAULT_SETTINGS` 的扩展。
- Produces: `export interface GpuAccelerationSettings { experimental: boolean }`（`src/shared/llm.ts`），`AppSettings.gpuAcceleration: GpuAccelerationSettings`，`DEFAULT_SETTINGS.gpuAcceleration = { experimental: false }`。Task 3、Task 4 都会用到 `settings.gpuAcceleration.experimental`。

这个任务本身没有新的复杂逻辑——`normalizeSettings()` 的写法完全照抄现有 `appFocusLlmOpener` 字段的处理方式（防御式解析：非 `true` 一律回退 `false`）。因为 `AppSettings` 是一个要求所有字段都存在的接口，`src/main/providers/embedder.test.ts` 和 `src/main/shell/chat.test.ts` 里各有一处手写的完整 `AppSettings` 字面量（不是通过 `DEFAULT_SETTINGS` 展开的），新增必填字段后这两处会编译报错，必须同步补上，否则 `pnpm typecheck` 会失败。

- [ ] **Step 1: `src/shared/llm.ts` 新增类型 + 默认值 + 字段 + bump 版本号**

在 `export interface AppFocusLlmOpenerSettings { enabled: boolean }`（第 44 行）后面加一行：

```ts
export interface GpuAccelerationSettings { experimental: boolean }
```

把

```ts
export const SETTINGS_SCHEMA_VERSION = 13

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; tts: TtsSettings; ttsGenie: GenieTtsSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
}
```

改成

```ts
export const SETTINGS_SCHEMA_VERSION = 14

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; gpuAcceleration: GpuAccelerationSettings; tts: TtsSettings; ttsGenie: GenieTtsSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  gpuAcceleration: { experimental: false },
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
}
```

- [ ] **Step 2: `src/main/config/settings.ts` 的 `normalizeSettings()` 加防御式解析**

把

```ts
  const afo = (r.appFocusLlmOpener ?? {}) as Record<string, unknown>
  const appFocusLlmOpener = { enabled: afo.enabled === true }
```

改成

```ts
  const afo = (r.appFocusLlmOpener ?? {}) as Record<string, unknown>
  const appFocusLlmOpener = { enabled: afo.enabled === true }
  const ga = (r.gpuAcceleration ?? {}) as Record<string, unknown>
  const gpuAcceleration = { experimental: ga.experimental === true }
```

把返回对象里的

```ts
    appFocusLlmOpener,
    tts,
    ttsGenie
```

改成

```ts
    appFocusLlmOpener,
    gpuAcceleration,
    tts,
    ttsGenie
```

- [ ] **Step 3: `src/main/config/settings.test.ts` 补现有 round-trip 测试的字面量 + 新增 `gpuAcceleration` 测试组**

把第 26 行的完整字面量

```ts
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, tts: DEFAULT_SETTINGS.tts, ttsGenie: DEFAULT_SETTINGS.ttsGenie }
```

改成（在 `appFocusLlmOpener: { enabled: false },` 后面插入 `gpuAcceleration: { experimental: false },`）：

```ts
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, gpuAcceleration: { experimental: false }, tts: DEFAULT_SETTINGS.tts, ttsGenie: DEFAULT_SETTINGS.ttsGenie }
```

在文件里紧跟 `describe('appFocusLlmOpener', ...)` 那个 `describe` 块（大约第 111 行 `})` 之后）新增一段，完全照抄它的写法：

```ts
describe('gpuAcceleration', () => {
  it('缺省 → 默认 experimental:false', () => {
    const f = tmpSettingsFile({ schemaVersion: 13, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: false })
  })
  it('保留合法的 experimental:true', () => {
    const f = tmpSettingsFile({ gpuAcceleration: { experimental: true } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: true })
  })
  it('非法值(非 true) → 回退 false', () => {
    const f = tmpSettingsFile({ gpuAcceleration: { experimental: 'yes' } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: false })
  })
})
```

- [ ] **Step 4: 修复另外两处手写的完整 `AppSettings` 字面量**

`src/main/providers/embedder.test.ts` 第 68 行附近，把

```ts
    tts: DEFAULT_TTS_SETTINGS,
    ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
  })
```

改成

```ts
    tts: DEFAULT_TTS_SETTINGS,
    ttsGenie: DEFAULT_GENIE_TTS_SETTINGS,
    gpuAcceleration: { experimental: false }
  })
```

（这段字面量在 `appFocusLlmOpener: { enabled: false },` 之后，`tts:`/`ttsGenie:` 之前也可以插，字段顺序不影响 TS 结构类型检查，插在 `ttsGenie` 后面最省事。）

`src/main/shell/chat.test.ts` 第 13-26 行附近，同样把

```ts
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
}
```

改成

```ts
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS,
  gpuAcceleration: { experimental: false }
}
```

- [ ] **Step 5: 运行完整测试确认通过**

Run: `pnpm typecheck && pnpm test`
Expected: PASS，无编译错误，新增的 `gpuAcceleration` 测试组 3 个用例通过，`settings.test.ts` 的 round-trip 测试依然通过。

- [ ] **Step 6: 提交**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts
git commit -m "feat(gpu-accel): AppSettings 新增 gpuAcceleration.experimental 字段,SETTINGS_SCHEMA_VERSION 13→14"
```

---

### Task 3: 主进程——把决策逻辑接入 `main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `decideGpuBoot(opts): GpuBootDecision` from `@shared/gpuBootDecision`（Task 1）；`loadSettings(file): AppSettings`、`saveSettings(file, settings): void` from `./config/settings`（已存在）；`AppSettings.gpuAcceleration.experimental: boolean`（Task 2）。

这是本计划风险最高、最需要仔细核对的一步——`app.disableHardwareAcceleration()` 的调用时机（`app.whenReady()` 之前）不能被破坏，且所有新增的文件系统读写必须包在 try/catch 里，任何失败都要退回"不使用硬件加速"这个安全默认值。

- [ ] **Step 1: 替换 `main/index.ts` 里 `app.disableHardwareAcceleration()` 附近的代码**

当前文件内容（改动前）：

```ts
import { app, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'

/**
 * 打包后的 GUI 进程没有控制台,任何致命错误都无处可看(表现为"任务栏闪一下就消失")。
 * 把诊断信息同时落到 userData 和系统临时目录(app 未 ready 时 userData 可能取不到),
 * 绝不因日志本身再抛错。
 */
function logDiag(tag: string, detail: unknown): void {
  const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
  const line = `[${new Date().toISOString()}] ${tag}: ${msg}\n`
  const targets: string[] = []
  try { targets.push(join(app.getPath('userData'), 'startup-crash.log')) } catch { /* userData 未就绪 */ }
  try { targets.push(join(tmpdir(), 'kibo-startup.log')) } catch { /* ignore */ }
  for (const p of targets) {
    try { writeFileSync(p, line, { flag: 'a' }) } catch { /* 写不了也不能崩 */ }
  }
}

logDiag('boot', `main entered (packaged=${app.isPackaged}, argv=${JSON.stringify(process.argv)})`)

process.on('uncaughtException', (e) => logDiag('uncaughtException', e))
process.on('unhandledRejection', (e) => logDiag('unhandledRejection', e))

/**
 * 真机双击崩溃根因(用户机崩溃转储确认):硬件 GPU 子进程以 0xC0000135 退出 →
 * 主进程 FATAL "GPU process isn't usable. Goodbye."(事件日志 0x80000003)秒退。
 * 对策:禁用硬件加速 → 改用 SwiftShader 软件渲染(其 DLL 随包分发,不依赖该机缺失的
 * 硬件图形 DLL),既消除崩溃又能正常出画。小透明置顶精灵窗对软件渲染性能无感。
 * 注:曾叠加 --in-process-gpu,虽也不崩但会导致窗口一片空白(合成/绘制异常),已移除。
 * 必须在 app ready 前设置。
 */
app.disableHardwareAcceleration()

app.whenReady()
  .then(() => startShell())
  .catch((e) => {
    logDiag('startShell threw', e)
    try {
      dialog.showErrorBox('Kibo 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
    } catch {
      /* dialog 不可用也不能再崩 */
    }
  })
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
```

改成（改动前 65 行 → 改动后，import 区和 `logDiag`/`process.on` 部分完全不动，只替换从 `真实双击崩溃根因` 注释开始到 `app.disableHardwareAcceleration()` 这一段，并在 `app.whenReady()` 之前插入新逻辑）：

```ts
import { app, dialog } from 'electron'
import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'
import { loadSettings, saveSettings } from './config/settings'
import { decideGpuBoot } from '@shared/gpuBootDecision'

/**
 * 打包后的 GUI 进程没有控制台,任何致命错误都无处可看(表现为"任务栏闪一下就消失")。
 * 把诊断信息同时落到 userData 和系统临时目录(app 未 ready 时 userData 可能取不到),
 * 绝不因日志本身再抛错。
 */
function logDiag(tag: string, detail: unknown): void {
  const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
  const line = `[${new Date().toISOString()}] ${tag}: ${msg}\n`
  const targets: string[] = []
  try { targets.push(join(app.getPath('userData'), 'startup-crash.log')) } catch { /* userData 未就绪 */ }
  try { targets.push(join(tmpdir(), 'kibo-startup.log')) } catch { /* ignore */ }
  for (const p of targets) {
    try { writeFileSync(p, line, { flag: 'a' }) } catch { /* 写不了也不能崩 */ }
  }
}

logDiag('boot', `main entered (packaged=${app.isPackaged}, argv=${JSON.stringify(process.argv)})`)

process.on('uncaughtException', (e) => logDiag('uncaughtException', e))
process.on('unhandledRejection', (e) => logDiag('unhandledRejection', e))

/**
 * 真机双击崩溃根因(用户机崩溃转储确认):硬件 GPU 子进程以 0xC0000135 退出 →
 * 主进程 FATAL "GPU process isn't usable. Goodbye."(事件日志 0x80000003)秒退。
 * 默认仍然禁用硬件加速,改用 SwiftShader 软件渲染(其 DLL 随包分发,不依赖该机缺失的
 * 硬件图形 DLL)。用户可在设置里勾选"实验性硬件加速"主动尝试——见
 * docs/superpowers/specs/2026-07-14-gpu-acceleration-reboot-degrade-design.md:
 * 用 userData 下的启动标记文件 + 设置开关做"重启降级",而不是试图在进程内捕获这类致命
 * 崩溃(真实案例 electron/electron#43955 证实"进程内捕获再动态降级"这条路线不可靠)。
 * 注:曾叠加 --in-process-gpu,虽也不崩但会导致窗口一片空白(合成/绘制异常),已移除。
 * 这段决策必须在 app ready 前跑完(app.disableHardwareAcceleration() 的硬性要求)。
 */
let gpuMarkerFile: string | null = null
let useHardwareAcceleration = false
try {
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  gpuMarkerFile = join(userData, 'gpu-accel-boot.marker')
  const settings = loadSettings(settingsFile)
  const markerPresent = existsSync(gpuMarkerFile)
  const decision = decideGpuBoot({
    experimentalHardwareAcceleration: settings.gpuAcceleration.experimental,
    markerPresent
  })
  useHardwareAcceleration = decision.useHardwareAcceleration
  if (decision.markerAction === 'clear-and-disable-setting') {
    rmSync(gpuMarkerFile, { force: true })
    saveSettings(settingsFile, { ...settings, gpuAcceleration: { experimental: false } })
    logDiag('gpu-accel', '检测到上次启动的标记文件残留,判定硬件加速导致启动失败,已自动降级并关闭设置')
  } else if (decision.markerAction === 'write') {
    writeFileSync(gpuMarkerFile, String(Date.now()))
  }
} catch (err) {
  logDiag('gpu-accel decision failed, falling back to safe default', err)
}

if (!useHardwareAcceleration) app.disableHardwareAcceleration()

if (gpuMarkerFile && useHardwareAcceleration) {
  const markerFile = gpuMarkerFile
  let cleared = false
  app.on('browser-window-created', (_e, win) => {
    if (cleared) return
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (cleared) return
        cleared = true
        try { rmSync(markerFile, { force: true }) } catch (err) { logDiag('gpu-accel marker clear failed', err) }
      }, 3000)
    })
  })
}

app.whenReady()
  .then(() => startShell())
  .catch((e) => {
    logDiag('startShell threw', e)
    try {
      dialog.showErrorBox('Kibo 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
    } catch {
      /* dialog 不可用也不能再崩 */
    }
  })
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
```

- [ ] **Step 2: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 运行完整测试确认没有回归**

Run: `pnpm test`
Expected: PASS，不应该有任何测试因为这次改动而失败（`main/index.ts` 本身没有专门的单测文件，这一步是确认没有间接影响到别处）。

- [ ] **Step 4: 提交**

```bash
git add src/main/index.ts
git commit -m "feat(gpu-accel): main/index.ts 接入 GPU 启动决策,默认行为不变,勾选实验性开关才走重启降级路径"
```

---

### Task 4: 设置页 UI——实验性硬件加速开关

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `AppSettings.gpuAcceleration.experimental: boolean`（Task 2）。
- Produces: 无——这是终端 UI，没有其他任务依赖它。

放在"宠物"页（`data-page="pet"`），紧跟在现有的导入/重启按钮那一行 `<div class="row">...</div>` 之后——硬件加速直接影响宠物怎么画出来，跟"当前宠物(重启后生效)"这个现有控件语境上挨得最近，不需要为一个复选框专门开一个新 tab。

- [ ] **Step 1: `settings.html` 加复选框**

把（第 99-109 行）

```html
          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <div id="noPetBanner" class="banner-warn" style="display:none">未检测到宠物包,请先导入一个宠物包,选中它并点击"保存",再点击"立即重启"。</div>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
          </section>
```

改成

```html
          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <div id="noPetBanner" class="banner-warn" style="display:none">未检测到宠物包,请先导入一个宠物包,选中它并点击"保存",再点击"立即重启"。</div>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="gpuAccelerationExperimental" type="checkbox" style="width:auto" />
              <span>尝试启用硬件加速渲染(实验性,重启后生效)</span>
            </label>
          </section>
```

- [ ] **Step 2: `settings.ts` 声明控件引用**

把（第 22-23 行）

```ts
const appFocusLlmOpenerEnabled = $<HTMLInputElement>('appFocusLlmOpenerEnabled')
const desktopControlEnabled = $<HTMLInputElement>('desktopControlEnabled')
```

改成

```ts
const appFocusLlmOpenerEnabled = $<HTMLInputElement>('appFocusLlmOpenerEnabled')
const desktopControlEnabled = $<HTMLInputElement>('desktopControlEnabled')
const gpuAccelerationExperimental = $<HTMLInputElement>('gpuAccelerationExperimental')
```

- [ ] **Step 3: 保存时带上这个字段**

把（第 419-422 行附近）

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie()
    })
```

改成

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      gpuAcceleration: { experimental: gpuAccelerationExperimental.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie()
    })
```

- [ ] **Step 4: 初始化时回填**

把（第 462 行附近）

```ts
  desktopControlEnabled.checked = snap.settings.desktopControl.enabled
```

改成

```ts
  desktopControlEnabled.checked = snap.settings.desktopControl.enabled
  gpuAccelerationExperimental.checked = snap.settings.gpuAcceleration.experimental
```

- [ ] **Step 5: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(gpu-accel): 设置页新增\"尝试启用硬件加速渲染(实验性)\"复选框"
```

---

### Task 5: 全量 typecheck + 单测 + build 验证

**Files:**
- 无新文件，纯验证任务。

- [ ] **Step 1: 运行完整 typecheck**

Run: `pnpm typecheck`
Expected: PASS，两个 tsconfig 都无报错。

- [ ] **Step 2: 运行完整单测**

Run: `pnpm test`
Expected: PASS，包含 Task 1 新增的 `gpuBootDecision.test.ts`（4 用例）和 Task 2 新增的 `gpuAcceleration` 测试组（3 用例）在内全部通过。

- [ ] **Step 3: 运行完整 build**

Run: `pnpm build`
Expected: PASS，`electron-vite build` 正常产出 `out/` 三件套。

这一步全程可由 subagent 自动完成，不需要真实显示器。

---

### Task 6:（人工执行）真机验证

**这一步不能派给 subagent**——需要真实的应用重启周期和文件系统观察，跟以往的经验一样。

**Files:** 无。

- [ ] **Step 1: 默认行为不受影响**

不改动任何设置，正常启动应用（`pnpm build && pnpm preview` 或 `pnpm dev`），确认宠物正常显示；检查 `userData` 目录（Windows 上通常是 `%APPDATA%/kibo-pet`）下没有出现 `gpu-accel-boot.marker` 文件。

- [ ] **Step 2: 正常路径——勾选开关后能正常跑通一次完整循环**

在设置页勾选"尝试启用硬件加速渲染(实验性,重启后生效)"，保存，重启应用。确认：
1. 应用正常打开，宠物正常显示(没有重新触发那次真实的 GPU 崩溃)。
2. 几秒内 `gpu-accel-boot.marker` 文件从 `userData` 目录消失。
3. 再重启一次，确认这个开关依然是勾选状态，且启动过程正常(不会不断重复写入/清除标记文件)。

- [ ] **Step 3: 恢复路径——手动模拟"标记文件残留"**

关闭应用，手动在 `userData` 目录下创建一个空的 `gpu-accel-boot.marker` 文件，同时确认 `settings.json` 里 `gpuAcceleration.experimental` 是 `true`(如果上一步已经勾选过，此时应该已经是 `true`)。然后启动应用，确认：
1. 应用这次正常启动(走的是强制软件渲染路径)。
2. `gpu-accel-boot.marker` 文件被清除。
3. `settings.json` 里 `gpuAcceleration.experimental` 被自动改回 `false`。
4. 设置页打开后，"尝试启用硬件加速渲染"这个复选框显示为未勾选状态。

- [ ] **Step 4: 记录结果**

把上面三步的真机观察结果告诉我，如果都符合预期，这个功能就可以进入 `feature/live2d-presentation` 分支下一步(Live2D 集成)；如果哪一步不符合预期，先在这里排查，不要带着一个有问题的 GPU 降级机制去做 Live2D。

---

## Self-Review 记录

- **Spec 覆盖**：spec 的 5 条目标分别对应 Task 4(设置开关)、Task 3(默认行为/尝试硬件加速/失败安全退回)、Task 1(纯函数决策)；"不修改 startShell()"体现在 Task 3 只改 `main/index.ts`；"任何一步失败都退回安全默认值"体现在 Task 3 的 try/catch 包裹范围。
- **占位符扫描**：全文没有 TBD/"类似 Task N"这类占位表述，每个代码 Step 都给了完整代码，包括改动前/改动后的完整对照。
- **类型一致性**：`GpuBootDecision`/`decideGpuBoot`（Task 1）、`GpuAccelerationSettings`/`gpuAcceleration.experimental`（Task 2）在 Task 3、Task 4 里的调用与定义处保持一致；`loadSettings`/`saveSettings`/`normalizeSettings` 的签名均取自已确认存在的真实导出，未臆造接口。Task 2 额外核查了两处容易漏改的手写 `AppSettings` 字面量(`embedder.test.ts`、`chat.test.ts`)，避免 Task 3/4 完成后才在 typecheck 时才发现遗漏。
