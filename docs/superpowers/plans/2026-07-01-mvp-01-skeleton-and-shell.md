# MVP-01 工程骨架 + 可执行躯壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可编译/可运行的 Electron+TypeScript 工程,启动一个透明置顶无边框窗口,加载 `pets/luluka` 宠物包并循环播放 `idle` 动画,支持拖拽移动与托盘退出。

**Architecture:** 单个 Electron 应用,主进程(Node)负责窗口/托盘/文件读取,渲染进程负责精灵动画;两者仅通过 preload 暴露的最小 IPC 通信。纯逻辑(pet.json 校验、帧矩形计算)抽到 `src/shared` 做单元测试,窗口/动画等集成部分靠运行验证。

**Tech Stack:** pnpm · Electron · electron-vite · TypeScript · Vitest · electron-builder(本计划只装为 devDep,不打包)

## Global Constraints

- 平台:Windows(win32);开发在 Windows 上进行。
- 包管理器:**pnpm**(所有安装/脚本命令用 `pnpm`)。
- 语言:**TypeScript**,`strict: true`。
- 版本下限(可向上取最新稳定):Node ≥ 20、electron ≥ 31、electron-vite ≥ 2、vite ≥ 5、typescript ≥ 5.5、vitest ≥ 2、electron-builder ≥ 24。
- 窗口:透明、无边框(frameless)、始终置顶(alwaysOnTop)、任务栏不显图标(skipTaskbar)。
- 宠物包契约:`pet.json` 含 `sheet{rows,cols,cellWidth,cellHeight}` 与 `animations{<state>:{row,frames,fps,loop,durations?}}`;帧矩形 `x=col*cellWidth, y=row*cellHeight, w=cellWidth, h=cellHeight`;`walk-left` 独立帧,渲染端**不得**翻转 `walk-right`。
- 提交粒度:每个 Task 末尾提交一次。
- 目录:实现代码放在既有骨架目录(`src/main`、`src/renderer`、`src/shared`),不新建平行结构。

---

### Task 1: 工程初始化与工具链

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`(可选,单包可省;本计划不建)
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.npmrc`
- Modify: `.gitignore`(确认已忽略 `node_modules/`、`out/`、`dist/` —— 已在上一步修好,无需改动;仅核对)

**Interfaces:**
- Consumes: 无(首个任务)。
- Produces:
  - npm scripts:`pnpm dev`(启动 electron-vite)、`pnpm build`(类型检查+构建)、`pnpm test`(vitest run)、`pnpm typecheck`(tsc --noEmit)。
  - electron-vite 三段式入口约定:`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html`(供后续任务放置)。

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "pet-agent",
  "version": "0.0.1",
  "description": "Desktop pet with an agent kernel",
  "main": "./out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "pnpm typecheck && electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^24.13.3",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 创建 `.npmrc`**（让 Electron 二进制正确安装）

```
node-linker=hoisted
```

- [ ] **Step 3: 创建 `tsconfig.json`（renderer + shared，DOM 环境）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/renderer", "src/shared"]
}
```

- [ ] **Step 4: 创建 `tsconfig.node.json`（main + preload,Node 环境）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/main", "src/preload", "src/shared", "electron.vite.config.ts"]
}
```

- [ ] **Step 5: 创建 `electron.vite.config.ts`**

```ts
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
```

- [ ] **Step 6: 创建 `vitest.config.ts`**

```ts
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
```

- [ ] **Step 7: 安装依赖**

Run: `pnpm install`
Expected: 安装成功,生成 `node_modules/` 与 `pnpm-lock.yaml`,无报错。

- [ ] **Step 8: 验证空测试可运行**

Run: `pnpm test`
Expected: vitest 报告 "No test files found"(退出码 0 或 1 均可,关键是 vitest 能启动)。

- [ ] **Step 9: 提交**

```bash
git add package.json pnpm-lock.yaml .npmrc tsconfig.json tsconfig.node.json electron.vite.config.ts vitest.config.ts
git commit -m "chore: scaffold electron-vite + typescript + vitest toolchain"
```

---

### Task 2: 共享层 —— 宠物包类型、帧矩形与 manifest 校验(TDD)

