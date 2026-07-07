# MVP-02 动画状态机 + 唤出对话框壳 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MVP-01 躯壳基础上加一个自主动画状态机(idle/walk/drag/sleep 自动切换)与一个可用单击/全局热键唤出的双态对话框壳(占位回复 + 动画联动,无 LLM)。

**Architecture:** 纯函数状态机 reducer 放 `src/shared/petBrain.ts`(TDD),渲染进程用一个时钟驱动它、把 effects 落成播帧 + 移窗;主进程侧把窗口/托盘/热键/对话窗/占位聊天抽进 `src/main/shell/`,并持有对话 transcript(对话框只是视图)。两进程仍只经 preload 白名单 IPC 通信。

**Tech Stack:** Electron(CJS 主进程/preload)· electron-vite · TypeScript(strict)· Vitest · pnpm。

## Global Constraints

- 包管理器是 **pnpm**(非 npm/yarn)。
- **不要给 `package.json` 加 `"type": "module"`**(会让 Electron 主进程崩)。主进程/preload 必须 CJS。
- 跨进程值走 `src/shared` + `@shared/*` 别名;**IPC 通道名一律用 `IPC` 常量,不硬编码字符串**。
- 新增 IPC 能力必须四文件同步:`src/shared/ipc.ts`(常量 + 类型)、`src/main/*`(handler)、`src/preload/index.ts`(暴露)、渲染层调用方。
- 渲染安全三件套不变:`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`;每个 HTML 带 CSP。
- 纯逻辑 **TDD**(先写失败测试);GUI/Electron 接线靠 `pnpm preview` 真机肉眼验收(**自动化检查过 ≠ 能跑**)。
- 提交粒度小、频繁;**提交信息用中文**,conventional-commit 风格(`feat(scope): ...`)。
- 若 shell 里有 `ELECTRON_RUN_AS_NODE=1` 需先 `unset`,否则 Electron 以纯 Node 跑会崩。
- 单测命令:`pnpm vitest run <file>`;类型检查:`pnpm typecheck`;真机:`pnpm build && pnpm preview`。

---

## 文件结构(本计划涉及)

**新建:**
- `src/shared/petBrain.ts` — 纯状态机 reducer(状态/事件/动画映射/自主调度)
- `src/shared/petBrain.test.ts` — reducer 单测
- `src/renderer/petController.ts` — 渲染层时钟驱动器(调 step、落 effects)
- `src/renderer/dialog.html` — 对话窗渲染入口(自带 CSP)
- `src/renderer/dialog.ts` — 对话窗双态 UI 逻辑
- `src/main/shell/petWindow.ts` — 创建宠物透明置顶窗
- `src/main/shell/dialogWindow.ts` — 对话窗生命周期(toggle/setSize/pushUpdate/定位)
- `src/main/shell/hotkeys.ts` — 全局热键注册/注销
- `src/main/shell/tray.ts` — 托盘图标与菜单
- `src/main/shell/chat.ts` — 主进程持有的对话 transcript + 占位回复
- `src/main/shell/index.ts` — 组装以上 + 注册所有 IPC(`startShell()`)

**修改:**
- `src/shared/ipc.ts` — 新增通道常量 + 类型(`WindowBounds`/`ChatMessage`/…)
- `src/preload/index.ts` — 暴露 `petApi` 扩展 + 新 `chatApi`
- `src/renderer/main.ts` — 接线状态机 + 单击/拖拽区分 + 保留点击穿透
- `src/renderer/spritePlayer.ts` — 画布尺寸提到 `play()` 设一次(顺带清理)
- `src/main/index.ts` — 变薄,仅 `app.whenReady().then(startShell)`
- `electron.vite.config.ts` — renderer 加 `dialog.html` 第二入口
- `PROGRESS.md` — 完成后勾选 MVP-02 + 更新现状

**任务依赖顺序:** Task 1 → 2(纯 reducer)独立可先做;Task 3(shell 抽取,无行为变化)独立;Task 4 依赖 1/2/3;Task 5 依赖 3;Task 6 依赖 4/5;Task 7 依赖 5/6;Task 8 收尾。

---

## Task 1: petBrain reducer — 自主 idle/walk/sleep + 动画映射(纯逻辑 TDD)

**Files:**
- Create: `src/shared/petBrain.ts`
- Test: `src/shared/petBrain.test.ts`

**Interfaces:**
- Produces:
  - `type PetLogicalState = 'idle'|'walk'|'drag'|'sleep'|'greet'|'thinking'|'talk'`
  - `type PetEvent = 'pickup'|'drop'|'wake'|'dialogOpen'|'messageSent'|'replyDone'`
  - `type Direction = 'left'|'right'`
  - `interface Bounds { x:number; y:number; width:number; height:number }`
  - `interface PetBrainConfig { idleDwellMinMs; idleDwellMaxMs; walkProbability; walkSpeedPxPerSec; walkMinPx; walkMaxPx; sleepAfterIdleMs; greetMs; talkMs }`(全 number)
  - `const DEFAULT_BRAIN_CONFIG: PetBrainConfig`
  - `interface PetBrainCtx { state; dir; stateElapsedMs; dwellMs; idleAccumMs; walkRemainingPx; config }`
  - `interface StepInput { dtMs:number; event?:PetEvent; bounds:Bounds; windowX:number; windowWidth:number; rng:()=>number }`
  - `interface StepEffects { animation:string; move:number }`
  - `function animationFor(state:PetLogicalState, dir:Direction): string`
  - `function initBrain(config?:Partial<PetBrainConfig>): PetBrainCtx`
  - `function step(ctx:PetBrainCtx, input:StepInput): { ctx:PetBrainCtx; effects:StepEffects }`
- Note: `applyEvent`(事件处理)在本任务留一个"透传"占位,Task 2 填充完整分支。

- [ ] **Step 1: 写失败测试**

