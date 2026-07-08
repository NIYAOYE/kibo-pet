# 气泡窗视觉与自适应尺寸 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跟随宠物的漫画气泡窗从"固定 240×172、深色实心方块"改成"宽度固定、高度跟内容自适应（流式实时长高）、宠物主题色浅紫渐变"。

**Architecture:** 主进程 `bubbleWindow.ts` 把窗口高度从常量变成可变状态（`currentHeight`），由渲染层测量内容自然高度、节流后经新 IPC 通道 `BUBBLE_RESIZE` 上报，主进程夹取范围后重新摆位（复用既有的尺寸无关纯函数 `bubblePlacement`/`fixedWindowBounds`，不用改它们）。视觉换色是纯 CSS 改动，与尺寸自适应正交。

**Tech Stack:** Electron（CJS 主进程/preload）· electron-vite · TypeScript(strict) · Vitest · `@shared/*` 路径别名。

## Global Constraints

- 包管理器 **pnpm**；**绝不**给 `package.json` 加 `"type":"module"`。
- 跨进程值一律走 `src/shared` + `@shared/*` 别名；**绝不硬编码 IPC 通道字符串**，只用 `IPC` 常量。
- 新增 IPC 能力要四处同步：`src/shared/ipc.ts`（常量 + 类型）、主进程处理器、`src/preload/index.ts`（暴露）、渲染层调用。
- 所有 `ipcMain.on/handle` 的 payload 必须经 `src/shared/ipcValidation.ts` 校验后再用；校验只管**类型/合理性**（防恶意 payload），业务夹取（min/max）留在领域模块（`bubbleWindow.ts`）。
- 纯逻辑 TDD（先写失败测试）；GUI/Electron 接线由真机 `pnpm dev`/`pnpm preview` 肉眼验收（本仓库无 Electron GUI 自动化驱动）。
- 提交粒度：每任务一提交，conventional-commit 风格，**提交信息用中文**。
- 本次改动**范围限定在气泡窗**（`bubble.html`/`bubble.ts`/`bubbleWindow.ts`）：不碰展开对话框（`dialog.html`）、设置窗，深色主题在别处保持不变——这是用户已确认的明确非目标。
- 宽度维持固定常量 `240`，只做**高度**自适应，不做动态宽度。

---

### Task 1: `windowPlacement.ts` 新增 `clamp` 纯函数

通用数值夹取，供 `bubbleWindow.ts` 的高度业务夹取复用。与该文件已有的 `fixedWindowBounds`/`isZeroMove` 同属"通用窗口几何"。

**Files:**
- Modify: `src/shared/windowPlacement.ts`
- Test: `src/shared/windowPlacement.test.ts`

**Interfaces:**
- Produces: `function clamp(value: number, min: number, max: number): number`

- [ ] **Step 1: 写失败测试**

在 `src/shared/windowPlacement.test.ts` 末尾（`describe('isZeroMove', ...)` 之后）追加：
```ts
describe('clamp', () => {
  it('低于下限时夹到下限', () => {
    expect(clamp(-10, 0, 100)).toBe(0)
  })
  it('高于上限时夹到上限', () => {
    expect(clamp(200, 0, 100)).toBe(100)
  })
  it('区间内原样返回', () => {
    expect(clamp(42, 0, 100)).toBe(42)
  })
  it('恰好等于边界值时原样返回', () => {
    expect(clamp(0, 0, 100)).toBe(0)
    expect(clamp(100, 0, 100)).toBe(100)
  })
})
```
并把文件顶部的导入改为：
```ts
import { fixedWindowBounds, isZeroMove, clamp } from './windowPlacement'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/windowPlacement.test.ts`
Expected: FAIL（`clamp is not a function` / 导入报错）

- [ ] **Step 3: 写实现**

在 `src/shared/windowPlacement.ts` 末尾追加：
```ts
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/windowPlacement.test.ts`
Expected: PASS（7 个测试全绿：原有 3 个 + 新增 4 个）