**Files:**
- Create: `src/shared/petPackage.ts`
- Test: `src/shared/petPackage.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface PetSheet { rows: number; cols: number; cellWidth: number; cellHeight: number }`
  - `interface PetAnimation { row: number; frames: number; fps: number; loop: boolean; durations?: number[] }`
  - `interface PetManifest { id: string; displayName: string; description: string; spritesheetPath: string; sheet: PetSheet; animations: Record<string, PetAnimation> }`
  - `interface FrameRect { x: number; y: number; w: number; h: number }`
  - `function frameRect(sheet: PetSheet, row: number, col: number): FrameRect`
  - `function frameDurationMs(anim: PetAnimation, index: number): number`
  - `function parsePetManifest(raw: unknown): PetManifest`（校验失败抛 `Error`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { frameRect, frameDurationMs, parsePetManifest } from './petPackage'

const sheet = { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }

describe('frameRect', () => {
  it('computes pixel rect from row/col', () => {
    expect(frameRect(sheet, 0, 0)).toEqual({ x: 0, y: 0, w: 192, h: 208 })
    expect(frameRect(sheet, 2, 3)).toEqual({ x: 576, y: 416, w: 192, h: 208 })
  })
})

describe('frameDurationMs', () => {
  it('uses durations when present', () => {
    const anim = { row: 0, frames: 2, fps: 5, loop: true, durations: [280, 120] }
    expect(frameDurationMs(anim, 1)).toBe(120)
  })
  it('falls back to 1000/fps without durations', () => {
    const anim = { row: 1, frames: 8, fps: 8, loop: true }
    expect(frameDurationMs(anim, 0)).toBe(125)
  })
})