Create `src/shared/petBrain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { initBrain, step, animationFor, DEFAULT_BRAIN_CONFIG, type StepInput } from './petBrain'

const BOUNDS = { x: 0, y: 0, width: 1000, height: 800 }

function rngSeq(values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0)
}

function input(partial: Partial<StepInput> = {}): StepInput {
  return { dtMs: 100, bounds: BOUNDS, windowX: 500, windowWidth: 256, rng: () => 0, ...partial }
}

describe('petBrain autonomous', () => {
  it('maps walk to a directional animation, other states to their own name', () => {
    expect(animationFor('walk', 'left')).toBe('walk-left')
    expect(animationFor('walk', 'right')).toBe('walk-right')
    expect(animationFor('idle', 'right')).toBe('idle')
    expect(animationFor('sleep', 'left')).toBe('sleep')
  })

  it('starts in idle', () => {
    expect(initBrain().state).toBe('idle')
  })

  it('transitions idle → walk after dwell when rng favors walking', () => {
    const ctx = initBrain() // dwellMs = idleDwellMinMs = 2000
    const res = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.5]) }))
    expect(res.ctx.state).toBe('walk')
    expect(res.ctx.dir).toBe('right')
    expect(res.ctx.walkRemainingPx).toBeGreaterThan(0)
  })

  it('stays idle and re-rolls dwell when rng favors staying', () => {
    const ctx = initBrain()
    const res = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.9, 0.3]) }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.stateElapsedMs).toBe(0)
  })

  it('emits directional movement while walking and returns to idle when distance consumed', () => {
    let ctx = initBrain()
    ctx = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.5]) })).ctx // walk right, dist 170
    const res = step(ctx, input({ dtMs: 1000, windowX: 500, rng: () => 0.9 }))
    expect(res.effects.move).toBeCloseTo(40) // 40px/s * 1s
    expect(res.ctx.walkRemainingPx).toBeCloseTo(130)
    expect(res.ctx.state).toBe('walk')
  })

  it('clamps at work-area edge and ends the walk', () => {
    let ctx = initBrain()
    ctx = step(ctx, input({ dtMs: 2100, rng: rngSeq([0.1, 0.9, 0.9]) })).ctx // walk right, dist ~242
    const res = step(ctx, input({ dtMs: 1000, windowX: 730, rng: () => 0 })) // maxX = 1000-256 = 744
    expect(res.effects.move).toBeCloseTo(14)
    expect(res.ctx.state).toBe('idle')
  })

  it('falls asleep after prolonged idle without interaction', () => {
    let res = { ctx: initBrain(), effects: { animation: 'idle', move: 0 } }
    let total = 0
    while (total < DEFAULT_BRAIN_CONFIG.sleepAfterIdleMs) {
      res = step(res.ctx, input({ dtMs: 5000, rng: () => 0.9 })) // always stay idle
      total += 5000
    }
    expect(res.ctx.state).toBe('sleep')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: FAIL(`Cannot find module './petBrain'` 或导出未定义)。

- [ ] **Step 3: 实现 reducer(自主部分 + 事件透传占位)**

Create `src/shared/petBrain.ts`:

```ts
export type PetLogicalState = 'idle' | 'walk' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'
export type PetEvent = 'pickup' | 'drop' | 'wake' | 'dialogOpen' | 'messageSent' | 'replyDone'
export type Direction = 'left' | 'right'

export interface Bounds { x: number; y: number; width: number; height: number }

export interface PetBrainConfig {
  idleDwellMinMs: number
  idleDwellMaxMs: number
  walkProbability: number
  walkSpeedPxPerSec: number
  walkMinPx: number
  walkMaxPx: number
  sleepAfterIdleMs: number
  greetMs: number
  talkMs: number
}

export const DEFAULT_BRAIN_CONFIG: PetBrainConfig = {
  idleDwellMinMs: 2000,
  idleDwellMaxMs: 6000,
  walkProbability: 0.6,
  walkSpeedPxPerSec: 40,
  walkMinPx: 80,
  walkMaxPx: 260,
  sleepAfterIdleMs: 45000,
  greetMs: 900,
  talkMs: 1200
}

export interface PetBrainCtx {
  state: PetLogicalState
  dir: Direction
  stateElapsedMs: number
  dwellMs: number
  idleAccumMs: number
  walkRemainingPx: number
  config: PetBrainConfig
}

export interface StepInput {
  dtMs: number
  event?: PetEvent
  bounds: Bounds
  windowX: number
  windowWidth: number
  rng: () => number
}

export interface StepEffects { animation: string; move: number }

export function animationFor(state: PetLogicalState, dir: Direction): string {
  if (state === 'walk') return dir === 'left' ? 'walk-left' : 'walk-right'
  return state
}

export function initBrain(config: Partial<PetBrainConfig> = {}): PetBrainCtx {
  const cfg = { ...DEFAULT_BRAIN_CONFIG, ...config }
  return {
    state: 'idle',
    dir: 'right',
    stateElapsedMs: 0,
    dwellMs: cfg.idleDwellMinMs,
    idleAccumMs: 0,
    walkRemainingPx: 0,
    config: cfg
  }
}

function enterState(ctx: PetBrainCtx, state: PetLogicalState): PetBrainCtx {
  return { ...ctx, state, stateElapsedMs: 0 }
}

function enterIdle(ctx: PetBrainCtx, rng: () => number): PetBrainCtx {
  const cfg = ctx.config
  return {
    ...ctx,
    state: 'idle',
    stateElapsedMs: 0,
    dwellMs: cfg.idleDwellMinMs + rng() * (cfg.idleDwellMaxMs - cfg.idleDwellMinMs)
  }
}

function enterWalk(ctx: PetBrainCtx, rng: () => number): PetBrainCtx {
  const cfg = ctx.config
  const dir: Direction = rng() < 0.5 ? 'left' : 'right'
  const dist = cfg.walkMinPx + rng() * (cfg.walkMaxPx - cfg.walkMinPx)
  return { ...ctx, state: 'walk', dir, stateElapsedMs: 0, walkRemainingPx: dist }
}

// Task 2 会把各事件分支填满;此处先透传(仅供 Task 1 通过)。
function applyEvent(ctx: PetBrainCtx, _event: PetEvent, _rng: () => number): PetBrainCtx {
  return ctx
}

export function step(ctx: PetBrainCtx, input: StepInput): { ctx: PetBrainCtx; effects: StepEffects } {
  const cfg = ctx.config
  let next: PetBrainCtx = {
    ...ctx,
    stateElapsedMs: ctx.stateElapsedMs + input.dtMs,
    idleAccumMs: ctx.idleAccumMs + input.dtMs
  }
  let move = 0

  if (input.event) next = applyEvent(next, input.event, input.rng)

  switch (next.state) {
    case 'idle': {
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) { next = enterState(next, 'sleep'); break }
      if (next.stateElapsedMs >= next.dwellMs) {
        next = input.rng() < cfg.walkProbability ? enterWalk(next, input.rng) : enterIdle(next, input.rng)
      }
      break
    }
    case 'walk': {
      if (next.idleAccumMs >= cfg.sleepAfterIdleMs) { next = enterState(next, 'sleep'); break }
      const stepPx = cfg.walkSpeedPxPerSec * (input.dtMs / 1000)
      let dx = next.dir === 'left' ? -stepPx : stepPx
      const minX = input.bounds.x
      const maxX = input.bounds.x + input.bounds.width - input.windowWidth
      const targetX = input.windowX + dx
      let hitEdge = false
      if (targetX <= minX) { dx = minX - input.windowX; hitEdge = true }
      else if (targetX >= maxX) { dx = maxX - input.windowX; hitEdge = true }
      move = dx
      next = { ...next, walkRemainingPx: next.walkRemainingPx - Math.abs(dx) }
      if (hitEdge || next.walkRemainingPx <= 0) next = enterIdle(next, input.rng)
      break
    }
    case 'greet': {
      if (next.stateElapsedMs >= cfg.greetMs) next = enterIdle(next, input.rng)
      break
    }
    case 'talk': {
      if (next.stateElapsedMs >= cfg.talkMs) next = enterIdle(next, input.rng)
      break
    }
    // 'drag' / 'thinking' / 'sleep' 持续,直到相应事件(Task 2)
  }

  return { ctx: next, effects: { animation: animationFor(next.state, next.dir), move } }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: PASS(7 个用例全绿)。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/shared/petBrain.ts src/shared/petBrain.test.ts
