# 折叠态"头顶漫画气泡" + 三处对话框修复 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 折叠对话框时，回复以跟随宠物头顶的漫画气泡呈现（可滚动、越界自适应），并修复发送按钮显示不全、Shift+Enter 无法换行、发送瞬间闪现旧回复三处问题。

**Architecture:** 新增一个独立的"气泡伴随窗"（透明置顶小窗），由主进程 `createBubbleController` 管理、跟随宠物窗口定位；折叠态的流式回复改经该窗呈现，展开态对话框行为原样不动。气泡定位（含四方向越界处理）抽成纯函数 `bubblePlacement` 单测覆盖。

**Tech Stack:** Electron（CommonJS 主/预加载）+ TypeScript + electron-vite + Vitest。宠物窗、拖拽、点击穿透、走路逻辑完全不改。

## Global Constraints

- 包管理器是 **pnpm**；命令 `pnpm build`（typecheck+构建三束）、`pnpm preview`（跑构建产物做目视确认，比 dev 可靠）、`pnpm vitest run <file>`（单测）。
- **禁止**给 `package.json` 加 `"type": "module"`。
- 跨进程值一律走 `src/shared` 与 `@shared/*` 别名；**绝不硬编码 IPC 通道字符串**，用 `IPC` 常量。新增 IPC 能力需四文件同步：`src/shared/ipc.ts`（常量+类型）、`src/main/shell/*`（发送）、`src/preload/index.ts`（暴露）、renderer 消费方。
- 纯逻辑用 Vitest 先写失败用例（TDD）；GUI/Electron 接线靠 `pnpm build && pnpm preview` 真机目视确认——**自动化检查通过 ≠ 应用能跑**。
- 提交信息用中文、conventional-commit 风格（`feat(scope): ...` / `fix(scope): ...`），小步频繁提交。
- 气泡伴随窗固定尺寸常量 `SIZE = { width: 240, height: 172 }`（气泡框 240×160 + 底部 12px 尾巴区），全程复用该常量，不散落魔法数字。

---

## 文件结构

- 新建 `src/shared/bubblePlacement.ts` — 纯函数：算气泡窗左上角坐标 + 尾巴方向/水平偏移，含越界处理。
- 新建 `src/shared/bubblePlacement.test.ts` — 上述纯函数单测。
- 修改 `src/shared/ipc.ts` — 新增 `BUBBLE_*` 通道常量、`BubbleApi` 接口、`Window.bubbleApi` 声明。
- 修改 `src/preload/index.ts` — 暴露 `bubbleApi`。
- 新建 `src/renderer/bubble.html` + `src/renderer/bubble.ts` — 气泡伴随窗渲染层。
- 修改 `electron.vite.config.ts` — 注册 `bubble.html` 入口。
- 新建 `src/main/shell/bubbleWindow.ts` — `createBubbleController`。
- 修改 `src/main/shell/index.ts` — 接线气泡窗（广播流式、显隐、跟随、清空）。
- 修改 `src/renderer/dialog.html` + `src/renderer/dialog.ts` — 移除内嵌气泡、输入栏改 textarea、发送按钮修复、闪现修复。
- 修改 `src/main/shell/dialogWindow.ts` — 折叠尺寸瘦身。

---

## Task 1: `bubblePlacement` 纯函数 + 单测

**Files:**
- Create: `src/shared/bubblePlacement.ts`
- Test: `src/shared/bubblePlacement.test.ts`

**Interfaces:**
- Consumes: `Bounds` from `@shared/petBrain`（`{ x; y; width; height }`）。
- Produces: `bubblePlacement(pet: Bounds, workArea: Bounds, bubble: { width: number; height: number }): BubblePlacement`，其中 `BubblePlacement = { x: number; y: number; tailSide: 'top' | 'bottom'; tailOffsetX: number }`。

- [ ] **Step 1: 写失败测试**

