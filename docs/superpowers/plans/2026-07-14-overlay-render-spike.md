# 覆盖窗口渲染性能 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一组独立的、验证后即删除的临时文件，跑起一个覆盖当前屏幕 workArea 的透明大窗口 demo（真实宠物精灵图 + `requestAnimationFrame` 驱动的浮点坐标移动 + 逐像素点击穿透 + 帧间隔/CPU 观测），供用户在真机上判断"整屏透明覆盖窗口 + 软件合成"这个组合是否比现有 256×288 小窗口方案更流畅，从而决定是否投入 Phase 1 正式重构。

**Architecture:** 主进程新增一个由 `SPIKE_OVERLAY=1` 环境变量门控的独立启动路径（`startOverlaySpike()`），复用现有 `resolvePetHome`/`loadPet`/`IPC.GET_PET`/`IPC.SET_IGNORE_MOUSE`/生产 preload，不新建 preload 文件；渲染进程是一个全新的 rAF 循环 demo，不复用/不改动生产的 `SpritePlayer`/`petController`。

**Tech Stack:** Electron + TypeScript + Vite (electron-vite)，沿用项目现有 pnpm/Vitest 工具链，不引入新依赖。

## Global Constraints

- 本计划涉及的所有新代码都是 spike 专用、临时性质，最后一个任务会把它们全部删除，无论验证结果是 Go 还是 No-Go（见 spec `docs/superpowers/specs/2026-07-14-overlay-render-spike-design.md` 的"非目标"和"采用方案"）。
- 只允许修改两个生产文件：`src/main/index.ts`（加一个 env 门控分支）、`electron.vite.config.ts`（加一个 renderer 入口）；两处改动都是可逆的一行/一段新增，不改变现有生产行为。
- 复用生产 preload（`src/preload/index.ts` 编译产物 `out/preload/index.js`），不新建 preload 文件——spike 只用得到已经暴露的 `window.petApi.getPet()` 和 `window.petApi.setIgnoreMouseEvents()`。
- 不改动 `petWindow.ts`、`petController.ts`、`spritePlayer.ts`、`MOVE_WINDOW` IPC、气泡/控制指示器窗口（spec 非目标）。
- 不评估或改动 `app.disableHardwareAcceleration()`（`src/main/index.ts:36`）。
- 只覆盖当前主屏（`screen.getPrimaryDisplay().workArea`），不做多屏漫游（spec 非目标 + brainstorming 确认范围）。
- 真机验证环境是 Windows，主 shell 是 PowerShell；运行 demo 用 `$env:SPIKE_OVERLAY='1'; pnpm dev`。

---

### Task 1: 纯逻辑——匀速往返反弹的位置推进函数

**Files:**
- Create: `src/shared/overlaySpikeMotion.ts`
- Test: `src/shared/overlaySpikeMotion.test.ts`

**Interfaces:**
- Produces: `export interface BounceState { x: number; vx: number }`；`export function stepBounce(x: number, vx: number, dtMs: number, minX: number, maxX: number): BounceState` —— 给定当前坐标、速度（px/ms）、经过的毫秒数、允许范围 `[minX, maxX]`，返回推进后的坐标和速度；超出边界时把坐标按超出量对称反射回范围内，并反转速度符号。Task 6 的渲染循环会调用它推进精灵横向位置。

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/overlaySpikeMotion.test.ts
import { describe, it, expect } from 'vitest'
import { stepBounce } from './overlaySpikeMotion'