git commit -m "feat(brain): 纯函数状态机 reducer(自主 idle/walk/sleep + 动画映射)"
```

---

## Task 2: petBrain reducer — 外部事件分支(纯逻辑 TDD)

**Files:**
- Modify: `src/shared/petBrain.ts`(替换 `applyEvent` 实现)
- Test: `src/shared/petBrain.test.ts`(追加事件用例)

**Interfaces:**
- Consumes: Task 1 的 `PetBrainCtx` / `PetEvent` / `enterState` / `enterIdle`。
- Produces: 完整的 `applyEvent(ctx, event, rng)` 语义 —— `pickup→drag`、`drop→idle`、`wake→idle`、`dialogOpen→greet`、`messageSent→thinking`、`replyDone→talk`;所有事件把 `idleAccumMs` 归 0(交互重置睡眠计时)。

- [ ] **Step 1: 追加失败测试**

在 `src/shared/petBrain.test.ts` 末尾追加:

```ts
describe('petBrain events', () => {
  it('pickup → drag, drop → idle', () => {
    let res = step(initBrain(), input({ event: 'pickup' }))
    expect(res.ctx.state).toBe('drag')
    res = step(res.ctx, input({ event: 'drop', rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('messageSent → thinking (persists), replyDone → talk → idle', () => {
    let res = step(initBrain(), input({ event: 'messageSent' }))
    expect(res.ctx.state).toBe('thinking')
    res = step(res.ctx, input({ dtMs: 5000 })) // persists without event
    expect(res.ctx.state).toBe('thinking')
    res = step(res.ctx, input({ event: 'replyDone' }))
    expect(res.ctx.state).toBe('talk')
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.talkMs + 10, rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('dialogOpen → greet → idle after greetMs', () => {
    let res = step(initBrain(), input({ event: 'dialogOpen' }))
    expect(res.ctx.state).toBe('greet')
    res = step(res.ctx, input({ dtMs: DEFAULT_BRAIN_CONFIG.greetMs + 10, rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
  })

  it('wake from sleep returns to idle and resets the sleep timer', () => {
    const sleeping = { ...initBrain(), state: 'sleep' as const, idleAccumMs: 99999 }
    const res = step(sleeping, input({ event: 'wake', rng: () => 0.5 }))
    expect(res.ctx.state).toBe('idle')
    expect(res.ctx.idleAccumMs).toBe(0)
  })

  it('any interaction resets the sleep timer (pickup)', () => {
    const almost = { ...initBrain(), idleAccumMs: 40000 }
    const res = step(almost, input({ event: 'pickup' }))
    expect(res.ctx.idleAccumMs).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: FAIL(新 `describe('petBrain events')` 里的用例红:如 pickup 后仍是 idle)。

- [ ] **Step 3: 实现 applyEvent**

替换 `src/shared/petBrain.ts` 中的占位 `applyEvent`:

```ts
function applyEvent(ctx: PetBrainCtx, event: PetEvent, rng: () => number): PetBrainCtx {
  switch (event) {
    case 'pickup': return { ...enterState(ctx, 'drag'), idleAccumMs: 0 }
    case 'drop': return { ...enterIdle(ctx, rng), idleAccumMs: 0 }
    case 'wake': return { ...enterIdle(ctx, rng), idleAccumMs: 0 }
    case 'dialogOpen': return { ...enterState(ctx, 'greet'), idleAccumMs: 0 }
    case 'messageSent': return { ...enterState(ctx, 'thinking'), idleAccumMs: 0 }
    case 'replyDone': return { ...enterState(ctx, 'talk'), idleAccumMs: 0 }
    default: return ctx
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: PASS(全部用例绿,含 Task 1 的)。

- [ ] **Step 5: 提交**

```bash
git add src/shared/petBrain.ts src/shared/petBrain.test.ts
git commit -m "feat(brain): 状态机外部事件分支(拖拽/唤醒/对话事件)"
```

---

## Task 3: 主进程 shell 抽取(重构,无行为变化)

把 MVP-01 内联在 `src/main/index.ts` 的窗口/托盘/IPC 迁进 `src/main/shell/`,`index.ts` 变薄。**此任务不加任何新功能**,`pnpm preview` 行为应与 MVP-01 完全一致。

**Files:**
- Create: `src/main/shell/petWindow.ts`、`src/main/shell/tray.ts`、`src/main/shell/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces:
  - `createPetWindow(opts:{ preload:string; url:string|undefined; indexHtml:string }): BrowserWindow`
  - `createTray(iconPath:string): Tray`
  - `startShell(): void` —— 组装宠物窗 + 托盘 + 现有 IPC(`GET_PET`/`MOVE_WINDOW`/`SET_IGNORE_MOUSE`/`QUIT`)。

- [ ] **Step 1: 抽 petWindow.ts**

Create `src/main/shell/petWindow.ts`:

```ts
import { BrowserWindow } from 'electron'

export function createPetWindow(opts: { preload: string; url: string | undefined; indexHtml: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: 256,
    height: 288,
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
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.indexHtml)
  return win
}
```

- [ ] **Step 2: 抽 tray.ts**

Create `src/main/shell/tray.ts`:

```ts
import { Tray, Menu, nativeImage, app } from 'electron'

export function createTray(iconPath: string): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Pet Agent')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '退出', click: () => app.quit() }]))
  return tray
}
```

- [ ] **Step 3: 写 shell/index.ts(迁入现有 IPC)**

Create `src/main/shell/index.ts`:

```ts
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type MoveDelta } from '@shared/ipc'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow } from './petWindow'
import { createTray } from './tray'

export function startShell(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url)) // out/main
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const petHtml = join(dirname, '../renderer/index.html')
  const petDir = join(petsDir(appRoot), 'luluka')

  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })

  ipcMain.handle(IPC.GET_PET, async () => loadPet(petDir))
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
    const [x, y] = petWin.getPosition()
    petWin.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
  })
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.QUIT, () => app.quit())

  createTray(join(appRoot, 'resources/tray.png'))
}
```

- [ ] **Step 4: 让 index.ts 变薄**

Replace 全文 `src/main/index.ts`:

```ts
import { app } from 'electron'
import { startShell } from './shell'

app.whenReady().then(() => startShell())
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误。

- [ ] **Step 6: 真机验收(行为不回归)**

Run: `pnpm preview`
Expected(逐一肉眼确认):透明置顶窗显示 luluka、播 idle、可拖拽移动、托盘右键可退出、任务栏无图标、透明区域点击穿透。**与 MVP-01 一致,无任何变化。**

- [ ] **Step 7: 提交**

```bash
git add src/main/shell src/main/index.ts
git commit -m "refactor(shell): 窗口/托盘/IPC 抽入 src/main/shell,index 变薄"
```

---

## Task 4: 状态机接入渲染层(宠物自主走动/睡觉/拖拽动画)

新增 `GET_WINDOW_BOUNDS` IPC;渲染层用 `PetController` 驱动 `petBrain`;拖拽切 `drag` 动画。对话相关(单击唤出)留到 Task 5。

**Files:**
- Modify: `src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/shell/index.ts`
- Create: `src/renderer/petController.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `petBrain`(Task 1/2)。
- Produces:
  - ipc 常量 `GET_WINDOW_BOUNDS: 'window:get-bounds'`
  - `interface Bounds { x; y; width; height }`(number)与 `interface WindowBounds { workArea: Bounds; window: Bounds }`(放 `@shared/ipc`)
  - `PetApi.getWindowBounds(): Promise<WindowBounds>`
  - `class PetController { constructor(player: SpritePlayer); start(): Promise<void>; stop(): void; send(event: PetEvent): void; syncBounds(): Promise<void> }`

- [ ] **Step 1: 扩 ipc.ts(通道 + 类型)**

Modify `src/shared/ipc.ts` —— 顶部加 import,`IPC` 加常量,新增 `Bounds`/`WindowBounds`,`PetApi` 加方法:

```ts
import type { PetManifest } from './petPackage'
import type { PetEvent } from './petBrain'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  QUIT: 'app:quit'
} as const

export interface LoadedPet {
  manifest: PetManifest
  spritesheetDataUrl: string
}

export interface MoveDelta { dx: number; dy: number }

export interface Bounds { x: number; y: number; width: number; height: number }
export interface WindowBounds { workArea: Bounds; window: Bounds }

export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  quit(): void
}

declare global {
  interface Window { petApi: PetApi }
}

export type { PetEvent }
```

> 说明:从 `./petBrain` 引入 `PetEvent` 只作类型用途;`petBrain` 不反向依赖 `ipc`,无循环。`export type { PetEvent }` 方便渲染层从 `@shared/ipc` 一处取。

- [ ] **Step 2: preload 暴露 getWindowBounds**

Modify `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PetApi, type LoadedPet, type MoveDelta, type WindowBounds } from '@shared/ipc'

const api: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

contextBridge.exposeInMainWorld('petApi', api)
```

- [ ] **Step 3: 主进程实现 GET_WINDOW_BOUNDS**

Modify `src/main/shell/index.ts` —— import 加 `screen` 与 `WindowBounds`,在 `QUIT` handler 前插入:

```ts
  ipcMain.handle(IPC.GET_WINDOW_BOUNDS, async (): Promise<WindowBounds> => {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    const workArea = screen.getDisplayMatching({ x, y, width, height }).workArea
    return { workArea, window: { x, y, width, height } }
  })
```

顶部 import 改为:

```ts
import { app, ipcMain, screen } from 'electron'
```

并把 `import { IPC, type MoveDelta } from '@shared/ipc'` 改为:

```ts
import { IPC, type MoveDelta, type WindowBounds } from '@shared/ipc'
```

- [ ] **Step 4: 写 PetController**

Create `src/renderer/petController.ts`:

```ts
import { SpritePlayer } from './spritePlayer'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'

const TICK_MS = 33

export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private currentAnim = ''

  constructor(private player: SpritePlayer) {}

  async start(): Promise<void> {
    await this.syncBounds()
    this.lastTs = performance.now()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
  }

  send(event: PetEvent): void { this.pending.push(event) }

  async syncBounds(): Promise<void> {
    const b = await window.petApi.getWindowBounds()
    this.workArea = b.workArea
    this.windowX = b.window.x
    this.windowWidth = b.window.width
  }

  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now
    const event = this.pending.shift()
    const { ctx, effects } = step(this.ctx, {
      dtMs,
      event,
      bounds: this.workArea,
      windowX: this.windowX,
      windowWidth: this.windowWidth,
      rng: Math.random
    })
    this.ctx = ctx
    if (effects.animation !== this.currentAnim) {
      this.player.play(effects.animation)
      this.currentAnim = effects.animation
    }
    if (effects.move !== 0) {
      window.petApi.moveWindow({ dx: effects.move, dy: 0 })
      this.windowX += effects.move
    }
  }
}
```

- [ ] **Step 5: main.ts 接线状态机 + 拖拽事件**

Replace 全文 `src/renderer/main.ts`:

```ts
import { SpritePlayer } from './spritePlayer'
import { PetController } from './petController'

const DRAG_THRESHOLD = 4

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  const controller = new PetController(player)
  await controller.start()

  let dragging = false
  let moved = false
  let ignoring = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0

  function setIgnore(ignore: boolean): void {
    if (ignore === ignoring) return
    ignoring = ignore
    window.petApi.setIgnoreMouseEvents(ignore)
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true
    moved = false
    lastX = e.screenX; lastY = e.screenY
    downX = e.screenX; downY = e.screenY
    canvas.style.cursor = 'grabbing'
  })

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging) {
      if (!moved && Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY) > DRAG_THRESHOLD) {
        moved = true
        controller.send('pickup')
      }
      if (moved) {
        window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
        lastX = e.screenX; lastY = e.screenY
      }
      return
    }
    setIgnore(!player.isPetPixel(e.clientX, e.clientY))
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved) {
      controller.send('drop')
      void controller.syncBounds() // 手动拖动后重新同步窗口 X
    }
  })
}

boot().catch((err) => console.error('boot failed', err))
```

> 注:单击(未越阈值)在本任务不做动作;Task 5 补 `toggleDialog()`。

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 7: 真机验收**

Run: `pnpm preview`
Expected(肉眼):① 宠物自己会水平游走后停下、再随机走(idle↔walk);② 长时间不动(约 45s)会切 sleep;③ 拖拽时切 drag 动画、放下回 idle;④ 走动不会走出屏幕工作区边缘;⑤ 透明区域点击仍穿透。

- [ ] **Step 8: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts src/renderer/petController.ts src/renderer/main.ts
git commit -m "feat(pet): 状态机接入渲染层,宠物自主游走/睡觉 + 拖拽动画"
```

---

## Task 5: 对话窗 + 第二渲染入口 + 单击/热键唤出(空壳)

先让一个空对话窗能被单击宠物或 `Ctrl+Shift+Space` 开/关。占位聊天逻辑留 Task 6,双态 UI 留 Task 7。

**Files:**
- Modify: `electron.vite.config.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/shell/index.ts`、`src/renderer/main.ts`
- Create: `src/renderer/dialog.html`、`src/renderer/dialog.ts`、`src/main/shell/dialogWindow.ts`、`src/main/shell/hotkeys.ts`

**Interfaces:**
- Produces:
  - ipc 常量 `TOGGLE_DIALOG: 'dialog:toggle'`、`PET_EVENT: 'pet:event'`
  - `PetApi.toggleDialog(): void`、`PetApi.onPetEvent(cb:(e:PetEvent)=>void): void`
  - `createDialogController(opts): DialogController`,`DialogController = { toggle(getPetBounds):void; isOpen():boolean; setSize(collapsed:boolean):void; pushUpdate(msgs:ChatMessage[]):void; window():BrowserWindow|null }`
  - `registerHotkeys(onToggle:()=>void): void`、`unregisterHotkeys(): void`
- Consumes: Task 4 的 `PetController.send`。

- [ ] **Step 1: electron.vite.config 加第二入口**

Modify `electron.vite.config.ts` —— renderer 的 rollupOptions.input:

```ts
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          dialog: resolve('src/renderer/dialog.html')
        }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
```

- [ ] **Step 2: 扩 ipc.ts(TOGGLE_DIALOG / PET_EVENT + ChatMessage 类型)**

Modify `src/shared/ipc.ts` —— `IPC` 常量加两项,并新增聊天类型(供后续任务复用)与 `PetApi` 方法:

```ts
export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  TOGGLE_DIALOG: 'dialog:toggle',
  DIALOG_SET_SIZE: 'dialog:set-size',
  CHAT_SEND: 'chat:send',
  CHAT_UPDATE: 'chat:update',
  PET_EVENT: 'pet:event',
  QUIT: 'app:quit'
} as const

export interface ChatAttachment { kind: 'image' }
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[] }
export interface ChatSendPayload { text: string; attachments?: ChatAttachment[] }
```

`PetApi` 追加两方法:

```ts
export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  toggleDialog(): void
  onPetEvent(cb: (event: PetEvent) => void): void
  quit(): void
}
```

并新增 `ChatApi` + 全局声明(供 Task 6/7 的对话窗使用):

```ts
export interface ChatApi {
  send(payload: ChatSendPayload): void
  onUpdate(cb: (messages: ChatMessage[]) => void): void
  setSize(collapsed: boolean): void
  close(): void
}

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi }
}
```

> 把原来的 `declare global { interface Window { petApi: PetApi } }` 替换为上面这段(合并 petApi + chatApi)。

- [ ] **Step 3: preload 暴露 toggleDialog/onPetEvent + chatApi**

Modify `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent
} from '@shared/ipc'

const petApi: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  toggleDialog: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  onPetEvent: (cb: (event: PetEvent) => void): void => {
    ipcRenderer.on(IPC.PET_EVENT, (_e, event: PetEvent) => cb(event))
  },
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

const chatApi: ChatApi = {
  send: (payload: ChatSendPayload): void => ipcRenderer.send(IPC.CHAT_SEND, payload),
  onUpdate: (cb: (messages: ChatMessage[]) => void): void => {
    ipcRenderer.on(IPC.CHAT_UPDATE, (_e, messages: ChatMessage[]) => cb(messages))
  },
  setSize: (collapsed: boolean): void => ipcRenderer.send(IPC.DIALOG_SET_SIZE, collapsed),
  close: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG)
}

contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('chatApi', chatApi)
```

- [ ] **Step 4: 写 hotkeys.ts**

Create `src/main/shell/hotkeys.ts`:

```ts
import { globalShortcut } from 'electron'

const ACCELERATOR = 'CommandOrControl+Shift+Space'

export function registerHotkeys(onToggle: () => void): void {
  const ok = globalShortcut.register(ACCELERATOR, onToggle)
  if (!ok) console.warn(`[hotkeys] 注册失败: ${ACCELERATOR}(可能被占用)`)
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}
```

- [ ] **Step 5: 写 dialogWindow.ts(空壳,可 toggle/定位)**

Create `src/main/shell/dialogWindow.ts`:

```ts
import { BrowserWindow } from 'electron'
import { IPC, type ChatMessage } from '@shared/ipc'

const COLLAPSED = { width: 320, height: 130 }
const EXPANDED = { width: 320, height: 440 }

export interface DialogController {
  toggle(getPetBounds: () => { x: number; y: number; width: number }): void
  isOpen(): boolean
  setSize(collapsed: boolean): void
  pushUpdate(messages: ChatMessage[]): void
  window(): BrowserWindow | null
}

export function createDialogController(opts: {
  preload: string
  url: string | undefined // dialog.html 的 dev URL(含 /dialog.html),打包为 undefined
  dialogHtml: string
  onOpened: () => void
}): DialogController {
  let win: BrowserWindow | null = null
  let collapsed = true

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: COLLAPSED.width,
      height: COLLAPSED.height,
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    if (opts.url) w.loadURL(opts.url)
    else w.loadFile(opts.dialogHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    window: () => win,
    isOpen: () => !!win && win.isVisible(),
    setSize(c: boolean): void {
      collapsed = c
      if (!win) return
      const s = c ? COLLAPSED : EXPANDED
      win.setSize(s.width, s.height)
    },
    pushUpdate(messages: ChatMessage[]): void {
      win?.webContents.send(IPC.CHAT_UPDATE, messages)
    },
    toggle(getPetBounds): void {
      if (win && win.isVisible()) { win.hide(); return }
      if (!win) win = build()
      const pet = getPetBounds()
      const s = collapsed ? COLLAPSED : EXPANDED
      win.setBounds({ x: pet.x + pet.width, y: pet.y, width: s.width, height: s.height })
      win.show()
      win.focus()
      opts.onOpened()
    }
  }
}
```

- [ ] **Step 6: shell/index.ts 组装对话窗 + 热键 + 新 IPC**

Modify `src/main/shell/index.ts` —— 完整替换为:

```ts
import { app, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type MoveDelta, type WindowBounds } from '@shared/ipc'
import type { PetEvent } from '@shared/petBrain'
import { loadPet, petsDir } from '../petLoader'
import { createPetWindow } from './petWindow'
import { createTray } from './tray'
import { createDialogController } from './dialogWindow'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'

export function startShell(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url)) // out/main
  const appRoot = app.isPackaged ? process.resourcesPath : join(dirname, '../..')
  const preload = join(dirname, '../preload/index.js')
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const petHtml = join(dirname, '../renderer/index.html')
  const dialogHtml = join(dirname, '../renderer/dialog.html')
  const petDir = join(petsDir(appRoot), 'luluka')

  const petWin = createPetWindow({ preload, url: rendererUrl, indexHtml: petHtml })

  function emitPetEvent(event: PetEvent): void {
    petWin.webContents.send(IPC.PET_EVENT, event)
  }

  const dialog = createDialogController({
    preload,
    url: rendererUrl ? `${rendererUrl}/dialog.html` : undefined,
    dialogHtml,
    onOpened: () => emitPetEvent('dialogOpen')
  })

  function petBounds(): { x: number; y: number; width: number } {
    const [x, y] = petWin.getPosition()
    const [width] = petWin.getSize()
    return { x, y, width }
  }
  function toggleDialog(): void { dialog.toggle(petBounds) }

  ipcMain.handle(IPC.GET_PET, async () => loadPet(petDir))
  ipcMain.handle(IPC.GET_WINDOW_BOUNDS, async (): Promise<WindowBounds> => {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    const workArea = screen.getDisplayMatching({ x, y, width, height }).workArea
    return { workArea, window: { x, y, width, height } }
  })
  ipcMain.on(IPC.MOVE_WINDOW, (_e, delta: MoveDelta) => {
    const [x, y] = petWin.getPosition()
    petWin.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
  })
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    petWin.setIgnoreMouseEvents(ignore, { forward: true })
  })
  ipcMain.on(IPC.TOGGLE_DIALOG, () => toggleDialog())
  ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, collapsed: boolean) => dialog.setSize(!!collapsed))
  ipcMain.on(IPC.QUIT, () => app.quit())

  registerHotkeys(toggleDialog)
  createTray(join(appRoot, 'resources/tray.png'))

  app.on('will-quit', () => unregisterHotkeys())
}
```

- [ ] **Step 7: 写占位 dialog.html + dialog.ts(先能显示)**

Create `src/renderer/dialog.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: system-ui, sans-serif; }
      #panel { box-sizing: border-box; height: 100%; padding: 8px; background: rgba(30, 30, 40, 0.9);
               border-radius: 14px; color: #f0f0f4; display: flex; flex-direction: column; }
    </style>
  </head>
  <body>
    <div id="panel">对话框(占位)</div>
    <script type="module" src="./dialog.ts"></script>
  </body>