创建 `src/shared/bubblePlacement.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { bubblePlacement } from './bubblePlacement'

const WA = { x: 0, y: 0, width: 1920, height: 1040 } // 主屏工作区
const B = { width: 240, height: 172 }

describe('bubblePlacement', () => {
  it('屏幕中央:放头顶、水平居中、尾巴在底部指向宠物中心', () => {
    const pet = { x: 800, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('bottom')
    expect(p.y).toBe(500 - 172 - 8)          // pet.y - height - GAP
    expect(p.x).toBe(Math.round(928 - 120))  // petCenterX(928) - width/2
    expect(p.tailOffsetX).toBe(120)          // 尾巴对准宠物中心 = width/2
  })

  it('宠物贴屏幕顶:头顶放不下 → 翻到下方,尾巴在顶部', () => {
    const pet = { x: 800, y: 10, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('top')
    expect(p.y).toBe(10 + 288 + 8)           // pet.y + height + GAP
  })

  it('宠物被拖拽到屏幕左侧界外(手动拖拽不夹取位置,可为负):x 夹进工作区左缘', () => {
    // pet.x=-100,width=256 → petCenterX=28;不夹取会得到 x=round(28-120)=-92(越界)
    const pet = { x: -100, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.x).toBe(0)                       // 夹到 workArea.x
    // tailOffsetX = petCenterX - x = 28 - 0 = 28,仍在 [16, 224] 内
    expect(p.tailOffsetX).toBe(28)
  })

  it('宠物被拖拽到屏幕右侧界外:x 夹到右边界,尾巴右移且不超过气泡右内边距', () => {
    // pet.x=1770,width=256 → petCenterX=1898;不夹取会得到 x=round(1898-120)=1778(越界,右边界=1920-240=1680)
    const pet = { x: 1770, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.x).toBe(1920 - 240)              // workArea.right - width
    // tailOffsetX = petCenterX - x = 1898 - 1680 = 218(在 [16,224] 范围内)
    expect(p.tailOffsetX).toBe(218)
  })

  it('宠物被拖拽到右上角界外:同时翻到下方并夹右,尾巴跟随夹取后的 x', () => {
    const pet = { x: 1770, y: 5, width: 256, height: 288 }
    const p = bubblePlacement(pet, WA, B)
    expect(p.tailSide).toBe('top')
    expect(p.x).toBe(1920 - 240)
    expect(p.tailOffsetX).toBe(218)
  })

  it('副屏工作区带偏移,宠物拖到该工作区左侧界外:坐标仍夹在该工作区内(不回退到主屏原点)', () => {
    const wa = { x: 1920, y: 0, width: 1280, height: 1040 }
    // pet.x=1820(工作区左缘 1920 以左 100px) → petCenterX=1948;不夹取得 x=round(1948-120)=1828(< wa.x=1920,越界)
    const pet = { x: 1820, y: 500, width: 256, height: 288 }
    const p = bubblePlacement(pet, wa, B)
    expect(p.x).toBe(1920)                     // 夹到副屏 workArea.x,不回到主屏
    expect(p.tailOffsetX).toBe(28)             // petCenterX - x = 1948 - 1920 = 28
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/bubblePlacement.test.ts`
Expected: FAIL（`bubblePlacement` 未定义 / 模块不存在）。

- [ ] **Step 3: 写最小实现**

创建 `src/shared/bubblePlacement.ts`：

```ts
import type { Bounds } from './petBrain'

export interface BubblePlacement {
  x: number
  y: number
  tailSide: 'top' | 'bottom'
  tailOffsetX: number
}

const GAP = 8          // 气泡与宠物之间的竖直间隙
const TAIL_MARGIN = 16 // 尾巴中心离气泡左右缘的最小距离

/**
 * 计算气泡伴随窗的左上角坐标与尾巴指向。
 * 默认放宠物头顶、水平以宠物中心对齐;越界时:
 *  - 头顶放不下 → 翻到宠物下方(尾巴改朝上);
 *  - 左右放不下 → 水平夹进工作区,尾巴水平偏移单独算以持续指向宠物;
 *  - 上下都放不下 → 夹进工作区(可见性优先)。
 * 输出的 x/y 始终完全落在 workArea 内。
 */
export function bubblePlacement(
  pet: Bounds,
  workArea: Bounds,
  bubble: { width: number; height: number }
): BubblePlacement {
  const petCenterX = pet.x + pet.width / 2

  // 水平:以宠物中心对齐,再夹进工作区
  let x = Math.round(petCenterX - bubble.width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - bubble.width))

  // 竖直:优先头顶,不够翻下方,再不够夹进工作区
  const aboveY = pet.y - bubble.height - GAP
  const belowY = pet.y + pet.height + GAP
  let y: number
  let tailSide: 'top' | 'bottom'
  if (aboveY >= workArea.y) {
    y = aboveY
    tailSide = 'bottom'
  } else if (belowY + bubble.height <= workArea.y + workArea.height) {
    y = belowY
    tailSide = 'top'
  } else {
    y = Math.max(workArea.y, Math.min(aboveY, workArea.y + workArea.height - bubble.height))
    tailSide = 'bottom'
  }

  // 尾巴水平偏移:指向宠物中心(相对气泡左缘),夹到内边距范围内
  let tailOffsetX = Math.round(petCenterX - x)
  tailOffsetX = Math.max(TAIL_MARGIN, Math.min(tailOffsetX, bubble.width - TAIL_MARGIN))

  return { x, y, tailSide, tailOffsetX }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/bubblePlacement.test.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/bubblePlacement.ts src/shared/bubblePlacement.test.ts
git commit -m "feat(bubble): 新增气泡定位纯函数 bubblePlacement(含越界翻转/夹取)"
```

---