describe('parsePetManifest', () => {
  const valid = {
    id: 'luluka', displayName: '露露卡', description: 'x', spritesheetPath: 'spritesheet.webp',
    sheet, animations: { idle: { row: 0, frames: 6, fps: 5, loop: true } }
  }
  it('accepts a valid manifest', () => {
    expect(parsePetManifest(valid).id).toBe('luluka')
  })
  it('rejects missing animations', () => {
    const bad = { ...valid, animations: {} }
    expect(() => parsePetManifest(bad)).toThrow(/animations/)
  })
  it('rejects missing sheet fields', () => {
    const bad = { ...valid, sheet: { rows: 13, cols: 8 } }
    expect(() => parsePetManifest(bad)).toThrow(/sheet/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: FAIL(`frameRect` 等未定义 / 模块不存在)。

- [ ] **Step 3: 写最小实现**

```ts
export interface PetSheet { rows: number; cols: number; cellWidth: number; cellHeight: number }
export interface PetAnimation { row: number; frames: number; fps: number; loop: boolean; durations?: number[] }
export interface PetManifest {
  id: string; displayName: string; description: string; spritesheetPath: string
  sheet: PetSheet; animations: Record<string, PetAnimation>
}
export interface FrameRect { x: number; y: number; w: number; h: number }

export function frameRect(sheet: PetSheet, row: number, col: number): FrameRect {
  return { x: col * sheet.cellWidth, y: row * sheet.cellHeight, w: sheet.cellWidth, h: sheet.cellHeight }
}

export function frameDurationMs(anim: PetAnimation, index: number): number {
  if (anim.durations && anim.durations[index] != null) return anim.durations[index]
  return Math.round(1000 / anim.fps)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

export function parsePetManifest(raw: unknown): PetManifest {
  const m = raw as Record<string, any>
  assert(m && typeof m === 'object', 'manifest must be an object')
  for (const k of ['id', 'displayName', 'description', 'spritesheetPath']) {
    assert(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} must be a non-empty string`)
  }
  const s = m.sheet
  assert(s && typeof s === 'object', 'manifest.sheet is required')
  for (const k of ['rows', 'cols', 'cellWidth', 'cellHeight']) {
    assert(typeof s[k] === 'number' && s[k] > 0, `manifest.sheet.${k} must be a positive number`)
  }
  assert(m.animations && typeof m.animations === 'object', 'manifest.animations is required')
  const animKeys = Object.keys(m.animations)
  assert(animKeys.length > 0, 'manifest.animations must not be empty')
  for (const key of animKeys) {
    const a = m.animations[key]
    for (const k of ['row', 'frames', 'fps']) {
      assert(typeof a[k] === 'number', `animation ${key}.${k} must be a number`)
    }
    assert(typeof a.loop === 'boolean', `animation ${key}.loop must be a boolean`)
  }
  return m as PetManifest
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: PASS(全部用例通过)。

- [ ] **Step 5: 提交**

```bash
git add src/shared/petPackage.ts src/shared/petPackage.test.ts
git commit -m "feat(shared): pet manifest types, frameRect and validation"
```

---

### Task 3: 共享层 —— IPC 通道常量与消息类型

**Files:**
- Create: `src/shared/ipc.ts`

**Interfaces:**
- Consumes: `PetManifest`(from Task 2)。
- Produces:
  - `const IPC = { GET_PET: 'pet:get', MOVE_WINDOW: 'window:move', QUIT: 'app:quit' } as const`
  - `interface LoadedPet { manifest: PetManifest; spritesheetDataUrl: string }`
  - `interface MoveDelta { dx: number; dy: number }`
  - `interface PetApi { getPet(): Promise<LoadedPet>; moveWindow(delta: MoveDelta): void; quit(): void }`
  - 全局 `declare global { interface Window { petApi: PetApi } }`

- [ ] **Step 1: 写实现（本任务为纯类型/常量,无独立单测,靠 typecheck 验证）**

```ts
import type { PetManifest } from './petPackage'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  QUIT: 'app:quit'
} as const

export interface LoadedPet {
  manifest: PetManifest
  /** data: URL of the spritesheet (webp), so the renderer needs no file access */
  spritesheetDataUrl: string
}

export interface MoveDelta { dx: number; dy: number }

export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  quit(): void
}

declare global {
  interface Window { petApi: PetApi }
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm typecheck`
Expected: PASS(无类型错误;`src/main`/`src/preload` 尚为空但存在;若 tsc 因无输入文件报错,继续下个任务补齐后再验)。

- [ ] **Step 3: 提交**

```bash
git add src/shared/ipc.ts
git commit -m "feat(shared): ipc channel constants and message types"
```

---

### Task 4: 主进程 —— 宠物包加载器(TDD)

**Files:**
- Create: `src/main/petLoader.ts`
- Test: `src/main/petLoader.test.ts`

**Interfaces:**
- Consumes: `parsePetManifest`, `PetManifest`(Task 2)、`LoadedPet`(Task 3)。
- Produces:
  - `function petsDir(appRoot: string): string`（返回 `<appRoot>/pets`）
  - `async function loadPet(petDir: string): Promise<LoadedPet>`（读取 `pet.json` 校验 + 把 `spritesheet.webp` 读成 `data:image/webp;base64,...`）

- [ ] **Step 1: 写失败测试（用仓库内真实的 luluka 宠物包）**

```ts
import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { loadPet } from './petLoader'

const lulukaDir = resolve(__dirname, '../../pets/luluka')

describe('loadPet', () => {
  it('loads luluka manifest and embeds spritesheet as data url', async () => {
    const pet = await loadPet(lulukaDir)
    expect(pet.manifest.id).toBe('luluka')
    expect(pet.manifest.animations.idle.row).toBe(0)
    expect(pet.spritesheetDataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(pet.spritesheetDataUrl.length).toBeGreaterThan(1000)
  })

  it('throws on a directory without pet.json', async () => {
    await expect(loadPet(resolve(__dirname))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/petLoader.test.ts`
Expected: FAIL(`loadPet` 未定义)。

- [ ] **Step 3: 写最小实现**

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePetManifest } from '@shared/petPackage'
import type { LoadedPet } from '@shared/ipc'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

export async function loadPet(petDir: string): Promise<LoadedPet> {
  const manifestRaw = await readFile(join(petDir, 'pet.json'), 'utf-8')
  const manifest = parsePetManifest(JSON.parse(manifestRaw))
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { manifest, spritesheetDataUrl }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/petLoader.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/petLoader.ts src/main/petLoader.test.ts
git commit -m "feat(main): pet package loader with embedded spritesheet"
```

---

### Task 5: 主进程 —— 窗口、IPC、托盘入口

**Files:**
- Create: `src/main/index.ts`
- Create: `resources/tray.png`(16x16 或 32x32 占位图标;可先用 luluka 图集裁一帧另存,或任意 PNG)

**Interfaces:**
- Consumes: `loadPet`, `petsDir`(Task 4)、`IPC`, `MoveDelta`(Task 3)。
- Produces: 可运行的主进程(`pnpm dev` 能起窗口);IPC handler:`GET_PET`(返回 `LoadedPet`)、`MOVE_WINDOW`(按 delta 移窗)、`QUIT`。

- [ ] **Step 1: 写主进程实现**

```ts
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type MoveDelta } from '@shared/ipc'
import { loadPet, petsDir } from './petLoader'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// 开发期 appRoot = 项目根;打包后再调整(MVP-06 处理)
const appRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')

let win: BrowserWindow | null = null
let tray: Tray | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 256,
    height: 288,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(appRoot, 'resources/tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Pet Agent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '退出', click: () => app.quit() }
  ]))
}