</html>
```

Create `src/renderer/dialog.ts`:

```ts
// Task 6/7 会填充真实逻辑;此处仅确保入口可加载。
console.log('dialog window loaded')
```

- [ ] **Step 8: main.ts 单击唤出 + 接收 PET_EVENT**

Modify `src/renderer/main.ts` —— 在 `await controller.start()` 之后加一行订阅,并在 `mouseup` 里补单击分支:

在 `await controller.start()` 下一行加:

```ts
  window.petApi.onPetEvent((event) => controller.send(event))
```

把 `mouseup` 处理替换为:

```ts
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved) {
      controller.send('drop')
      void controller.syncBounds()
    } else {
      window.petApi.toggleDialog() // 未越阈值 = 单击 → 开/关对话框
    }
  })
```

- [ ] **Step 9: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误;`out/renderer/dialog.html` 已产出。

- [ ] **Step 10: 真机验收**

Run: `pnpm preview`
Expected:① 单击宠物 → 宠物旁弹出深色占位对话框、且宠物播一次 greet;② 再次单击宠物 → 对话框隐藏;③ 按 `Ctrl+Shift+Space` 可开/关(在别的窗口聚焦时也生效);④ 拖拽仍只移窗、不弹框;⑤ 退出后热键失效(不残留)。

- [ ] **Step 11: 提交**

```bash
git add electron.vite.config.ts src/shared/ipc.ts src/preload/index.ts src/main/shell/dialogWindow.ts src/main/shell/hotkeys.ts src/main/shell/index.ts src/renderer/dialog.html src/renderer/dialog.ts src/renderer/main.ts
git commit -m "feat(dialog): 独立对话窗 + 单击/全局热键唤出(空壳)"
```

---

## Task 6: 占位聊天闭环(主进程持有 transcript + 动画联动)

**Files:**
- Create: `src/main/shell/chat.ts`
- Modify: `src/main/shell/index.ts`、`src/renderer/dialog.ts`

**Interfaces:**
- Produces: `createChatStore(opts:{ petDir:string; emitPetEvent:(e:PetEvent)=>void; pushUpdate:(msgs:ChatMessage[])=>void }): { messages():ChatMessage[]; handleSend(payload:ChatSendPayload):void }`
- Consumes: `dialog.pushUpdate`(Task 5)、`emitPetEvent`(Task 5)、`chatApi`(Task 5)。

- [ ] **Step 1: 写 chat.ts(transcript + 占位回复)**

Create `src/main/shell/chat.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ChatSendPayload } from '@shared/ipc'
import type { PetEvent } from '@shared/petBrain'