## Task 2: IPC 契约 + preload 暴露 bubbleApi

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces:
  - IPC 常量 `BUBBLE_STREAM='bubble:stream'`、`BUBBLE_STATUS='bubble:status'`、`BUBBLE_DONE='bubble:done'`、`BUBBLE_ERROR='bubble:error'`、`BUBBLE_CLEAR='bubble:clear'`、`BUBBLE_PLACE='bubble:place'`。
  - `BubbleApi` 接口 + `window.bubbleApi`（供 Task 3 消费）。
  - 载荷类型 `BubblePlace = { tailSide: 'top' | 'bottom'; tailOffsetX: number }`。

- [ ] **Step 1: 在 `src/shared/ipc.ts` 的 `IPC` 常量对象里追加气泡通道**

在 `OPEN_TODO_PANEL: 'todos:open-panel'` 之后(该行末尾补逗号)追加：

```ts
  OPEN_TODO_PANEL: 'todos:open-panel',
  BUBBLE_STREAM: 'bubble:stream',
  BUBBLE_STATUS: 'bubble:status',
  BUBBLE_DONE: 'bubble:done',
  BUBBLE_ERROR: 'bubble:error',
  BUBBLE_CLEAR: 'bubble:clear',
  BUBBLE_PLACE: 'bubble:place'
```

- [ ] **Step 2: 在 `src/shared/ipc.ts` 追加类型与接口**

在 `TodoApi` 接口定义之后、`declare global` 之前追加：

```ts
export interface BubblePlace { tailSide: 'top' | 'bottom'; tailOffsetX: number }

export interface BubbleApi {
  onStream(cb: (text: string) => void): void
  onStatus(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  onClear(cb: () => void): void
  onPlace(cb: (p: BubblePlace) => void): void
}
```

在 `declare global` 的 `Window` 接口里追加 `bubbleApi`：

```ts
declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi }
}
```

- [ ] **Step 3: 在 `src/preload/index.ts` 暴露 bubbleApi**

顶部 import 里追加 `BubbleApi, BubblePlace` 类型（并到既有 `from '@shared/ipc'` 的解构导入中）：

```ts
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace
} from '@shared/ipc'
```

在 `const todoApi ...` 定义之后、`contextBridge.exposeInMainWorld('petApi', petApi)` 之前追加：

```ts
const bubbleApi: BubbleApi = {
  onStream: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_STREAM)
    ipcRenderer.on(IPC.BUBBLE_STREAM, (_e, text: string) => cb(text))
  },
  onStatus: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_STATUS)
    ipcRenderer.on(IPC.BUBBLE_STATUS, (_e, text: string) => cb(text))
  },
  onDone: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_DONE)
    ipcRenderer.on(IPC.BUBBLE_DONE, () => cb())
  },
  onError: (cb: (message: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_ERROR)
    ipcRenderer.on(IPC.BUBBLE_ERROR, (_e, message: string) => cb(message))
  },
  onClear: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_CLEAR)
    ipcRenderer.on(IPC.BUBBLE_CLEAR, () => cb())
  },
  onPlace: (cb: (p: BubblePlace) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_PLACE)
    ipcRenderer.on(IPC.BUBBLE_PLACE, (_e, p: BubblePlace) => cb(p))
  }
}
```

在末尾追加暴露：

```ts
contextBridge.exposeInMainWorld('bubbleApi', bubbleApi)
```

- [ ] **Step 4: 类型检查通过**

Run: `pnpm typecheck`
Expected: PASS（无类型错误）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(bubble): 新增 BUBBLE_* IPC 通道与 preload bubbleApi"
```

---

## Task 3: 气泡伴随窗渲染层（bubble.html + bubble.ts + vite 入口）

**Files:**
- Create: `src/renderer/bubble.html`
- Create: `src/renderer/bubble.ts`
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Consumes: `window.bubbleApi`（Task 2）、`renderMarkdownSafe` from `./markdown`、`BubblePlace`。
- Produces: 一个 `bubble.html` 窗口页；无对外导出。

- [ ] **Step 1: 创建 `src/renderer/bubble.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; color: #f0f0f4; }
      /* 竖直栈:气泡框 + 尾巴区。尾巴在底/顶由 body 的 tail-bottom/tail-top 类切换。 */
      #wrap { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
      body.tail-top #wrap { flex-direction: column-reverse; }

      /* 气泡框:占据除尾巴外的全部高度,内部滚动 */
      #box { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
             box-sizing: border-box; padding: 8px 11px; border-radius: 14px;
             background: rgba(45, 45, 62, 0.97); box-shadow: 0 2px 10px rgba(0,0,0,0.35);
             word-break: break-word; line-height: 1.5; }
      #box:empty { display: none; }

      /* 尾巴区:固定 12px 高,内含一个 CSS 三角,水平位置由 --tail-x 决定 */
      #tail { position: relative; height: 12px; flex-shrink: 0; }
      #tail::before { content: ''; position: absolute; left: var(--tail-x, 120px);
                      transform: translateX(-50%); width: 0; height: 0;
                      border-left: 9px solid transparent; border-right: 9px solid transparent; }
      body.tail-bottom #tail::before { top: 0; border-top: 12px solid rgba(45, 45, 62, 0.97); }
      body.tail-top    #tail::before { bottom: 0; border-bottom: 12px solid rgba(45, 45, 62, 0.97); }

      /* pet 回复内渲染的 Markdown 子集样式(与对话框保持一致) */
      #box ul { margin: 4px 0; padding-left: 18px; }
      #box li { margin: 1px 0; }
      #box strong { font-weight: 600; }
      #box code { background: rgba(255,255,255,0.14); border-radius: 4px; padding: 0 3px; font-size: 12px; }
      #box a.md-link { color: #9db4ff; text-decoration: underline; word-break: break-all; }
      #box.status { opacity: 0.75; font-style: italic; }
    </style>
  </head>
  <body class="tail-bottom">
    <div id="wrap">
      <div id="box"></div>
      <div id="tail"></div>
    </div>
    <script type="module" src="./bubble.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 创建 `src/renderer/bubble.ts`**

