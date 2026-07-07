# Windows DPI 稳定窗口定位修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows 150% DPI 下宠物窗和气泡窗因高频 `setPosition()` 产生的尺寸累积与相对位置漂移。

**Architecture:** 用共享纯函数生成带固定宽高的完整窗口 bounds，并让宠物窗与气泡窗每次移动都调用 `setBounds(fullBounds)`。`MOVE_WINDOW` 同时过滤零位移事件；窗口保持 `resizable:false`，全程不切换原生窗口样式。

**Tech Stack:** Electron 31、TypeScript、Vitest、electron-vite、Windows Per-Monitor DPI。

---

## 文件结构

- Create: `src/shared/windowPlacement.ts` — 固定尺寸 bounds 与零位移判断的纯逻辑。
- Create: `src/shared/windowPlacement.test.ts` — DPI 修复不变量的 Vitest 回归测试。
- Modify: `src/main/shell/petWindow.ts` — 导出并复用宠物窗口固定尺寸。
- Modify: `src/main/shell/index.ts` — 零位移短路；宠物窗使用完整 bounds 移动。
- Modify: `src/main/shell/bubbleWindow.ts` — 气泡窗使用完整 bounds 跟随。

## Task 1：固定尺寸 bounds 与零位移纯逻辑

**Files:**
- Create: `src/shared/windowPlacement.test.ts`
- Create: `src/shared/windowPlacement.ts`

- [ ] **Step 1：先写失败测试**

创建 `src/shared/windowPlacement.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { fixedWindowBounds, isZeroMove } from './windowPlacement'

describe('fixedWindowBounds', () => {
  it('每次都返回整数坐标和调用方声明的固定尺寸', () => {
    expect(fixedWindowBounds(932.6, 207.5, { width: 240, height: 172 })).toEqual({
      x: 933,
      y: 208,
      width: 240,
      height: 172
    })
  })

  it('重复计算不可落地的 DPI 坐标时结果不累计变化', () => {
    const results = Array.from({ length: 200 }, () =>
      fixedWindowBounds(933, 208, { width: 240, height: 172 })
    )

    expect(new Set(results.map((b) => `${b.x},${b.y},${b.width},${b.height}`))).toEqual(
      new Set(['933,208,240,172'])
    )
  })
})

describe('isZeroMove', () => {
  it('只把两个方向都为零的位移视为无效移动', () => {
    expect(isZeroMove({ dx: 0, dy: 0 })).toBe(true)
    expect(isZeroMove({ dx: 1, dy: 0 })).toBe(false)
    expect(isZeroMove({ dx: 0, dy: -1 })).toBe(false)
  })
})
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
pnpm vitest run src/shared/windowPlacement.test.ts
```

Expected: FAIL，错误为无法解析 `./windowPlacement`，证明测试在生产实现出现前会失败。

- [ ] **Step 3：写最小生产实现**

创建 `src/shared/windowPlacement.ts`：

```ts
import type { Bounds } from './petBrain'

export interface FixedSize {
  width: number
  height: number
}

export function fixedWindowBounds(x: number, y: number, size: FixedSize): Bounds {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  }
}

export function isZeroMove(delta: { dx: number; dy: number }): boolean {
  return delta.dx === 0 && delta.dy === 0
}
```

- [ ] **Step 4：运行测试并确认 GREEN**

Run:

```bash
pnpm vitest run src/shared/windowPlacement.test.ts
```

Expected: PASS，3 个测试全部通过。

- [ ] **Step 5：提交纯逻辑与测试**

```bash
git add src/shared/windowPlacement.ts src/shared/windowPlacement.test.ts
git commit -m "fix(window): 新增固定尺寸窗口定位不变量"
```

## Task 2：宠物窗口固定尺寸移动

**Files:**
- Modify: `src/main/shell/petWindow.ts`
- Modify: `src/main/shell/index.ts`
- Test: `src/shared/windowPlacement.test.ts`

- [ ] **Step 1：统一宠物窗口尺寸常量**

将 `src/main/shell/petWindow.ts` 改为：