function registerIpc(): void {
  ipcMain.handle(IPC.GET_PET, async () => loadPet(join(petsDir(appRoot), 'luluka')))
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
    if (!win) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
  })
  ipcMain.on(IPC.QUIT, () => app.quit())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  createTray()
})

app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
```

- [ ] **Step 2: 放置占位托盘图标**

Run（Windows PowerShell,用已有工具把 luluka 首帧裁成 32x32 存为 tray.png;若嫌麻烦,任意 32x32 PNG 均可）:
```bash
python -c "from PIL import Image; im=Image.open('pets/luluka/spritesheet.webp').crop((0,0,192,208)).resize((32,32)); im.save('resources/tray.png')"
```
Expected: 生成 `resources/tray.png`。

- [ ] **Step 3: 类型检查（此步会因 preload/renderer 尚缺而部分通过,允许;重点是 main 无类型错误）**

Run: `pnpm typecheck`
Expected: `src/main` 相关无错误(若报缺 preload 产物属正常,后续任务补齐)。

- [ ] **Step 4: 提交**

```bash
git add src/main/index.ts resources/tray.png
git commit -m "feat(main): transparent always-on-top window, tray, ipc handlers"
```

---

### Task 6: preload —— 暴露最小安全 API

**Files:**
- Create: `src/preload/index.ts`

**Interfaces:**
- Consumes: `IPC`, `PetApi`, `LoadedPet`, `MoveDelta`(Task 3)。
- Produces: `window.petApi`(`getPet` / `moveWindow` / `quit`),经 `contextBridge` 暴露。

- [ ] **Step 1: 写 preload 实现**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PetApi, type LoadedPet, type MoveDelta } from '@shared/ipc'

const api: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

contextBridge.exposeInMainWorld('petApi', api)
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS(preload 无类型错误)。

- [ ] **Step 3: 提交**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose minimal petApi over contextBridge"
```

---

### Task 7: 渲染层 —— 精灵动画播放 idle

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.ts`
- Create: `src/renderer/spritePlayer.ts`
- Test: `src/renderer/spritePlayer.test.ts`

**Interfaces:**
- Consumes: `PetManifest`, `PetAnimation`, `frameRect`, `frameDurationMs`(Task 2)、`window.petApi`(Task 6)。
- Produces:
  - `class SpritePlayer`(输入 `HTMLCanvasElement`、`HTMLImageElement`、`PetManifest`);方法 `play(state: string)`、`stop()`;内部用 `frameRect`/`frameDurationMs` 逐帧绘制,`loop=false` 停在末帧。
  - 纯逻辑 `nextFrameIndex(current: number, frames: number, loop: boolean): number`(TDD 目标)。

- [ ] **Step 1: 写失败测试(测纯帧推进逻辑)**

```ts
import { describe, it, expect } from 'vitest'
import { nextFrameIndex } from './spritePlayer'