- [ ] **Step 5: 提交**

```bash
git add src/shared/windowPlacement.ts src/shared/windowPlacement.test.ts
git commit -m "feat(window): 新增通用数值夹取 clamp"
```

---

### Task 2: IPC 契约 —— `BUBBLE_RESIZE` + `validateBubbleHeight`

新增单向通道 `BUBBLE_RESIZE`（renderer→main，携带内容高度像素数）。只加类型/常量/校验/preload 暴露，主进程处理器留给 Task 6。

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcValidation.ts`
- Modify: `src/preload/index.ts`
- Test: `src/shared/ipcValidation.test.ts`

**Interfaces:**
- Produces:
  - `IPC.BUBBLE_RESIZE = 'bubble:resize'`
  - `BubbleApi.reportSize(height: number): void`
  - `function validateBubbleHeight(v: unknown): number | null`

- [ ] **Step 1: 写失败测试**

在 `src/shared/ipcValidation.test.ts` 顶部的导入里追加 `validateBubbleHeight`：
```ts
import {
  validateMoveDelta, validateBool, validateChatSend, validateOverlayRect,
  validateKey, validateProviderSettings, validateTestConnectionArg,
  validateTodoAdd, validateTodoId, validateReactionCategory, validateBubbleHeight
} from './ipcValidation'
```
在文件末尾（`describe('validateReactionCategory', ...)` 之后）追加：
```ts
describe('validateBubbleHeight', () => {
  it('接受合法有限非负数', () => {
    expect(validateBubbleHeight(120)).toBe(120)
    expect(validateBubbleHeight(0)).toBe(0)
  })
  it('拒绝负数/NaN/Infinity/超防御性上限/非数字', () => {
    expect(validateBubbleHeight(-1)).toBeNull()
    expect(validateBubbleHeight(NaN)).toBeNull()
    expect(validateBubbleHeight(Infinity)).toBeNull()
    expect(validateBubbleHeight(5001)).toBeNull()
    expect(validateBubbleHeight('120')).toBeNull()
    expect(validateBubbleHeight(null)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL（`validateBubbleHeight is not a function`）

- [ ] **Step 3a: 改 `src/shared/ipc.ts`**

把 `IPC` 常量对象里的这一段：
```ts
  BUBBLE_PLACE: 'bubble:place',
  BUBBLE_LINE: 'bubble:line',
  PET_SPEAK: 'pet:speak'
} as const
```
改为：
```ts
  BUBBLE_PLACE: 'bubble:place',
  BUBBLE_LINE: 'bubble:line',
  BUBBLE_RESIZE: 'bubble:resize',
  PET_SPEAK: 'pet:speak'
} as const
```
把 `BubbleApi` 接口里的这一段：
```ts
export interface BubbleApi {
  onStream(cb: (text: string) => void): void
  onStatus(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  onClear(cb: () => void): void
  onPlace(cb: (p: BubblePlace) => void): void
  onLine(cb: (text: string) => void): void
}
```
改为：
```ts
export interface BubbleApi {
  onStream(cb: (text: string) => void): void
  onStatus(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  onClear(cb: () => void): void
  onPlace(cb: (p: BubblePlace) => void): void
  onLine(cb: (text: string) => void): void
  /** 渲染层测量到内容自然高度后上报，主进程据此夹取范围并重新摆位 */
  reportSize(height: number): void
}
```

- [ ] **Step 3b: 改 `src/shared/ipcValidation.ts`**

在文件末尾追加：
```ts
export function validateBubbleHeight(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5000 ? v : null
}
```

- [ ] **Step 3c: 改 `src/preload/index.ts`**

在 `bubbleApi` 对象里，`onLine` 方法之后加一个逗号分隔的新方法：
```ts
  onLine: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_LINE)
    ipcRenderer.on(IPC.BUBBLE_LINE, (_e, text: string) => cb(text))
  },
  reportSize: (height: number): void => ipcRenderer.send(IPC.BUBBLE_RESIZE, height)
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts && pnpm typecheck`
Expected: 测试 PASS（新增 2 条）；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts src/preload/index.ts
git commit -m "feat(ipc): 新增 BUBBLE_RESIZE 通道与内容高度校验"
```

---

### Task 3: `bubbleWindow.ts` —— 高度从常量变可变状态

`place()` 从读常量 `SIZE` 改为读可变的 `{width: WIDTH, height: currentHeight}`；新增 `resize()` 方法供 Task 6 的 IPC 处理器调用；`clear()` 同步把 `currentHeight` 重置为最小值。

**Files:**
- Modify: `src/main/shell/bubbleWindow.ts`

**Interfaces:**
- Consumes: `clamp` from `@shared/windowPlacement`（Task 1）
- Produces: `BubbleController.resize(rawHeight: number, pet: Bounds, workArea: Bounds): void`

- [ ] **Step 1: 改常量与状态**

把文件顶部这两行：
```ts
import { fixedWindowBounds } from '@shared/windowPlacement'

// 气泡框 240×160 + 底部 12px 尾巴区 = 172;bubblePlacement 以此整体尺寸计算越界
const SIZE = { width: 240, height: 172 }
```
改为：
```ts
import { fixedWindowBounds, clamp } from '@shared/windowPlacement'

// 宽度固定；高度自适应内容（渲染层测量上报，见 BUBBLE_RESIZE），box+12px 尾巴区的总高度
const WIDTH = 240
const MIN_TOTAL_HEIGHT = 56  // 约一行文字 + padding + 尾巴
const MAX_TOTAL_HEIGHT = 320 // 超过则内容区 overflow-y:auto 内部滚动
```

- [ ] **Step 2: 加接口方法**

把 `BubbleController` 接口里的：
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
  pushLine(text: string): void
  window(): BrowserWindow | null
}
```
改为（新增 `resize`）：
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
  pushLine(text: string): void
  /** 渲染层上报的内容自然高度（未夹取）；夹到 [MIN_TOTAL_HEIGHT, MAX_TOTAL_HEIGHT] 后，若当前可见则重新摆位 */
  resize(rawHeight: number, pet: Bounds, workArea: Bounds): void
  window(): BrowserWindow | null
}
```

- [ ] **Step 3: 建窗尺寸改用新常量 + 加可变状态**

把：
```ts
  const win = new BrowserWindow({
    width: SIZE.width,
    height: SIZE.height,
```
改为：
```ts
  const win = new BrowserWindow({
    width: WIDTH,
    height: MIN_TOTAL_HEIGHT,
```
在 `let shown = false` 那一行之后加：
```ts
  let currentHeight = MIN_TOTAL_HEIGHT
```

- [ ] **Step 4: `place()` 改读可变尺寸**

把：
```ts
  function place(pet: Bounds, workArea: Bounds): void {
    const p = bubblePlacement(pet, workArea, SIZE)
    // 每次都重新声明固定宽高，避免 Windows 非整数 DPI 下 setPosition() 的坐标舍入
    // 被累积成窗口尺寸增长；保持 resizable:false，不再高频切换原生窗口样式。
    win.setBounds(fixedWindowBounds(p.x, p.y, SIZE))
    win.webContents.send(IPC.BUBBLE_PLACE, { tailSide: p.tailSide, tailOffsetX: p.tailOffsetX })
  }
```
改为：
```ts
  function place(pet: Bounds, workArea: Bounds): void {
    const size = { width: WIDTH, height: currentHeight }
    const p = bubblePlacement(pet, workArea, size)
    // 每次都重新声明固定宽高，避免 Windows 非整数 DPI 下 setPosition() 的坐标舍入
    // 被累积成窗口尺寸增长；保持 resizable:false，不再高频切换原生窗口样式。
    win.setBounds(fixedWindowBounds(p.x, p.y, size))
    win.webContents.send(IPC.BUBBLE_PLACE, { tailSide: p.tailSide, tailOffsetX: p.tailOffsetX })
  }
```

- [ ] **Step 5: `clear()` 重置高度 + 新增 `resize()`**

把返回对象里的：
```ts
    clear: () => win.webContents.send(IPC.BUBBLE_CLEAR),
    pushLine: (t) => win.webContents.send(IPC.BUBBLE_LINE, t)
```
改为：
```ts
    clear: () => {
      currentHeight = MIN_TOTAL_HEIGHT
      win.webContents.send(IPC.BUBBLE_CLEAR)
    },
    pushLine: (t) => win.webContents.send(IPC.BUBBLE_LINE, t),
    resize(rawHeight, pet, workArea): void {
      currentHeight = clamp(rawHeight, MIN_TOTAL_HEIGHT, MAX_TOTAL_HEIGHT)
      if (shown) place(pet, workArea)
    }
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误（`resize` 已在接口与实现中匹配；无消费者调用它还不会报错，Task 6 才接线）。

- [ ] **Step 7: 提交**

```bash
git add src/main/shell/bubbleWindow.ts
git commit -m "feat(bubble): 气泡窗高度从常量改为可变、新增 resize 方法"
```

---

### Task 4: `bubble.html` 视觉换色（方向 C：宠物主题色）

纯 CSS 改动，与尺寸自适应正交，可独立验证。

**Files:**
- Modify: `src/renderer/bubble.html`

- [ ] **Step 1: 替换整份文件内容**

把 `src/renderer/bubble.html` 整份替换为：
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
                   font-family: system-ui, sans-serif; font-size: 13px; color: #4a3a63; }
      /* 竖直栈:气泡框 + 尾巴区。尾巴在底/顶由 body 的 tail-bottom/tail-top 类切换。 */
      #wrap { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
      body.tail-top #wrap { flex-direction: column-reverse; }

      /* 气泡框:占据除尾巴外的全部高度,内部滚动(超过 MAX_TOTAL_HEIGHT 才会触发) */
      #box { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
             box-sizing: border-box; padding: 10px 14px; border-radius: 22px;
             background: linear-gradient(160deg, #efe3ff, #f7ecff);
             box-shadow: 0 4px 14px rgba(150,120,220,0.28);
             word-break: break-word; line-height: 1.5; }
      #box:empty { display: none; }

      /* 尾巴区:固定 12px 高,内含一个 CSS 三角,水平位置由 --tail-x 决定 */
      #tail { position: relative; height: 12px; flex-shrink: 0; }
      #tail::before { content: ''; position: absolute; left: var(--tail-x, 120px);
                      transform: translateX(-50%); width: 0; height: 0;
                      border-left: 9px solid transparent; border-right: 9px solid transparent; }
      body.tail-bottom #tail::before { top: 0; border-top: 12px solid #f2e8ff; }
      body.tail-top    #tail::before { bottom: 0; border-bottom: 12px solid #f2e8ff; }

      /* pet 回复内渲染的 Markdown 子集样式(与对话框保持一致,配色适配浅色底) */
      #box ul { margin: 4px 0; padding-left: 18px; }
      #box li { margin: 1px 0; }
      #box strong { font-weight: 600; }
      #box code { background: rgba(74,58,99,0.10); border-radius: 4px; padding: 0 3px; font-size: 12px; }
      #box a.md-link { color: #6a4fb3; text-decoration: underline; word-break: break-all; }
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

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误（纯 HTML/CSS 改动，不影响类型）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/bubble.html
git commit -m "style(bubble): 气泡窗换成宠物主题色浅紫渐变"
```

---

### Task 5: `bubble.ts` —— 测量内容高度并节流上报

内容变化后测量 `#wrap` 的自然高度，用 `requestAnimationFrame` 节流合并，调用 Task 2 新增的 `bubbleApi.reportSize`。

**Files:**
- Modify: `src/renderer/bubble.ts`

**Interfaces:**
- Consumes: `window.bubbleApi.reportSize(height: number): void`（Task 2）

- [ ] **Step 1: 加测量+节流函数**

把文件顶部：
```ts
import { renderMarkdownSafe } from './markdown'

const box = document.getElementById('box') as HTMLElement
const tail = document.getElementById('tail') as HTMLElement

let streaming = '' // 流式累积的纯文本
```
改为：
```ts
import { renderMarkdownSafe } from './markdown'

const box = document.getElementById('box') as HTMLElement
const tail = document.getElementById('tail') as HTMLElement
const wrap = document.getElementById('wrap') as HTMLElement

let streaming = '' // 流式累积的纯文本

// 内容变化后测量 wrap(box+tail)的自然高度并上报主进程；rAF 合并高频调用(逐 token 流式输出时
// 最多每帧上报一次)，主进程夹取范围后重新摆位，实现"跟手实时长高"且不打爆 IPC。
let resizeScheduled = false
function scheduleReportSize(): void {
  if (resizeScheduled) return
  resizeScheduled = true
  requestAnimationFrame(() => {
    resizeScheduled = false
    window.bubbleApi.reportSize(wrap.scrollHeight)
  })
}
```

- [ ] **Step 2: 在内容处理器末尾调用**

把：
```ts
window.bubbleApi.onLine((text) => {
  clear()
  box.textContent = text
})

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
```
改为（每个处理器末尾加一行 `scheduleReportSize()`）：
```ts
window.bubbleApi.onLine((text) => {
  clear()
  box.textContent = text
  scheduleReportSize()
})

window.bubbleApi.onStream((text) => {
  box.classList.remove('status')
  streaming += text
  box.textContent = streaming            // 流式期间纯文本,避免半截标签闪烁
  box.scrollTop = box.scrollHeight
  scheduleReportSize()
})

window.bubbleApi.onStatus((text) => {
  // 状态行(检索中等)不并入回复累积;有回复文本时忽略状态,免得盖掉正文
  if (streaming) return
  box.classList.add('status')
  box.textContent = `🔍 ${text}`
  scheduleReportSize()
})

window.bubbleApi.onDone(() => {
  // 完成:把累积纯文本定格为安全 Markdown 子集
  if (streaming) box.innerHTML = renderMarkdownSafe(streaming)
  box.scrollTop = box.scrollHeight
  scheduleReportSize()
})

window.bubbleApi.onError((message) => {
  streaming = ''
  box.classList.remove('status')
  box.textContent = `⚠ ${message}`
  scheduleReportSize()
})
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误。**注意**：此时主进程还没有 `BUBBLE_RESIZE` 处理器（Task 6 才加），所以此任务完成后气泡尺寸实际上还不会变化——这是预期的中间状态，功能验证要等 Task 6。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/bubble.ts
git commit -m "feat(bubble): 渲染层测量内容高度并 rAF 节流上报"
```

---

### Task 6: 主进程接线 `BUBBLE_RESIZE` + 真机验收

注册 IPC 处理器，把渲染层上报的高度接到 `bubble.resize()`。这是让前面几个任务真正生效的最后一块拼图。

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `validateBubbleHeight` from `@shared/ipcValidation`（Task 2）；`bubble.resize(rawHeight, pet, workArea)`（Task 3）；已存在的 `petBoundsFull()`/`petWorkArea()`。

- [ ] **Step 1: 加校验导入**

把：
```ts
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS,
  validateReactionCategory
} from '@shared/ipcValidation'
```
改为：
```ts
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg, validateTodoAdd, validateTodoId, MAX_ATTACHMENTS,
  validateReactionCategory, validateBubbleHeight
} from '@shared/ipcValidation'
```

- [ ] **Step 2: 注册处理器**

在 `PET_SPEAK` 处理器（`ipcMain.on(IPC.PET_SPEAK, ...)` 那一块）之后加：
```ts
  ipcMain.on(IPC.BUBBLE_RESIZE, (_e, raw) => {
    const height = validateBubbleHeight(raw)
    if (height === null) return
    bubble.resize(height, petBoundsFull(), petWorkArea())
  })
```

- [ ] **Step 3: 类型检查 + 构建 + 全量测试**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: 均无错误；测试数量与 Task 1/2 新增的一致（本任务自身无新增测试，是 Electron IPC 接线）。

- [ ] **Step 4: 真机 GUI 肉眼验收（人工）**

Run: `pnpm dev`（或 `pnpm build && pnpm preview`）。逐条确认：
- [ ] 短句自主台词（双击戳 / 拖起 / 自主闲聊）气泡矮、贴合文字，不再是固定大方块。
- [ ] 长句聊天回复流式输出时，气泡跟手实时长高，不闪烁、不抖动。
- [ ] 气泡不会超出屏幕工作区（复用既有 `bubblePlacement` 越界处理，长高后仍然成立）。
- [ ] 配色确认是浅紫渐变 + 深紫字，不再是深色实心方块；链接/代码/加粗等 Markdown 子集在新配色下清晰可读。
- [ ] 故意发一条很长的回复（触发 `MAX_TOTAL_HEIGHT` 天花板）→ 气泡不再无限变高，内容改为内部滚动。
- [ ] 拖拽宠物时气泡跟随重定位正常，尺寸不会在拖拽过程中意外跳变。
- [ ] 展开对话框（`dialog.html`）观感不变（本次改动的非目标，确认没被误改）。

- [ ] **Step 5: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 接线 BUBBLE_RESIZE，气泡自适应尺寸生效"
```

---

## 完成后

- 用 superpowers:finishing-a-development-branch 收尾（合并/PR 决策）。
- PROGRESS.md 是否需要记一笔由用户决定——这不是编号 MVP，可能只需一句话带过（同"折叠态头顶漫画气泡"分支的记法）。

## Self-Review

**Spec 覆盖**（对照 `2026-07-07-bubble-adaptive-style.md`）
- §3 视觉风格（方向 C 色值/圆角/阴影/尾巴/Markdown 子集配色）：Task 4 ✅
- §4.1 尺寸模型（宽度固定/高度可变/上下限常量）：Task 3 ✅
- §4.2 数据流（测量→节流→IPC→夹取→重新摆位）：Task 5(测量+节流)+Task 2(IPC 契约)+Task 3(resize 内部夹取+摆位)+Task 6(接线) ✅
- §4.3 清空态与首次显示（`clear()` 同步重置 `currentHeight`、初始建窗尺寸）：Task 3 Step 3/5 ✅
- §4.4 结构变化（`place()` 读可变尺寸、`resize()` 方法、`reposition()` 不用改）：Task 3 ✅（`reposition()` 确认未改动，复用可变 `currentHeight`）
- §5 IPC 四文件：Task 2(ipc/validation/preload)+Task 6(main 处理器) ✅
- §6 文件清单：全部覆盖，`windowPlacement.ts` 而非 `bubblePlacement.ts` 承载 `clamp`（自审已修正）✅
- §7 测试策略：`clamp`/`validateBubbleHeight` 单测（Task 1/2）、Electron glue 真机验收清单（Task 6 Step 4）✅
- §2 非目标（不碰 dialog.html/设置窗、不做动态宽度）：全程未涉及这些文件；Task 6 验收清单显式加了"展开对话框观感不变"的确认项 ✅

**占位符扫描**：无 TBD/TODO；每个 code step 都有完整代码。

**类型一致性**：`clamp(value,min,max)`/`validateBubbleHeight(v)`/`BubbleApi.reportSize(height)`/`BubbleController.resize(rawHeight,pet,workArea)`/`WIDTH`/`MIN_TOTAL_HEIGHT`/`MAX_TOTAL_HEIGHT` 在定义任务与消费任务间签名一致；`clamp` 单一定义于 `windowPlacement.ts`，`bubbleWindow.ts` 从 `@shared/windowPlacement` 导入而非重新实现。