```ts
import { renderMarkdownSafe } from './markdown'

const box = document.getElementById('box') as HTMLElement
const tail = document.getElementById('tail') as HTMLElement

let streaming = '' // 流式累积的纯文本

function clear(): void {
  streaming = ''
  box.textContent = ''
  box.classList.remove('status')
}

// 打开外部链接由主进程 will-navigate/openExternal 兜底,这里无需处理。
window.bubbleApi.onClear(() => clear())

window.bubbleApi.onStream((text) => {
  box.classList.remove('status')
  streaming += text
  box.textContent = streaming            // 流式期间纯文本,避免半截标签闪烁
  box.scrollTop = box.scrollHeight
})

window.bubbleApi.onStatus((text) => {
  // 状态行(检索中等)不并入回复累积;有回复文本时忽略状态,免得盖掉正文
  if (streaming) return
  box.classList.add('status')
  box.textContent = `🔍 ${text}`
})

window.bubbleApi.onDone(() => {
  // 完成:把累积纯文本定格为安全 Markdown 子集
  if (streaming) box.innerHTML = renderMarkdownSafe(streaming)
  box.scrollTop = box.scrollHeight
})

window.bubbleApi.onError((message) => {
  streaming = ''
  box.classList.remove('status')
  box.textContent = `⚠ ${message}`
})

window.bubbleApi.onPlace((p) => {
  document.body.classList.toggle('tail-bottom', p.tailSide === 'bottom')
  document.body.classList.toggle('tail-top', p.tailSide === 'top')
  tail.style.setProperty('--tail-x', `${p.tailOffsetX}px`)
})
```

- [ ] **Step 3: 在 `electron.vite.config.ts` 注册入口**

把 renderer 的 `input` 追加 `bubble` 一项：

```ts
        input: {
          index: resolve('src/renderer/index.html'),
          dialog: resolve('src/renderer/dialog.html'),
          settings: resolve('src/renderer/settings.html'),
          overlay: resolve('src/renderer/regionOverlay.html'),
          todoPanel: resolve('src/renderer/todoPanel.html'),
          bubble: resolve('src/renderer/bubble.html')
        }
```

- [ ] **Step 4: 构建通过**