```ts
import { BrowserWindow } from 'electron'

export const PET_WINDOW_SIZE = { width: 256, height: 288 } as const

export function createPetWindow(opts: { preload: string; url: string | undefined; indexHtml: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
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

- [ ] **Step 2：接入零位移短路与完整 bounds**

在 `src/main/shell/index.ts`：

1. 将宠物窗口 import 改为：

```ts
import { createPetWindow, PET_WINDOW_SIZE } from './petWindow'
```

2. 增加共享纯函数 import：

```ts
import { fixedWindowBounds, isZeroMove } from '@shared/windowPlacement'
```

3. 将 `IPC.MOVE_WINDOW` 处理器替换为：

```ts
ipcMain.on(IPC.MOVE_WINDOW, (_e, raw) => {
  const delta = validateMoveDelta(raw)
  if (!delta || isZeroMove(delta)) return
  const [x, y] = petWin.getPosition()
  const nx = Math.round(x + delta.dx)
  const ny = Math.round(y + delta.dy)
  if (delta.clamp) {
    const { workArea } = screen.getDisplayMatching({
      x,
      y,
      width: PET_WINDOW_SIZE.width,
      height: PET_WINDOW_SIZE.height
    })
    petWin.setBounds(fixedWindowBounds(
      Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width - PET_WINDOW_SIZE.width)),
      Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - PET_WINDOW_SIZE.height)),
      PET_WINDOW_SIZE
    ))
  } else {
    petWin.setBounds(fixedWindowBounds(nx, ny, PET_WINDOW_SIZE))
  }
  if (bubble.isVisible()) bubble.reposition(petBoundsFull(), petWorkArea())
})
```

- [ ] **Step 3：运行针对性测试与类型检查**

Run:

```bash
pnpm vitest run src/shared/windowPlacement.test.ts src/shared/bubblePlacement.test.ts
pnpm typecheck
```

Expected: 两个测试文件全部通过，TypeScript 无错误。

- [ ] **Step 4：提交宠物窗口接线**

```bash
git add src/main/shell/petWindow.ts src/main/shell/index.ts
git commit -m "fix(pet): 固定DPI缩放下的宠物窗口尺寸"
```

## Task 3：气泡窗口固定尺寸跟随

**Files:**
- Modify: `src/main/shell/bubbleWindow.ts`
- Test: `src/shared/windowPlacement.test.ts`
- Test: `src/shared/bubblePlacement.test.ts`

- [ ] **Step 1：接入固定尺寸 bounds**

在 `src/main/shell/bubbleWindow.ts` 增加：

```ts
import { fixedWindowBounds } from '@shared/windowPlacement'
```

将 `place()` 中：

```ts
win.setPosition(p.x, p.y)
```

替换为：

```ts
win.setBounds(fixedWindowBounds(p.x, p.y, SIZE))
```

保留 `shown` 布尔状态、`showInactive()` 和 `BUBBLE_PLACE` 通知；不要加入 `setResizable()` 调用。

- [ ] **Step 2：运行针对性测试与构建**

Run:

```bash
pnpm vitest run src/shared/windowPlacement.test.ts src/shared/bubblePlacement.test.ts
pnpm typecheck
pnpm build
```

Expected: 测试、类型检查和三束构建全部通过。

- [ ] **Step 3：提交气泡窗口接线**

```bash
git add src/main/shell/bubbleWindow.ts
git commit -m "fix(bubble): 固定DPI缩放下的气泡窗口尺寸"
```

## Task 4：全量验证与 Windows 150% DPI 真机复验

**Files:**
- Verify: `src/shared/windowPlacement.ts`
- Verify: `src/main/shell/petWindow.ts`
- Verify: `src/main/shell/index.ts`
- Verify: `src/main/shell/bubbleWindow.ts`

- [ ] **Step 1：运行全量自动化检查**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: 三条命令 exit code 均为 0；Vitest 无失败用例。

- [ ] **Step 2：检查最终差异**

Run:

```bash
git diff HEAD~3 --check
git diff HEAD~3 -- src/shared/windowPlacement.ts src/shared/windowPlacement.test.ts src/main/shell/petWindow.ts src/main/shell/index.ts src/main/shell/bubbleWindow.ts
```

Expected: `--check` 无输出；差异只包含固定尺寸定位、零位移短路及对应测试。

- [ ] **Step 3：主屏 150% DPI bounds 复验**

用 Electron Inspector 启动构建产物，发送一条最短消息使气泡显示，然后连续发送至少 200 次 `MOVE_WINDOW { dx: 2, dy: 0 }`，再发送至少 200 次 `{ dx: 0, dy: 0 }`。每 20 次读取：

```ts
BrowserWindow.getAllWindows().map((w) => ({
  url: w.webContents.getURL(),
  bounds: w.getBounds(),
  contentBounds: w.getContentBounds(),
  visible: w.isVisible(),
  resizable: w.isResizable()
}))
```

Expected:

- 宠物内容区保持 `256×288`，不随移动次数增长；
- 气泡内容区保持 `240×172`，不随移动次数增长；
- 零位移阶段两个窗口的位置和尺寸均不变化；
- 气泡可见状态保持正确。

- [ ] **Step 4：竖置副屏和工作区边界复验**

在副屏内部重复连续移动检查，并将宠物分别拖到上、下、左、右边界。

Expected:

- 宠物与气泡尺寸保持固定；
- 气泡在上边界翻到宠物下方；
- 左右边界只夹取气泡位置，尾巴仍指向宠物；
- 不出现相对位置累计漂移。

- [ ] **Step 5：确认工作区状态**

Run:

```bash
git status --short
```

Expected: 仅保留用户原有的未跟踪 `AGENTS.md`；没有测试日志、截图或临时诊断脚本进入仓库。