describe('stepBounce', () => {
  it('moves normally within bounds', () => {
    const r = stepBounce(10, 1, 5, 0, 100)
    expect(r).toEqual({ x: 15, vx: 1 })
  })

  it('bounces off the max bound and reverses velocity', () => {
    const r = stepBounce(98, 1, 5, 0, 100)
    // 超出 100 三个像素 -> 反射回 97,速度翻转为 -1
    expect(r).toEqual({ x: 97, vx: -1 })
  })

  it('bounces off the min bound and reverses velocity', () => {
    const r = stepBounce(2, -1, 5, 0, 100)
    // 超出 0 三个像素 -> 反射回 3,速度翻转为 +1
    expect(r).toEqual({ x: 3, vx: 1 })
  })

  it('keeps a stationary object stationary', () => {
    const r = stepBounce(50, 0, 16, 0, 100)
    expect(r).toEqual({ x: 50, vx: 0 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/overlaySpikeMotion.test.ts`
Expected: FAIL，报 `Cannot find module './overlaySpikeMotion'` 或类似的"模块不存在"错误。

- [ ] **Step 3: 写最小实现**

```ts
// src/shared/overlaySpikeMotion.ts
export interface BounceState { x: number; vx: number }

export function stepBounce(x: number, vx: number, dtMs: number, minX: number, maxX: number): BounceState {
  const next = x + vx * dtMs
  if (next > maxX) return { x: maxX - (next - maxX), vx: -Math.abs(vx) }
  if (next < minX) return { x: minX + (minX - next), vx: Math.abs(vx) }
  return { x: next, vx }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/overlaySpikeMotion.test.ts`
Expected: PASS，4 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/shared/overlaySpikeMotion.ts src/shared/overlaySpikeMotion.test.ts
git commit -m "test(spike): 新增覆盖窗口 spike 用的匀速往返反弹纯函数"
```

---

### Task 2: 主进程——临时的整屏覆盖窗口工厂函数

**Files:**
- Create: `src/main/shell/overlaySpikeWindow.ts`

**Interfaces:**
- Consumes: `Bounds` type from `@shared/petBrain`（`{ x, y, width, height }`，与 `petWindow.ts`/`windowPlacement.ts` 用的是同一个类型）。
- Produces: `export function createOverlaySpikeWindow(opts: { preload: string; url: string | undefined; html: string; workArea: Bounds }): BrowserWindow` —— Task 3 会调用它创建 spike 窗口。

这个文件是 `petWindow.ts` 的镜像写法，但窗口尺寸/位置来自传入的 `workArea`（覆盖整个屏幕工作区），而不是固定的 `PET_WINDOW_SIZE`。没有可独立单测的纯逻辑（纯 Electron API 调用），本任务不写自动化测试，正确性在 Task 8 的真机验证里确认。

- [ ] **Step 1: 实现**

```ts
// src/main/shell/overlaySpikeWindow.ts
import { BrowserWindow } from 'electron'
import type { Bounds } from '@shared/petBrain'

export function createOverlaySpikeWindow(opts: {
  preload: string
  url: string | undefined
  html: string
  workArea: Bounds
}): BrowserWindow {
  const { workArea } = opts
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.html)
  return win
}
```

- [ ] **Step 2: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS（此时 `overlaySpikeMain.ts` 还不存在，这个文件本身不会被任何地方 import，但它自身必须类型检查通过）。

- [ ] **Step 3: 提交**

```bash
git add src/main/shell/overlaySpikeWindow.ts
git commit -m "feat(spike): 新增覆盖当前屏幕 workArea 的临时窗口工厂函数"
```

---

### Task 3: 主进程——spike 启动引导（复用宠物资源解析 + 注册最小 IPC）

**Files:**
- Create: `src/main/shell/overlaySpikeMain.ts`

**Interfaces:**
- Consumes:
  - `createOverlaySpikeWindow` from Task 2。
  - `loadPet(petDir: string): Promise<LoadedPet>`、`petsDir(appRoot: string): string` from `../petLoader`（`LoadedPet` 类型来自 `@shared/ipc`，字段 `{ manifest: PetManifest; spritesheetDataUrl: string }`）。
  - `resolvePetHome(opts): ResolvePetHomeResult` from `../pets/resolvePetHome`（`ResolvePetHomeResult` 是 `{ mode: 'ready'; petHome: PetHomeResult } | { mode: 'onboarding' }`，`PetHomeResult` 含字段 `petHome: string`）。
  - `loadSettings(settingsFile: string)` from `../config/settings`，返回对象含 `activePetId: string`。
  - `DEFAULT_SETTINGS` from `@shared/llm`，其 `activePetId` 字段是默认宠物 id。
  - `IPC.GET_PET`、`IPC.SET_IGNORE_MOUSE` from `@shared/ipc`；`validateBool(v: unknown): boolean | null` from `@shared/ipcValidation`。
- Produces: `export function startOverlaySpike(): void`——Task 4 在 `src/main/index.ts` 里调用它替代 `startShell()`。

这段 petDir 解析逻辑直接照抄 `src/main/shell/index.ts:174-210`（`startShell()` 开头部分），保证 spike 用的是和生产完全一样的"当前激活宠物"，而不是另建一套逻辑。

- [ ] **Step 1: 实现**

```ts
// src/main/shell/overlaySpikeMain.ts
import { app, screen, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type LoadedPet } from '@shared/ipc'
import { validateBool } from '@shared/ipcValidation'
import { DEFAULT_SETTINGS } from '@shared/llm'
import { loadPet, petsDir } from '../petLoader'
import { resolvePetHome } from '../pets/resolvePetHome'
import { loadSettings } from '../config/settings'
import { createOverlaySpikeWindow } from './overlaySpikeWindow'

export function startOverlaySpike(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url))
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const overlaySpikeHtml = join(dirname, '../renderer/overlaySpike.html')
  const overlaySpikeUrl = rendererUrl ? `${rendererUrl}/overlaySpike.html` : undefined
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  const bundledPetsDir = petsDir(appRoot)
  const legacyMemoryDir = join(userData, 'memory')
  const configuredPetId = loadSettings(settingsFile).activePetId
  const defaultPetId = DEFAULT_SETTINGS.activePetId

  const resolved = resolvePetHome({
    userDataDir: userData,
    bundledPetsDir,
    configuredPetId,
    defaultPetId,
    legacyMemoryDir
  })
  if (resolved.mode === 'onboarding') {
    console.error('[overlaySpike] 没有可用的宠物包,无法运行 spike;请先正常启动一次应用完成宠物导入')
    app.quit()
    return
  }
  const { petHome } = resolved.petHome
  const petDir = petHome

  const workArea = screen.getPrimaryDisplay().workArea
  const win = createOverlaySpikeWindow({ preload, url: overlaySpikeUrl, html: overlaySpikeHtml, workArea })

  ipcMain.handle(IPC.GET_PET, async (): Promise<LoadedPet> => loadPet(petDir))
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, raw) => {
    const ignore = validateBool(raw)
    if (ignore === null) return
    win.setIgnoreMouseEvents(ignore, { forward: true })
  })
}
```

- [ ] **Step 2: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/main/shell/overlaySpikeMain.ts
git commit -m "feat(spike): 新增覆盖窗口 spike 的启动引导,复用生产宠物资源解析"
```

---

### Task 4: 用环境变量门控 spike 启动路径

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `startOverlaySpike()` from Task 3；已有的 `startShell()` from `./shell`。

- [ ] **Step 1: 修改 `app.whenReady()` 分支**

在 `src/main/index.ts` 顶部加一行 import，并把现有的

```ts
app.whenReady()
  .then(() => startShell())
  .catch((e) => {
```

改成

```ts
app.whenReady()
  .then(() => {
    if (process.env.SPIKE_OVERLAY === '1') return startOverlaySpike()
    return startShell()
  })
  .catch((e) => {
```

完整 import 行加在 `import { startShell } from './shell'` 之后：

```ts
import { startOverlaySpike } from './shell/overlaySpikeMain'
```

- [ ] **Step 2: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/main/index.ts
git commit -m "feat(spike): SPIKE_OVERLAY=1 时启动覆盖窗口 demo 而非正常宠物外壳"
```

---

### Task 5: 注册 renderer 构建入口

**Files:**
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Consumes: 无新接口，只是给 Vite 的多入口构建加一项。

- [ ] **Step 1: 在 `renderer.build.rollupOptions.input` 里加一行**

```ts
renderer: {
  root: 'src/renderer',
  build: {
    rollupOptions: {
      input: {
        index: resolve('src/renderer/index.html'),
        dialog: resolve('src/renderer/dialog.html'),
        settings: resolve('src/renderer/settings.html'),
        overlay: resolve('src/renderer/regionOverlay.html'),
        todoPanel: resolve('src/renderer/todoPanel.html'),
        bubble: resolve('src/renderer/bubble.html'),
        overlaySpike: resolve('src/renderer/overlaySpike.html')
      }
    }
  },
  resolve: { alias: { '@shared': resolve('src/shared') } }
}
```

- [ ] **Step 2: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS（此时 `overlaySpike.html` 还不存在，这一步只确认改动没有破坏 TS 配置本身；Task 6 之后才会有真正可构建的入口）。

- [ ] **Step 3: 提交**

```bash
git add electron.vite.config.ts
git commit -m "build(spike): 注册 overlaySpike renderer 构建入口"
```

---

### Task 6: 渲染进程 demo——rAF 循环、浮点坐标绘制、逐像素点击穿透、帧间隔观测

**Files:**
- Create: `src/renderer/overlaySpike.html`
- Create: `src/renderer/overlaySpike.ts`

**Interfaces:**
- Consumes:
  - `window.petApi.getPet(): Promise<LoadedPet>`、`window.petApi.setIgnoreMouseEvents(ignore: boolean): void`（生产 preload 已暴露的全局 `petApi`）。
  - `frameRect(sheet: PetSheet, row: number, col: number): FrameRect`、`frameDurationMs(anim: PetAnimation, index: number): number` from `@shared/petPackage`。
  - `stepBounce(x, vx, dtMs, minX, maxX): BounceState` from `@shared/overlaySpikeMotion`（Task 1）。
- Produces: 无（终端渲染入口，没有其他任务依赖它导出的符号）。

- [ ] **Step 1: 写 HTML 入口**

```html
<!-- src/renderer/overlaySpike.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'self'" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      #stage { display: block; }
      #debug {
        position: fixed; top: 8px; left: 8px; padding: 4px 8px;
        background: rgba(0, 0, 0, .6); color: #0f0; font: 12px/1.4 monospace;
        pointer-events: none; white-space: pre;
      }
    </style>
  </head>
  <body>
    <canvas id="stage"></canvas>
    <div id="debug"></div>
    <script type="module" src="./overlaySpike.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 写渲染逻辑**

```ts
// src/renderer/overlaySpike.ts
import { frameRect, frameDurationMs } from '@shared/petPackage'
import { stepBounce } from '@shared/overlaySpikeMotion'

const SPEED_PX_PER_MS = 0.08 // ~80px/s,比生产行走(40px/s)更快,便于观察合成表现

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement
  const debug = document.getElementById('debug') as HTMLDivElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const animKeys = Object.keys(manifest.animations)
  const animName = animKeys.find((k) => k.startsWith('walk')) ?? animKeys[0]
  if (!animName) throw new Error('overlaySpike: manifest 没有任何动画')
  const anim = manifest.animations[animName]
  if (!anim) throw new Error(`overlaySpike: 缺少动画 "${animName}"`)

  const cellW = manifest.sheet.cellWidth
  const cellH = manifest.sheet.cellHeight
  const minX = 0
  const maxX = Math.max(0, canvas.width - cellW)
  const spriteY = Math.max(0, Math.floor((canvas.height - cellH) / 2))

  let spriteX = 0
  let vx = SPEED_PX_PER_MS
  let frameIndex = 0
  let frameElapsedMs = 0
  let lastTs = performance.now()
  const samples: number[] = []
  let ignoring = true
  window.petApi.setIgnoreMouseEvents(true)

  function isSpritePixel(clientX: number, clientY: number): boolean {
    const px = Math.floor(clientX - spriteX)
    const py = Math.floor(clientY - spriteY)
    if (px < 0 || px >= cellW || py < 0 || py >= cellH) return false
    const r = frameRect(manifest.sheet, anim.row, frameIndex)
    const alpha = ctx.getImageData(r.x + px, r.y + py, 1, 1).data[3]
    return alpha > 10
  }

  window.addEventListener('mousemove', (e: MouseEvent) => {
    const onSprite = isSpritePixel(e.clientX, e.clientY)
    if (onSprite === ignoring) {
      ignoring = !onSprite
      window.petApi.setIgnoreMouseEvents(ignoring)
    }
  })

  function frame(ts: number): void {
    const dt = ts - lastTs
    lastTs = ts
    samples.push(dt)
    if (samples.length > 120) samples.shift()

    const bounced = stepBounce(spriteX, vx, dt, minX, maxX)
    spriteX = bounced.x
    vx = bounced.vx

    frameElapsedMs += dt
    const holdMs = frameDurationMs(anim, frameIndex)
    if (frameElapsedMs >= holdMs) {
      frameElapsedMs = 0
      const next = frameIndex + 1
      frameIndex = next < anim.frames ? next : (anim.loop ? 0 : anim.frames - 1)
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const r = frameRect(manifest.sheet, anim.row, frameIndex)
    ctx.drawImage(sheet, r.x, r.y, r.w, r.h, spriteX, spriteY, r.w, r.h)

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    const max = Math.max(...samples)
    debug.textContent = `frame dt: ${dt.toFixed(1)}ms  avg(120): ${avg.toFixed(1)}ms  max(120): ${max.toFixed(1)}ms`

    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

boot().catch((err) => console.error('[overlaySpike] boot failed', err))
```

- [ ] **Step 3: 运行 typecheck 确认通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/overlaySpike.html src/renderer/overlaySpike.ts
git commit -m "feat(spike): 覆盖窗口 demo——rAF 浮点移动+逐像素穿透+帧间隔观测"
```

---

### Task 7: 全量 typecheck + 单测回归

**Files:**
- 无新文件，纯验证任务。

**Interfaces:**
- 无。

- [ ] **Step 1: 运行完整 typecheck**

Run: `pnpm typecheck`
Expected: PASS，两个 tsconfig（`tsconfig.json`、`tsconfig.node.json`）都无报错。

- [ ] **Step 2: 运行完整单测**

Run: `pnpm test`
Expected: PASS，包含 Task 1 新增的 `overlaySpikeMotion.test.ts` 在内全部通过，且不影响任何既有测试（本计划没有修改任何既有生产逻辑文件的行为，只加了一个 env 门控分支）。

这一步可以由 subagent 自动完成，不需要真实显示器。

---

### Task 8:（人工执行）真机运行 + 流畅度/CPU/点击穿透观察 + Go/No-Go 判定

**这一步不能派给 subagent**——需要真实显示器和真实鼠标操作，此前的经验（真机 GPU 崩溃、真机拖拽漂移等问题）反复证明这类验证无法在 agent 会话里复现，必须由用户在自己机器上完成。

**Files:** 无。

- [ ] **Step 1: 启动 demo（PowerShell）**

```powershell
$env:SPIKE_OVERLAY = '1'
pnpm dev
```

- [ ] **Step 2: 按 spec 的"真机验证"逐项观察**

对照 `docs/superpowers/specs/2026-07-14-overlay-render-spike-design.md` 的"真机验证"小节：

1. 精灵水平往返移动是否顺滑，和当前正式版本的行走观感对比。
2. 画面左上角调试文字的帧间隔数据是否稳定接近显示器刷新间隔（60Hz≈16.7ms），有无持续性大幅波动/掉帧。
3. 任务管理器里该 Electron 渲染进程 + 相关进程的 CPU 占用，和现有小窗口版本运行时占用做对比。
4. 把鼠标移入/移出精灵区域，确认穿透区域可以点到桌面下层窗口、图形区域能正常拦截 `mousedown`。

- [ ] **Step 3: 结束 demo**

关闭该 Electron 窗口（或直接 `Ctrl+C` 终止 `pnpm dev` 进程），避免遗留一个整屏置顶透明窗口。

- [ ] **Step 4: 记录 Go/No-Go 结论**

按 spec 的"成功标准"判据，得出结论：

- **Go**：真机运行下帧间隔稳定、无明显掉帧，CPU 占用相比现有方案没有显著恶化，点击穿透正确无误 → 转入 Phase 1（正式重构 `petController.ts`/`spritePlayer.ts`/IPC，届时另写设计文档）。
- **No-Go**：出现明显更卡的合成表现，或 CPU 占用显著上升，或点击穿透在整屏画布上有可感知的失灵/延迟 → 放弃方案B，改为方案A（`spritePlayer.ts`/`petController.ts` 原地改造：统一 `requestAnimationFrame` 驱动+定步长逻辑/插值渲染，不改变窗口跟随架构），另开新的 brainstorming/plan 周期。

---

### Task 9: 清理 spike 专用代码

**Files:**
- Delete: `src/shared/overlaySpikeMotion.ts`、`src/shared/overlaySpikeMotion.test.ts`
- Delete: `src/main/shell/overlaySpikeWindow.ts`、`src/main/shell/overlaySpikeMain.ts`
- Delete: `src/renderer/overlaySpike.html`、`src/renderer/overlaySpike.ts`
- Modify: `src/main/index.ts`（撤销 Task 4 的 env 门控分支和 import）
- Modify: `electron.vite.config.ts`（撤销 Task 5 加的 `overlaySpike` 入口）

**Interfaces:** 无——这是纯撤销任务。

无论 Task 8 的结论是 Go 还是 No-Go，spike 文件都要删除（spec 明确要求），因为它本身不是可维护的生产代码。

- [ ] **Step 1: 删除 spike 专用文件**

```bash
git rm src/shared/overlaySpikeMotion.ts src/shared/overlaySpikeMotion.test.ts
git rm src/main/shell/overlaySpikeWindow.ts src/main/shell/overlaySpikeMain.ts
git rm src/renderer/overlaySpike.html src/renderer/overlaySpike.ts
```

- [ ] **Step 2: 撤销 `src/main/index.ts` 里的门控分支**

把

```ts
import { startOverlaySpike } from './shell/overlaySpikeMain'
```

删除，并把

```ts
app.whenReady()
  .then(() => {
    if (process.env.SPIKE_OVERLAY === '1') return startOverlaySpike()
    return startShell()
  })
  .catch((e) => {
```

改回

```ts
app.whenReady()
  .then(() => startShell())
  .catch((e) => {
```

- [ ] **Step 3: 撤销 `electron.vite.config.ts` 里的 renderer 入口**

删掉 `overlaySpike: resolve('src/renderer/overlaySpike.html')` 这一行。

- [ ] **Step 4: 运行 typecheck + 单测确认恢复干净**

Run: `pnpm typecheck && pnpm test`
Expected: PASS，且测试数量回到 Task 1 之前的基线（`overlaySpikeMotion.test.ts` 已随文件一起删除）。

- [ ] **Step 5: 在 spec 文档补记 Go/No-Go 结论**

在 `docs/superpowers/specs/2026-07-14-overlay-render-spike-design.md` 末尾追加一小节，写明 Task 8 观察到的实际结果和最终判定（Go 转 Phase 1 / No-Go 转方案A），供后续 brainstorming 直接引用，不需要重新回忆。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore(spike): 清理覆盖窗口性能 spike 临时代码,记录 Go/No-Go 结论"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec 的 4 条目标（覆盖窗口合成开销、点击穿透、rAF 浮点移动流畅度、可运行 demo）分别对应 Task 2/3/6（demo 本体）、Task 6 的 `isSpritePixel`（点击穿透）、Task 1+6（rAF 浮点移动）、Task 8（真机验证入口）；"不改动生产代码"体现在 Global Constraints 和 Task 9 的完整撤销步骤；Go/No-Go 判据直接复制 spec 的"成功标准"到 Task 8。
- **占位符扫描**：全文没有 TBD/"类似 Task N"/"添加适当的验证"这类占位表述，每个代码 Step 都给了完整代码。
- **类型一致性**：`stepBounce`/`BounceState`（Task 1）、`createOverlaySpikeWindow`（Task 2）、`startOverlaySpike`（Task 3）在后续任务里的调用签名与其定义处保持一致；`IPC.GET_PET`/`IPC.SET_IGNORE_MOUSE`/`validateBool`/`LoadedPet`/`DEFAULT_SETTINGS` 均取自已确认存在的真实导出（`src/shared/ipc.ts`、`src/shared/ipcValidation.ts`、`src/shared/llm.ts`、`src/main/petLoader.ts`），未臆造接口。