Run: `pnpm build`
Expected: PASS（typecheck 通过，产物含 `out/renderer/bubble.html`）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/bubble.html src/renderer/bubble.ts electron.vite.config.ts
git commit -m "feat(bubble): 新增气泡伴随窗渲染层(漫画气泡+尾巴+Markdown定格)"
```

---

## Task 4: 主进程 `createBubbleController`

**Files:**
- Create: `src/main/shell/bubbleWindow.ts`

**Interfaces:**
- Consumes: `bubblePlacement`（Task 1）、`IPC`（Task 2）、`Bounds` from `@shared/petBrain`。
- Produces:
```ts
export interface BubbleController {
  show(pet: Bounds, workArea: Bounds): void
  hide(): void
  reposition(pet: Bounds, workArea: Bounds): void
  isVisible(): boolean
  pushStream(text: string): void
  pushStatus(text: string): void
  pushDone(): void
  pushError(message: string): void
  clear(): void
  window(): import('electron').BrowserWindow | null
}
export function createBubbleController(opts: { preload: string; url: string | undefined; bubbleHtml: string }): BubbleController
```

- [ ] **Step 1: 创建 `src/main/shell/bubbleWindow.ts`**

```ts
import { BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { Bounds } from '@shared/petBrain'
import { bubblePlacement } from '@shared/bubblePlacement'

// 气泡框 240×160 + 底部 12px 尾巴区 = 172;bubblePlacement 以此整体尺寸计算越界
const SIZE = { width: 240, height: 172 }

export interface BubbleController {
  show(pet: Bounds, workArea: Bounds): void
  hide(): void
  reposition(pet: Bounds, workArea: Bounds): void
  isVisible(): boolean
  pushStream(text: string): void
  pushStatus(text: string): void
  pushDone(): void
  pushError(message: string): void
  clear(): void
  window(): BrowserWindow | null
}

export function createBubbleController(opts: {
  preload: string
  url: string | undefined // bubble.html 的 dev URL(含 /bubble.html),打包为 undefined
  bubbleHtml: string
}): BubbleController {
  // 眼急建窗并隐藏:流式回复是连续多帧,若懒建窗则首批 token 会在渲染层监听器就绪前
  // 被静默丢弃(丢开头)。启动即建好、监听器就绪,后续 show 只切换可见性。
  const win = new BrowserWindow({
    width: SIZE.width,
    height: SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // 气泡不抢焦点,输入焦点始终留在对话框输入框
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 回复里的来源链接在系统浏览器打开,绝不导航/替换气泡窗本身
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (opts.url) win.loadURL(opts.url)
  else win.loadFile(opts.bubbleHtml)

  function place(pet: Bounds, workArea: Bounds): void {
    const p = bubblePlacement(pet, workArea, SIZE)
    const wasResizable = win.isResizable()
    if (!wasResizable) win.setResizable(true)
    win.setBounds({ x: p.x, y: p.y, width: SIZE.width, height: SIZE.height })
    if (!wasResizable) win.setResizable(false)
    win.webContents.send(IPC.BUBBLE_PLACE, { tailSide: p.tailSide, tailOffsetX: p.tailOffsetX })
  }

  return {
    window: () => win,
    isVisible: () => win.isVisible(),
    show(pet, workArea): void {
      place(pet, workArea)
      win.showInactive() // 显示但不激活,不抢焦点
    },
    hide(): void { win.hide() },
    reposition(pet, workArea): void { if (win.isVisible()) place(pet, workArea) },
    pushStream: (t) => win.webContents.send(IPC.BUBBLE_STREAM, t),
    pushStatus: (t) => win.webContents.send(IPC.BUBBLE_STATUS, t),
    pushDone: () => win.webContents.send(IPC.BUBBLE_DONE),
    pushError: (m) => win.webContents.send(IPC.BUBBLE_ERROR, m),
    clear: () => win.webContents.send(IPC.BUBBLE_CLEAR)
  }
}
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/main/shell/bubbleWindow.ts
git commit -m "feat(bubble): 新增主进程 createBubbleController(眼急建窗+跟随定位)"
```

---

## Task 5: shell 接线气泡窗

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `createBubbleController`（Task 4）、`Bounds`。
- 行为契约（决定"应否显示气泡"的策略集中在 index.ts）：
  - 送出即干净：`messageSent` → 清空并隐藏气泡。
  - 有流式/状态/报错内容且"折叠 + 对话框打开" → 显示并定位气泡；否则不显示。
  - 折叠/展开切换、对话框开/关 → 重算显隐。
  - 宠物移动且气泡可见 → 跟随重定位。

- [ ] **Step 1: import 气泡控制器与类型**

在 import 区（`import { createDialogController } from './dialogWindow'` 附近）追加：

```ts
import { createBubbleController } from './bubbleWindow'
```

在 `import type { PetEvent } from '@shared/petBrain'` 处补上 `Bounds`：

```ts
import type { PetEvent, Bounds } from '@shared/petBrain'
```

- [ ] **Step 2: 在 startShell 内新增 HTML 路径、状态与工具函数**

在 `const dialogHtml = join(dirname, '../renderer/dialog.html')` 之后追加：

```ts
  const bubbleHtml = join(dirname, '../renderer/bubble.html')
```

在 `const petWin = createPetWindow(...)` 之后、`function emitPetEvent` 之前，新增气泡窗与状态：

```ts
  const bubble = createBubbleController({
    preload,
    url: rendererUrl ? `${rendererUrl}/bubble.html` : undefined,
    bubbleHtml
  })
  let dialogCollapsed = true   // 镜像对话框折叠态,决定气泡显隐
  let bubbleHasContent = false // 本轮是否已有可显示的回复/状态

  function petBoundsFull(): Bounds {
    const [x, y] = petWin.getPosition()
    const [width, height] = petWin.getSize()
    return { x, y, width, height }
  }
  function petWorkArea(): Bounds {
    const b = petBoundsFull()
    return screen.getDisplayMatching(b).workArea
  }
  function refreshBubble(): void {
    if (dialog.isOpen() && dialogCollapsed && bubbleHasContent) bubble.show(petBoundsFull(), petWorkArea())
    else bubble.hide()
  }
```

- [ ] **Step 3: `emitPetEvent` 拦截 messageSent → 清空并隐藏气泡**

把 `emitPetEvent` 改为：

```ts
  function emitPetEvent(event: PetEvent): void {
    petWin.webContents.send(IPC.PET_EVENT, event)
    // 送出瞬间保证界面干净:清掉本轮气泡内容并隐藏,待首个流式/状态到达再显示
    if (event === 'messageSent') { bubbleHasContent = false; bubble.clear(); bubble.hide() }
  }
```

- [ ] **Step 4: 对话框开/关回调里刷新气泡**

把 `createDialogController({...})` 的 `onOpened`/`onClosed` 改为：

```ts
    onOpened: () => {
      emitPetEvent('dialogOpen')
      dialog.pushUpdate(chat.messages())
      refreshBubble() // 折叠态打开:此刻无本轮内容 → 保持隐藏(界面干净)
    },
    onClosed: () => {
      emitPetEvent('dialogClose')
      bubbleHasContent = false
      bubble.clear()
      bubble.hide()
    }
```

- [ ] **Step 5: chat 的 push* 回调广播到气泡窗**

把 `createChatStore({...})` 里的 `pushStream/pushStatus/pushDone/pushError` 四项改为同时驱动气泡（`pushUpdate` 保持只发对话框）：

```ts
    pushStream: (t) => {
      dialog.window()?.webContents.send(IPC.CHAT_STREAM, t)
      bubbleHasContent = true; refreshBubble(); bubble.pushStream(t)
    },
    pushStatus: (t) => {
      dialog.window()?.webContents.send(IPC.CHAT_STATUS, t)
      bubbleHasContent = true; refreshBubble(); bubble.pushStatus(t)
    },
    pushDone: () => {
      dialog.window()?.webContents.send(IPC.CHAT_DONE)
      bubble.pushDone()
    },
    pushError: (m) => {
      dialog.window()?.webContents.send(IPC.CHAT_ERROR, m)
      bubbleHasContent = true; refreshBubble(); bubble.pushError(m)
    },
```

> 注意:`refreshBubble()` 必须在 `bubble.pushStream(t)` **之前**调用,确保窗口先 `show`(渲染层监听器已就绪)再收内容;因眼急建窗,内容不会丢。

- [ ] **Step 6: 折叠/展开切换时刷新气泡**

把 `ipcMain.on(IPC.DIALOG_SET_SIZE, ...)` 处理改为：

```ts
  ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, raw) => {
    const collapsed = validateBool(raw)
    if (collapsed === null) return
    dialog.setSize(collapsed)
    dialogCollapsed = collapsed
    refreshBubble() // 展开→隐藏气泡(回复走对话框 history);折叠→有内容则显示
  })
```

- [ ] **Step 7: 宠物移动时气泡跟随**

在 `ipcMain.on(IPC.MOVE_WINDOW, ...)` 处理体的**末尾**（`if/else` 设定新位置之后）追加跟随重定位：

```ts
    if (bubble.isVisible()) bubble.reposition(petBoundsFull(), petWorkArea())
```

即改为：

```ts
  ipcMain.on(IPC.MOVE_WINDOW, (_e, raw) => {
    const delta = validateMoveDelta(raw)
    if (!delta) return
    const [x, y] = petWin.getPosition()
    const nx = Math.round(x + delta.dx)
    const ny = Math.round(y + delta.dy)
    if (delta.clamp) {
      const [width, height] = petWin.getSize()
      const { workArea } = screen.getDisplayMatching({ x, y, width, height })
      petWin.setPosition(
        Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width - width)),
        Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - height))
      )
    } else {
      petWin.setPosition(nx, ny)
    }
    if (bubble.isVisible()) bubble.reposition(petBoundsFull(), petWorkArea())
  })