describe('nextFrameIndex', () => {
  it('advances within range', () => {
    expect(nextFrameIndex(0, 6, true)).toBe(1)
  })
  it('loops back to 0 when loop=true', () => {
    expect(nextFrameIndex(5, 6, true)).toBe(0)
  })
  it('holds last frame when loop=false', () => {
    expect(nextFrameIndex(4, 5, false)).toBe(4)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/renderer/spritePlayer.test.ts`
Expected: FAIL(`nextFrameIndex` 未定义)。

- [ ] **Step 3: 写 spritePlayer 实现**

```ts
import { frameRect, frameDurationMs, type PetManifest, type PetAnimation } from '@shared/petPackage'

export function nextFrameIndex(current: number, frames: number, loop: boolean): number {
  const next = current + 1
  if (next < frames) return next
  return loop ? 0 : frames - 1
}

export class SpritePlayer {
  private timer: number | null = null
  private frame = 0
  private state = ''
  constructor(
    private canvas: HTMLCanvasElement,
    private sheet: HTMLImageElement,
    private manifest: PetManifest
  ) {}

  play(state: string): void {
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.tick(anim)
  }

  stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private tick(anim: PetAnimation): void {
    this.draw(anim, this.frame)
    const delay = frameDurationMs(anim, this.frame)
    const next = nextFrameIndex(this.frame, anim.frames, anim.loop)
    if (next === this.frame && !anim.loop) return // held last frame
    this.timer = window.setTimeout(() => {
      this.frame = next
      if (this.manifest.animations[this.state] === anim) this.tick(anim)
    }, delay)
  }

  private draw(anim: PetAnimation, index: number): void {
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d')!
    this.canvas.width = r.w
    this.canvas.height = r.h
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/renderer/spritePlayer.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 `index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'self'" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      #pet { -webkit-app-region: no-drag; cursor: grab; display: block; }
    </style>
  </head>
  <body>
    <canvas id="pet"></canvas>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: 写 `main.ts`(加载宠物 + 播放 idle)**

```ts
import { SpritePlayer } from './spritePlayer'

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  player.play('idle')
}

boot().catch((err) => console.error('boot failed', err))
```

- [ ] **Step 7: 运行应用,肉眼验证**

Run: `pnpm dev`
Expected: 出现一个透明无边框窗口,露露卡以 `idle` 动画循环(呼吸/眨眼),任务栏无图标,托盘有图标可右键退出。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/index.html src/renderer/main.ts src/renderer/spritePlayer.ts src/renderer/spritePlayer.test.ts
git commit -m "feat(renderer): sprite player rendering luluka idle animation"
```

---

### Task 8: 渲染层 —— 拖拽移动窗口

**Files:**
- Modify: `src/renderer/main.ts`(加拖拽监听)

**Interfaces:**
- Consumes: `window.petApi.moveWindow`(Task 6)。
- Produces: 按住宠物拖动 → 窗口跟随移动;拖动时光标为 grabbing。

- [ ] **Step 1: 在 `main.ts` 的 `boot()` 末尾追加拖拽逻辑**

```ts
  // 拖拽移动窗口:用鼠标位移增量通知主进程移窗
  let dragging = false
  let lastX = 0
  let lastY = 0

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true
    lastX = e.screenX
    lastY = e.screenY
    canvas.style.cursor = 'grabbing'
  })
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return
    window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
    lastX = e.screenX
    lastY = e.screenY
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    canvas.style.cursor = 'grab'
  })
```

- [ ] **Step 2: 运行验证**

Run: `pnpm dev`
Expected: 按住露露卡拖动,窗口平滑跟随;松开停止;动画不中断。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 均 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/main.ts
git commit -m "feat(renderer): drag pet to move the window"
```

---

## 完成判据(MVP-01)
- `pnpm install` / `pnpm typecheck` / `pnpm test` / `pnpm dev` 全部可用。
- 启动后透明置顶窗口显示露露卡 `idle` 循环动画,任务栏无图标。
- 可拖拽移动;托盘可退出。
- 单元测试覆盖:manifest 校验、帧矩形、帧时长、帧推进、宠物加载。

## 自检对照(spec 覆盖)
- 设计文档 §3 架构(Electron 主/渲染 + IPC):Task 5/6 ✓
- §4.1 透明置顶窗口 / 拖拽:Task 5/8 ✓
- §4.2 宠物包 / pet.json 契约:Task 2/4 ✓
- §4.3 精灵图布局 / §4.4 状态机基础(idle 播放,walk-left 不翻转的约束已在 Global Constraints 声明,walk 等状态在 MVP-02 接入):Task 7 ✓(状态机完整化留 MVP-02)
- §11.1 Electron 安全(contextIsolation/sandbox/nodeIntegration/CSP):Task 5/7 ✓(基础落地,完整加固在 MVP-06)
- 未覆盖(按计划下移):热键唤出、对话框、Provider、工具、Skill、记忆、打包 → MVP-02~06。