const REPLY_DELAY_MS = 800
const FALLBACK_REPLY = '(还没接上大脑,等我 MVP-03 再好好聊~)'

export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
}

export function createChatStore(opts: {
  petDir: string
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
}): ChatStore {
  const transcript: ChatMessage[] = []
  let timer: NodeJS.Timeout | null = null

  function placeholderReply(): string {
    try {
      const raw = JSON.parse(readFileSync(join(opts.petDir, 'lines.json'), 'utf-8')) as Record<string, Array<{ text?: string }>>
      const pool = [...(raw.task_done ?? []), ...(raw.greet ?? [])]
      const picked = pool[Math.floor(Math.random() * pool.length)]
      if (picked && typeof picked.text === 'string' && picked.text.length > 0) return picked.text
    } catch {
      /* lines.json 可选,缺失/损坏则用兜底串 */
    }
    return FALLBACK_REPLY
  }

  return {
    messages: () => transcript,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      if (!text) return
      transcript.push({ role: 'user', text })
      opts.pushUpdate(transcript)
      opts.emitPetEvent('messageSent')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        transcript.push({ role: 'pet', text: placeholderReply() })
        opts.pushUpdate(transcript)
        opts.emitPetEvent('replyDone')
        timer = null
      }, REPLY_DELAY_MS)
    }
  }
}
```

- [ ] **Step 2: shell/index.ts 接 chat store + CHAT_SEND + 开窗推 transcript**

Modify `src/main/shell/index.ts`:

顶部 import 追加:

```ts
import { IPC, type MoveDelta, type WindowBounds, type ChatSendPayload } from '@shared/ipc'
import { createChatStore } from './chat'
```

(即把原 `import { IPC, type MoveDelta, type WindowBounds } ...` 那行替换为含 `ChatSendPayload` 的版本,并新增 `createChatStore` import。)

把 `dialog` 的构造改为在 `onOpened` 里同时推当前 transcript,并在其后创建 `chat`:

```ts
  const dialog = createDialogController({
    preload,
    url: rendererUrl ? `${rendererUrl}/dialog.html` : undefined,
    dialogHtml,
    onOpened: () => {
      emitPetEvent('dialogOpen')
      dialog.pushUpdate(chat.messages())
    }
  })

  const chat = createChatStore({
    petDir,
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs)
  })