```

- [ ] **Step 8: 构建通过**

Run: `pnpm build`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(bubble): shell 接线气泡窗(广播流式/显隐策略/跟随/送出清空)"
```

---

## Task 6: 对话框窗口改造（移除内嵌气泡 + 输入栏 textarea + 发送按钮修复 + 折叠瘦身）

**Files:**
- Modify: `src/renderer/dialog.html`
- Modify: `src/renderer/dialog.ts`
- Modify: `src/main/shell/dialogWindow.ts`

**Interfaces:**
- Consumes: 无新增（自洽改造）。
- 依赖 Task 5 已把折叠态回复迁到气泡窗（本任务移除对话框内嵌气泡后，折叠态由气泡窗承担显示）。

- [ ] **Step 1: `dialog.html` — 删除 `#bubble` 元素**

删除这一行：

```html
      <div id="bubble"></div>
```

- [ ] **Step 2: `dialog.html` — 删除 `#bubble` 相关 CSS**

删除以下整段（第 16–25 行附近，"气泡"注释块 + `#bubble` 两条规则 + `#panel.expanded #bubble`）：

```css
      /* 气泡:仅常态显示最新回复,可淡出。... */
      #bubble { align-self: flex-start; max-width: 90%; flex: 0 1 auto; min-height: 0; overflow-y: auto;
                overscroll-behavior: contain; box-sizing: border-box; padding: 6px 10px; border-radius: 12px;
                background: rgba(60, 60, 80, 0.95); opacity: 0; transition: opacity 0.6s ease;
                pointer-events: none; }
      /* 显示时才接收指针事件,长回复可用滚轮/拖拽滚动查看;淡出后恢复穿透以便拖动整窗 */
      #bubble.show { opacity: 1; pointer-events: auto; }
      #panel.expanded #bubble { display: none; }
```

- [ ] **Step 3: `dialog.html` — 输入框改 `<textarea>` 并修复发送按钮裁切**

把 `#input, button, #history, #bubble { -webkit-app-region: no-drag; }` 里的 `#bubble` 去掉：

```css
      #input, button, #history { -webkit-app-region: no-drag; }
```

把 `#input` 样式规则改为（新增 `min-width:0` 修复发送按钮被挤出裁切；换行/尺寸适配 textarea）：

```css
      #input { flex: 1; min-width: 0; border: none; outline: none; border-radius: 8px; padding: 6px 8px;
               background: rgba(255, 255, 255, 0.12); color: #f0f0f4; cursor: text;
               font-family: inherit; font-size: inherit; line-height: 1.4; resize: none;
               max-height: 66px; overflow-y: auto; }
```

（删除原先单独的 `#input { cursor: text; }` 一行，避免重复。）

把 `<body>` 里的输入元素由 input 改为 textarea：

```html
        <textarea id="input" rows="1" placeholder="说点什么…"></textarea>
```

- [ ] **Step 4: `dialog.ts` — 输入元素类型改 textarea**

把第 9 行：

```ts
const input = document.getElementById('input') as HTMLInputElement
```

改为：

```ts
const input = document.getElementById('input') as HTMLTextAreaElement
```

- [ ] **Step 5: `dialog.ts` — 移除气泡相关状态与函数**

删除第 4 行常量：

```ts
const BUBBLE_MS = 4000
```

删除第 7 行 bubble 元素引用：

```ts
const bubble = document.getElementById('bubble') as HTMLElement
```

删除 `bubbleTimer` 声明与 `showBubble` 函数（第 65 行与第 74–79 行）：

```ts
let bubbleTimer: number | null = null
```
```ts
function showBubble(text: string): void {
  bubble.textContent = text
  bubble.classList.add('show')
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), BUBBLE_MS)
}
```

- [ ] **Step 6: `dialog.ts` — `render()` 去掉"回放最后一条 pet 气泡"（闪现修复）**

把 `render()` 结尾这三行删除：

```ts
  const lastPet = [...messages].reverse().find((m) => m.role === 'pet')
  if (lastPet) showBubble(lastPet.text)
```

保留其上的 `history.scrollTop = history.scrollHeight`。

- [ ] **Step 7: `dialog.ts` — `setCollapsed()` 去掉折叠回显气泡**

删除 `setCollapsed` 末尾这段（含注释）：

```ts
  // Returning to collapsed: re-show the last reply bubble (its fade timer may have
  // elapsed while expanded/hidden), so the thin bar shows the latest reply again.
  if (c && bubble.textContent) showBubble(bubble.textContent)
```

- [ ] **Step 8: `dialog.ts` — `submit()` 去掉气泡清理、保留流式/状态清理**

把 `submit()` 里这几行删除（`#bubble` 已不存在）：

```ts
  if (bubbleTimer !== null) { clearTimeout(bubbleTimer); bubbleTimer = null }
  bubble.classList.remove('show')
  bubble.textContent = ''
```

保留其上的 `streaming = ''`、`document.getElementById('streaming-msg')?.remove()`、`clearStatus()`。

- [ ] **Step 9: `dialog.ts` — Enter 发送 / Shift+Enter 换行 + textarea 自增高**

把第 155 行的 keydown 监听：

```ts
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
```

改为：

```ts
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  // Shift+Enter / 输入法组合中 → 走默认,插入换行
})
// textarea 随内容自增高(上限由 CSS max-height 接管,超出内部滚动)
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
})
```

- [ ] **Step 10: `dialog.ts` — `submit()` 后复位 textarea 高度**

在 `submit()` 内 `input.value = ''` 之后追加一行，把自增高的 textarea 复位：

```ts
  input.value = ''
  input.style.height = 'auto'
```

- [ ] **Step 11: `dialog.ts` — 移除 onStream/onStatus/onError 里的 showBubble 调用**

`window.chatApi.onStream(...)`：删除其中的 `showBubble(streaming)` 一行，保留 `clearStatus()`、`streaming += text`、`renderStreaming()`。