```

> `chat` 在 `dialog` 的 `onOpened` 闭包里被引用但在其后声明:`onOpened` 只在运行时(开窗后)调用,届时 `chat` 已初始化,无 TDZ 问题。

在 IPC 区加 `CHAT_SEND` handler(放 `TOGGLE_DIALOG` 附近):

```ts
  ipcMain.on(IPC.CHAT_SEND, (_e, payload: ChatSendPayload) => chat.handleSend(payload))
```

- [ ] **Step 3: dialog.ts 发送 + 渲染(仍用占位布局)**

Replace `src/renderer/dialog.ts`:

```ts
import type { ChatMessage } from '@shared/ipc'

const panel = document.getElementById('panel') as HTMLElement

function render(messages: ChatMessage[]): void {
  panel.innerHTML = ''
  const list = document.createElement('div')
  for (const m of messages) {
    const el = document.createElement('div')
    el.textContent = `${m.role === 'user' ? '你' : '露露卡'}: ${m.text}`
    list.appendChild(el)
  }
  panel.appendChild(list)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '说点什么…'
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim()
      if (text) { window.chatApi.send({ text }); input.value = '' }
    }
  })
  panel.appendChild(input)
  input.focus()
}

window.chatApi.onUpdate(render)
render([]) // 初始空
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 5: 真机验收**