`window.chatApi.onError(...)`：删除 `showBubble(`⚠ ${message}`)` 一行，保留其余（往 history 追加错误消息）。

`window.chatApi.onStatus(...)`：删除 `showBubble(`🔍 ${text}`)` 一行，保留其余（往 history 追加/更新状态消息）。

- [ ] **Step 12: `dialogWindow.ts` — 折叠尺寸瘦身**

把第 4 行：

```ts
const COLLAPSED = { width: 320, height: 130 }
```

改为（折叠态只剩输入栏 + 待发图片带，回复交给气泡窗）：

```ts
const COLLAPSED = { width: 320, height: 120 }
```

- [ ] **Step 13: 类型检查 + 全量单测通过**

Run: `pnpm typecheck`
Expected: PASS。

Run: `pnpm test`
Expected: PASS（既有单测全绿，含 Task 1 新增用例）。

- [ ] **Step 14: 提交**

```bash
git add src/renderer/dialog.html src/renderer/dialog.ts src/main/shell/dialogWindow.ts
git commit -m "feat(dialog): 折叠态移除内嵌气泡+输入栏改textarea(Enter发送/Shift+Enter换行)+修发送按钮裁切与闪现旧回复"
```

---

## Task 7: 真机目视验收（build + preview）

**Files:** 无（仅运行与目视）。

- [ ] **Step 1: 构建并跑产物**

Run: `pnpm build && pnpm preview`
（若环境设了 `ELECTRON_RUN_AS_NODE=1`,先 `unset ELECTRON_RUN_AS_NODE` 再跑。）

- [ ] **Step 2: 逐条目视确认**

- [ ] 展开对话框:右侧「发送」按钮**完整可见**、不再被裁一半。
- [ ] 折叠态点击宠物唤起:界面**干净**(无气泡)。
- [ ] 折叠态输入并发送:发送**瞬间干净**(无旧回复闪现);随后回复出现在**宠物头顶气泡**内,可上下滚动;输入栏是独立的一条,与气泡分离。
- [ ] 输入框 **Shift+Enter 换行**、单独 **Enter 发送**;多行时输入框自增高、超高内部滚动。
- [ ] 把宠物拖到屏幕**上边缘**:气泡翻到宠物**下方**,尾巴朝上指向宠物。
- [ ] 把宠物拖到屏幕**左/右边缘及四角**:气泡**不越界**、始终完整在屏内,尾巴仍指向宠物。
- [ ] 拖动宠物时:气泡**跟随**移动。
- [ ] 展开对话框:回复回到**对话框 history**(原样),头顶气泡隐藏。
- [ ] 关闭对话框:气泡隐藏、内容清空。

- [ ] **Step 3: 如有偏差修复后重跑**

若折叠窗高度裁掉了待发图片带或多行输入,微调 `dialogWindow.ts` 的 `COLLAPSED.height`；若气泡尾巴位置或尺寸观感不佳,微调 `bubble.html` 的尾巴 CSS 或 `bubbleWindow.ts` 的 `SIZE`(同步性由 `bubblePlacement` 保证)。改后 `pnpm build && pnpm preview` 复验，然后提交。

---

## Self-Review（作者自查）

**Spec 覆盖：**
- Bug 发送按钮显示一半 → Task 6 Step 3（`#input { min-width: 0 }`）+ Task 7 验收。✓
- 优化 折叠态头顶漫画气泡(可滚动、与输入解绑) → Task 1/3/4/5（定位纯函数、渲染层、控制器、接线）+ Task 6（移除内嵌气泡、折叠瘦身）。✓
- 优化 Shift+Enter 换行 → Task 6 Step 3/9/10。✓
- 优化 发送瞬间闪现旧回复 → Task 5 Step 3（messageSent 清空隐藏气泡）+ Task 6 Step 6（render 去掉回放旧气泡）。✓
- 边界越界(用户特别要求) → Task 1 纯函数四方向处理 + 单测五类边界用例 + Task 7 目视四角验收。✓

**占位符扫描：** 无 TBD/TODO；每个代码步骤给出完整代码。✓

**类型/命名一致性：** `bubblePlacement` 签名与返回 `BubblePlacement{ x,y,tailSide,tailOffsetX }` 在 Task 1/3/4 一致；IPC 常量名 `BUBBLE_STREAM/STATUS/DONE/ERROR/CLEAR/PLACE` 在 Task 2/3/4/5 一致；`BubbleApi` 方法 `onStream/onStatus/onDone/onError/onClear/onPlace` 与 preload、bubble.ts 一致；`BubbleController` 方法 `show/hide/reposition/isVisible/pushStream/pushStatus/pushDone/pushError/clear/window` 在 Task 4 定义、Task 5 调用一致；`petBoundsFull(): Bounds`、`refreshBubble()`、`dialogCollapsed`、`bubbleHasContent` 在 Task 5 内部自洽。✓