Run: `pnpm preview`
Expected:① 单击开对话框,输入文字回车 → 出现"你: …";② 约 0.8s 后出现"露露卡: …"(luluka `lines.json` 里的一句,或兜底串);③ 发送瞬间宠物播 thinking,回复出现时播 talk,随后回 idle;④ 关掉再开对话框,历史消息仍在(transcript 存主进程)。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/chat.ts src/main/shell/index.ts src/renderer/dialog.ts
git commit -m "feat(chat): 主进程持有对话 transcript + 占位回复 + 宠物动画联动"
```

---

## Task 7: 对话窗双态 UI(常态薄条 + 展开面板 + 气泡淡出)

**Files:**
- Modify: `src/renderer/dialog.html`、`src/renderer/dialog.ts`

**Interfaces:**
- Consumes: `chatApi.onUpdate`/`send`/`setSize`(Task 5),transcript 推送(Task 6)。
- 无新导出;`DIALOG_SET_SIZE` 已在 Task 5 打通。

- [ ] **Step 1: 重写 dialog.html(双态结构 + 样式)**

Replace `src/renderer/dialog.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; }
      #panel { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; gap: 6px;
               padding: 8px; color: #f0f0f4; }

      /* 气泡:仅常态显示最新回复,可淡出 */
      #bubble { align-self: flex-start; max-width: 90%; padding: 6px 10px; border-radius: 12px;
                background: rgba(60, 60, 80, 0.95); opacity: 0; transition: opacity 0.6s ease;
                pointer-events: none; }
      #bubble.show { opacity: 1; }
      #panel.expanded #bubble { display: none; }

      /* 历史列表:仅展开态显示 */
      #history { flex: 1; overflow-y: auto; display: none; flex-direction: column; gap: 4px;
                 background: rgba(30, 30, 40, 0.92); border-radius: 12px; padding: 8px; }
      #panel.expanded #history { display: flex; }
      .msg { max-width: 85%; padding: 5px 9px; border-radius: 10px; word-break: break-word; }
      .msg.user { align-self: flex-end; background: rgba(90, 110, 200, 0.95); }
      .msg.pet { align-self: flex-start; background: rgba(60, 60, 80, 0.95); }

      /* 输入条 */
      #bar { display: flex; gap: 6px; align-items: center;
             background: rgba(30, 30, 40, 0.92); border-radius: 12px; padding: 6px; }
      #input { flex: 1; border: none; outline: none; border-radius: 8px; padding: 6px 8px;
               background: rgba(255, 255, 255, 0.12); color: #f0f0f4; }
      button { border: none; border-radius: 8px; padding: 6px 8px; cursor: pointer;
               background: rgba(255, 255, 255, 0.16); color: #f0f0f4; }
      #send { display: none; }
      #panel.expanded #send { display: inline-block; }
    </style>
  </head>
  <body>
    <div id="panel" class="collapsed">
      <div id="bubble"></div>
      <div id="history"></div>
      <div id="bar">
        <input id="input" type="text" placeholder="说点什么…" />
        <button id="toggle" title="展开">⤢</button>
        <button id="send">发送</button>
      </div>
    </div>
    <script type="module" src="./dialog.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 重写 dialog.ts(双态逻辑 + 气泡淡出)**

Replace `src/renderer/dialog.ts`:

```ts
import type { ChatMessage } from '@shared/ipc'

const BUBBLE_MS = 4000

const panel = document.getElementById('panel') as HTMLElement
const bubble = document.getElementById('bubble') as HTMLElement
const history = document.getElementById('history') as HTMLElement
const input = document.getElementById('input') as HTMLInputElement
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement

let collapsed = true
let bubbleTimer: number | null = null

function showBubble(text: string): void {
  bubble.textContent = text
  bubble.classList.add('show')
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), BUBBLE_MS)
}

function render(messages: ChatMessage[]): void {
  history.innerHTML = ''
  for (const m of messages) {
    const el = document.createElement('div')
    el.className = `msg ${m.role}`
    el.textContent = m.text
    history.appendChild(el)
  }
  history.scrollTop = history.scrollHeight
  const lastPet = [...messages].reverse().find((m) => m.role === 'pet')
  if (lastPet) showBubble(lastPet.text)
}

function setCollapsed(c: boolean): void {
  collapsed = c
  panel.classList.toggle('collapsed', c)
  panel.classList.toggle('expanded', !c)
  toggleBtn.textContent = c ? '⤢' : '⤡'
  toggleBtn.title = c ? '展开' : '收起'
  window.chatApi.setSize(c)
}

function submit(): void {
  const text = input.value.trim()
  if (!text) return
  window.chatApi.send({ text })
  input.value = ''
}

toggleBtn.addEventListener('click', () => setCollapsed(!collapsed))
sendBtn.addEventListener('click', submit)
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
window.chatApi.onUpdate(render)
setCollapsed(true)
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 4: 真机验收**

Run: `pnpm preview`
Expected:① 单击开框 = 常态薄条(输入条 + ⤢);② 发送后,宠物回复以气泡浮现,约 4s 后平滑淡出、只剩输入条;③ 点 ⤢ → 窗口变高、显示滚动历史 + "发送"钮、钮变 ⤡;④ 点 ⤡ → 收回薄条,历史不丢;⑤ 展开态不显示淡出气泡(显示完整历史)。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/dialog.html src/renderer/dialog.ts
git commit -m "feat(dialog): 双态 UI(常态薄条+气泡淡出 / 展开历史面板)"
```

---

## Task 8: 顺带清理 + 更新 PROGRESS.md

**Files:**
- Modify: `src/renderer/spritePlayer.ts`、`src/main/petLoader.test.ts`、`PROGRESS.md`

**Interfaces:** 无新导出;`SpritePlayer` 公共方法签名不变。

- [ ] **Step 1: 确认现有测试全绿(基线)**

Run: `pnpm test`
Expected: 现有单测(含 Task 1/2 新增)全部通过。

- [ ] **Step 2: spritePlayer 画布尺寸提到 play() 设一次**

Modify `src/renderer/spritePlayer.ts` —— `play()` 里进入动画后设一次画布尺寸,`draw()` 不再每帧重设:

`play()` 改为(在 `this.frame = 0` 之后、`this.tick(anim)` 之前插入尺寸设置):

```ts
  play(state: string): void {
    this.stop()
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.canvas.width = this.manifest.sheet.cellWidth
    this.canvas.height = this.manifest.sheet.cellHeight
    this.tick(anim)
  }
```

`draw()` 去掉每帧的 `this.canvas.width = r.w; this.canvas.height = r.h`:

```ts
  private draw(anim: PetAnimation, index: number): void {
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }
```

> 说明:luluka 所有帧尺寸恒为 `cellWidth×cellHeight`(192×208),故 play() 设一次即可;避免每帧重设画布(会清空并重置上下文)。`isPetPixel` 仍读 `this.canvas.width/height`,不受影响。

- [ ] **Step 3: petLoader 测试改用明确不存在的路径**

Modify `src/main/petLoader.test.ts` —— 找到用 `resolve(__dirname)` 当"缺失 pet.json 目录"的用例,把该目录换成明确不存在的路径。示例(按实际测试文件内变量名调整):

```ts
// 之前:const missing = resolve(__dirname)
const missing = resolve(__dirname, '__no_such_pet_dir__')
```

> 先 Read `src/main/petLoader.test.ts` 确认原写法,再做等价替换,保持断言不变(仍期望 loadPet 抛错)。

- [ ] **Step 4: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 5: 更新 PROGRESS.md**

Modify `PROGRESS.md`:
- 顶部状态与 §1 一句话现状:改为 MVP-02 已完成、下一步 MVP-03。
- §6 路线图:把 `⬜ MVP-02 …` 改为 `✅ MVP-02 …`。
- §4 代码地图:补 `src/shared/petBrain.ts`、`src/renderer/petController.ts`、`src/renderer/dialog.*`、`src/main/shell/*`。
- §7 已知遗留:划掉本次已清的两条(spritePlayer 每帧重设、petLoader 测试路径)。
- 更新时间改为完成当日。

- [ ] **Step 6: 最终真机全量验收(对照 spec §7)**

Run: `pnpm build && pnpm preview`
逐条确认 spec §7 的 8 条验收标准全部满足(自主游走/睡、拖拽 drag、单击+热键开关、发送动画联动、展开/收起、拖拽单击不误触、透明穿透不回归、退出注销热键)。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/spritePlayer.ts src/main/petLoader.test.ts PROGRESS.md
git commit -m "chore(mvp-02): 清理 spritePlayer/petLoader 遗留 + 更新 PROGRESS"
```

---

## 完成后

`superpowers:finishing-a-development-branch` 收尾(合并/PR/清理由用户定)。

---

## Self-Review(计划自检)

**Spec 覆盖核对(逐条对 spec):**
- §4.1 状态机 idle/walk/drag/sleep → Task 1/2/4 ✅
- §4.4 外部事件预留钩子 → Task 2 `applyEvent` + Task 5 `onPetEvent`/`PET_EVENT` ✅
- §4.3 独立置顶对话窗 + 双态(常态薄/展开)+ 气泡数秒淡出 → Task 5/7 ✅
- §4.4 单击 + `Ctrl+Shift+Space` 唤出、退出注销 → Task 5 ✅
- §4.5 占位闭环 + 动画联动 + 读 lines.json 兜底 → Task 6 ✅
- §4.6 shell 抽取 → Task 3 ✅
- §5 IPC 增量(TOGGLE_DIALOG/GET_WINDOW_BOUNDS/CHAT_SEND/CHAT_UPDATE/PET_EVENT/DIALOG_SET_SIZE)+ 可扩展 ChatMessage → Task 4/5/6 ✅
- §6 纯逻辑 TDD → Task 1/2 ✅
- §7 验收 8 条 → Task 8 Step 6 全量核对 ✅
- §8 顺带清理 → Task 8 ✅
- §9 识图预留(ChatMessage.attachments 可选字段)→ Task 5 类型已含 `attachments?` ✅(MVP-02 不实现)
- §10 记忆接缝(transcript 归主进程)→ Task 6 `createChatStore` 主进程持有 ✅

**Placeholder 扫描:** 无 TBD/TODO;每个改码步骤都给了完整代码;GUI 步骤给了完整 HTML/CSS/TS。Task 8 Step 3 需先 Read 目标测试文件确认原写法后等价替换(已注明)。

**类型一致性核对:** `PetEvent`/`PetBrainCtx`/`StepInput`/`StepEffects` 全程一致;`WindowBounds`/`Bounds` 一处定义多处引用;`ChatMessage`/`ChatSendPayload`/`ChatApi`/`PetApi` 在 ipc.ts 定义、preload/renderer 一致;`createDialogController`/`createChatStore`/`registerHotkeys` 签名在生产与调用处一致;IPC 常量全部经 `IPC.*`。
