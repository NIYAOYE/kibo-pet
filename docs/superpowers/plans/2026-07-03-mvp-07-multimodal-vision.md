# MVP-07 多模态识图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面宠物能识图:用户通过选文件 / 拖拽 / 粘贴 / 框选屏幕把图片交给宠物,宠物用支持视觉的模型看图作答。

**Architecture:** 所有图片来源汇入同一条归一化管线 —— 渲染层统一把图降采样到 ≤1568px 得到 `ChatSendAttachment`(瞬态字节),经 `CHAT_SEND` 送主进程;`chat.handleSend` 用注入的 `prepareImage` 产出最终 `ImagePart`,挂到当前 user 回合的 `ChatTurn.images`;两个 Provider 的 `messageMapping` 把 `images` 序列化成各自 SDK 形状。图片永不落盘,transcript 只存 `[图片] 文本` 占位。

**Tech Stack:** Electron(`nativeImage` / `desktopCapturer` / `dialog` / `BrowserWindow`)、TypeScript(strict)、Vitest、electron-vite。**不引任何新依赖。**

## Global Constraints

- 包管理器 **pnpm**;命令:`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm dev`/`pnpm preview`。
- **不要**给 `package.json` 加 `"type": "module"`(会让 Electron 主进程崩)。
- 跨进程值走 `src/shared` + `@shared/*` 别名;**绝不硬编码 IPC 通道字符串**,用 `IPC` 常量。新增 IPC 能力必须四处同步:`src/shared/ipc.ts`(常量+类型)、`src/main/shell/index.ts`(handler)、`src/preload/index.ts`(暴露)、渲染层调用方。
- 纯逻辑 **TDD**(先写失败测试);GUI/Electron/native 图像路径靠真机 `pnpm dev`/`preview` 肉眼验收(自动化测不到,与 MVP-06 GPU 问题同理)。
- **凡 import `electron` 的模块不可被 Vitest 直接 import**(测试环境无 electron 运行时)——纯逻辑与 native 封装拆成不同文件。
- 提交粒度:每任务一提交或数提交,conventional-commit 中文信息(如 `feat(vision): ...`)。
- 图像**永不持久化**:`transcript.json` / `facts.json` / `vector-index.json` 均不含图像字节。
- 图像编码规则:降采样最长边 ≤ **1568px**;`image/png`|`image/gif` 输出 PNG,其余输出 JPEG(质量 80~85)。
- IPC 附件上限:每图 base64 ≤ **14_000_000** 字符、最多 **6** 张、mimeType ∈ `{image/png,image/jpeg,image/webp,image/gif}`;超限整条 payload 拒绝。

---

## 文件结构

**新建:**
- `src/main/media/imageResize.ts` — 纯函数 `targetSize`(可单测)
- `src/main/media/imageResize.test.ts`
- `src/main/media/imagePrep.ts` — `prepareImage`(用 `nativeImage`,薄封装,不被 vitest import)
- `src/main/media/screenCapture.ts` — `captureRegion`(desktopCapturer + 覆盖层窗口 + crop)
- `src/main/providers/errorHint.ts` — 纯函数 `describeProviderError`(视觉/工具错误提示)
- `src/main/providers/errorHint.test.ts`
- `src/renderer/regionOverlay.html` + `src/renderer/regionOverlay.ts` — 框选覆盖层 UI

**修改:**
- `src/shared/llm.ts` — `ImagePart` 类型 + `ChatTurn.images`
- `src/shared/ipc.ts` — `ChatSendAttachment` 类型、`MediaApi`/`OverlayApi`、新 IPC 常量、Window 全局
- `src/shared/ipcValidation.ts` — 附件字节校验(mime/大小/张数)+ 导出上限常量
- `src/shared/ipcValidation.test.ts` — 附件校验用例
- `src/main/providers/messageMapping.ts` — user 图像 → 两 SDK block
- `src/main/providers/messageMapping.test.ts` — 图像序列化用例
- `src/main/providers/openaiCompatProvider.ts` — 错误经 `describeProviderError` 包装
- `src/main/shell/chat.ts` — `prepareImages` 注入 + 图挂当前回合 + transcript 占位 + 允许纯图发送
- `src/main/shell/chat.test.ts` — 图像端到端用例
- `src/preload/index.ts` — 暴露 `mediaApi` / `overlayApi`
- `src/main/shell/index.ts` — `MEDIA_PICK_IMAGE`/`MEDIA_CAPTURE_REGION` handler + 传 `prepareImages`
- `src/renderer/dialog.ts` + `src/renderer/dialog.html` — 缩略图带/+/截屏钮/拖粘/纯图发送/历史标记/CSP
- `electron.vite.config.ts` — 加 `regionOverlay.html` renderer 入口
- `PROGRESS.md` + `README.md` — 状态与截屏权限告知

---

## Task 1: 共享图像类型 + IPC 契约 + 附件校验

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcValidation.ts`
- Test: `src/shared/ipcValidation.test.ts`

**Interfaces:**
- Produces:
  - `interface ImagePart { mimeType: string; dataBase64: string }`(`@shared/llm`)
  - `ChatTurn.images?: ImagePart[]`
  - `interface ChatSendAttachment { kind: 'image'; mimeType: string; dataBase64: string }`(`@shared/ipc`)
  - `ChatSendPayload.attachments?: ChatSendAttachment[]`
  - `IPC.MEDIA_PICK_IMAGE`/`MEDIA_CAPTURE_REGION`/`OVERLAY_INIT`/`OVERLAY_SUBMIT`/`OVERLAY_CANCEL`
  - `interface OverlayInit { screenshotDataUrl: string; width: number; height: number }`
  - `interface OverlayRect { x: number; y: number; width: number; height: number }`
  - `interface MediaApi { pickImage(): Promise<ChatSendAttachment[]>; captureRegion(): Promise<ChatSendAttachment | null> }`
  - `interface OverlayApi { onInit(cb: (d: OverlayInit) => void): void; submit(rect: OverlayRect): void; cancel(): void }`
  - `validateChatSend` 升级 + 导出 `MAX_ATTACHMENTS`/`MAX_IMAGE_B64`/`IMAGE_MIME`
  - `validateOverlayRect(v): OverlayRect | null`

- [ ] **Step 1: 加图像类型到 `src/shared/llm.ts`**

在 `ChatTurn` 定义处替换:

```ts
export interface ImagePart { mimeType: string; dataBase64: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** 仅对 role:'user' 有意义:经预处理的图像;永不持久化 */
  images?: ImagePart[]
}
```

(`AgentMessage` 基于 `ChatTurn`,自动继承 `images`,无需改。)

- [ ] **Step 2: 扩展 `src/shared/ipc.ts` 类型与常量**

在 `IPC` 常量对象里追加(放在 `OPEN_MEMORY_DIR` 之后):

```ts
  MEDIA_PICK_IMAGE: 'media:pick-image',
  MEDIA_CAPTURE_REGION: 'media:capture-region',
  OVERLAY_INIT: 'overlay:init',
  OVERLAY_SUBMIT: 'overlay:submit',
  OVERLAY_CANCEL: 'overlay:cancel'
```

把 `ChatAttachment` / `ChatMessage` / `ChatSendPayload` 那三行替换为:

```ts
/** 持久化/展示用:仅标记"这轮有图",绝不携带字节 */
export interface ChatAttachment { kind: 'image' }
/** 发送用(瞬态):携带降采样后的图像字节,不落盘 */
export interface ChatSendAttachment { kind: 'image'; mimeType: string; dataBase64: string }
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[] }
export interface ChatSendPayload { text: string; attachments?: ChatSendAttachment[] }

export interface OverlayInit { screenshotDataUrl: string; width: number; height: number }
export interface OverlayRect { x: number; y: number; width: number; height: number }

export interface MediaApi {
  pickImage(): Promise<ChatSendAttachment[]>
  captureRegion(): Promise<ChatSendAttachment | null>
}
export interface OverlayApi {
  onInit(cb: (d: OverlayInit) => void): void
  submit(rect: OverlayRect): void
  cancel(): void
}
```

在文件末尾的 `declare global` 块里,把 `Window` 接口改为:

```ts
declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi }
}
```

- [ ] **Step 3: 写失败测试 `src/shared/ipcValidation.test.ts`**

在文件末尾追加(若文件不存在则创建含首行 import):

```ts
import { validateChatSend, validateOverlayRect } from './ipcValidation'
// (若已有 import 行,合并即可)

describe('validateChatSend 附件', () => {
  const okAtt = { kind: 'image', mimeType: 'image/jpeg', dataBase64: 'AAAA' }
  it('放行合法图片附件', () => {
    const r = validateChatSend({ text: '这是什么', attachments: [okAtt] })
    expect(r?.attachments?.length).toBe(1)
  })
  it('允许纯图(text 空字符串)', () => {
    expect(validateChatSend({ text: '', attachments: [okAtt] })).not.toBeNull()
  })
  it('拒绝非白名单 mimeType', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ ...okAtt, mimeType: 'image/svg+xml' }] })).toBeNull()
  })
  it('拒绝超张数', () => {
    expect(validateChatSend({ text: 'x', attachments: Array(7).fill(okAtt) })).toBeNull()
  })
  it('拒绝超大单图', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ ...okAtt, dataBase64: 'a'.repeat(14_000_001) }] })).toBeNull()
  })
  it('拒绝 dataBase64 非字符串', () => {
    expect(validateChatSend({ text: 'x', attachments: [{ kind: 'image', mimeType: 'image/png', dataBase64: 123 }] })).toBeNull()
  })
})

describe('validateOverlayRect', () => {
  it('放行有限数字矩形', () => {
    expect(validateOverlayRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
  it('拒绝非数字', () => {
    expect(validateOverlayRect({ x: 'a', y: 2, width: 3, height: 4 })).toBeNull()
  })
})
```

> 注:该测试文件顶部需有 `import { describe, it, expect } from 'vitest'`。若文件已存在且已 import,只加新 `describe` 块并把 `validateOverlayRect` 并入现有 import。

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL(`validateOverlayRect` 未导出 / 附件校验未实现)

- [ ] **Step 5: 升级 `src/shared/ipcValidation.ts`**

在 `MAX_KEY` 常量下方新增,并替换 `validateChatSend`,末尾加 `validateOverlayRect`:

```ts
export const MAX_ATTACHMENTS = 6
export const MAX_IMAGE_B64 = 14_000_000
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function validateAttachment(v: unknown): { kind: 'image'; mimeType: string; dataBase64: string } | null {
  if (!isObject(v)) return null
  if (v.kind !== 'image') return null
  if (typeof v.mimeType !== 'string' || !IMAGE_MIME.includes(v.mimeType)) return null
  if (typeof v.dataBase64 !== 'string' || v.dataBase64.length === 0 || v.dataBase64.length > MAX_IMAGE_B64) return null
  return { kind: 'image', mimeType: v.mimeType, dataBase64: v.dataBase64 }
}

export function validateChatSend(v: unknown): ChatSendPayload | null {
  if (!isObject(v)) return null
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT) return null
  const payload: ChatSendPayload = { text: v.text }
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments) || v.attachments.length > MAX_ATTACHMENTS) return null
    const atts: ChatSendAttachment[] = []
    for (const a of v.attachments) {
      const att = validateAttachment(a)
      if (!att) return null
      atts.push(att)
    }
    if (atts.length > 0) payload.attachments = atts
  }
  return payload
}

export function validateOverlayRect(v: unknown): OverlayRect | null {
  if (!isObject(v)) return null
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.width) || !Number.isFinite(v.height)) return null
  return { x: v.x as number, y: v.y as number, width: v.width as number, height: v.height as number }
}
```

并把顶部 import 改为:

```ts
import type { MoveDelta, ChatSendPayload, ChatSendAttachment, OverlayRect } from './ipc'
```

- [ ] **Step 6: 运行测试确认通过 + 类型检查**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts && pnpm typecheck`
Expected: PASS;typecheck 0 error

- [ ] **Step 7: Commit**

```bash
git add src/shared/llm.ts src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts
git commit -m "feat(vision): 共享图像类型 + IPC 契约 + 附件字节校验"
```

---

## Task 2: 图像预处理(降采样 + 重编码)

**Files:**
- Create: `src/main/media/imageResize.ts`
- Create: `src/main/media/imagePrep.ts`
- Test: `src/main/media/imageResize.test.ts`

**Interfaces:**
- Consumes: `ImagePart`(`@shared/llm`)
- Produces:
  - `targetSize(w: number, h: number, maxEdge: number): { width: number; height: number }`(纯)
  - `MAX_EDGE = 1568`
  - `prepareImage(a: { mimeType: string; dataBase64: string }, maxEdge?: number): ImagePart`

- [ ] **Step 1: 写失败测试 `src/main/media/imageResize.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { targetSize } from './imageResize'

describe('targetSize', () => {
  it('最长边超阈值按比例缩', () => {
    expect(targetSize(2000, 1000, 1568)).toEqual({ width: 1568, height: 784 })
  })
  it('已在阈值内原样返回', () => {
    expect(targetSize(100, 100, 1568)).toEqual({ width: 100, height: 100 })
  })
  it('竖图按高缩', () => {
    expect(targetSize(1000, 2000, 1568)).toEqual({ width: 784, height: 1568 })
  })
  it('零尺寸不除零', () => {
    expect(targetSize(0, 0, 1568)).toEqual({ width: 0, height: 0 })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/media/imageResize.test.ts`
Expected: FAIL(找不到模块 / `targetSize` 未定义)

- [ ] **Step 3: 实现 `src/main/media/imageResize.ts`(纯,不 import electron)**

```ts
/** 计算降采样目标尺寸:最长边 > maxEdge 时等比缩到最长边 = maxEdge,否则原样。 */
export function targetSize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= maxEdge || longest === 0) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/media/imageResize.test.ts`
Expected: PASS

- [ ] **Step 5: 实现 `src/main/media/imagePrep.ts`(薄封装,import electron)**

```ts
import { nativeImage } from 'electron'
import type { ImagePart } from '@shared/llm'
import { targetSize } from './imageResize'

export const MAX_EDGE = 1568

/**
 * 用 Electron 内置 nativeImage 解码原图 → 降采样(最长边 ≤ MAX_EDGE)→ 重编码 base64。
 * png/gif 输出 PNG(保透明);其余输出 JPEG。幂等:对已合规图再跑一次≈原样重编码。
 * 该模块 import electron,不可被 Vitest 直接 import(靠真机验收)。
 */
export function prepareImage(a: { mimeType: string; dataBase64: string }, maxEdge = MAX_EDGE): ImagePart {
  const buf = Buffer.from(a.dataBase64, 'base64')
  let img = nativeImage.createFromBuffer(buf)
  const { width, height } = img.getSize()
  const t = targetSize(width, height, maxEdge)
  if (t.width !== width || t.height !== height) img = img.resize({ width: t.width, height: t.height, quality: 'good' })
  const keepPng = a.mimeType === 'image/png' || a.mimeType === 'image/gif'
  const out = keepPng ? img.toPNG() : img.toJPEG(80)
  return { mimeType: keepPng ? 'image/png' : 'image/jpeg', dataBase64: out.toString('base64') }
}
```

- [ ] **Step 6: 类型检查**

Run: `pnpm typecheck`
Expected: 0 error

- [ ] **Step 7: Commit**

```bash
git add src/main/media/imageResize.ts src/main/media/imageResize.test.ts src/main/media/imagePrep.ts
git commit -m "feat(vision): nativeImage 图像降采样+重编码预处理"
```

---

## Task 3: Provider 图像序列化

**Files:**
- Modify: `src/main/providers/messageMapping.ts`
- Test: `src/main/providers/messageMapping.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`(含 `ChatTurn.images`)
- Produces:`toAnthropicMessages` / `toOpenAiMessages` 对带 `images` 的 user 回合输出 block 数组(签名不变)

- [ ] **Step 1: 写失败测试(追加到 `src/main/providers/messageMapping.test.ts`)**

```ts
describe('图像序列化', () => {
  const img = { mimeType: 'image/jpeg', dataBase64: 'QUJD' }

  it('anthropic:user 图在前、文字在后', () => {
    const out = toAnthropicMessages([{ role: 'user', content: '这是什么', images: [img] }])
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'text', text: '这是什么' }
      ]
    })
  })

  it('openai-compat:user 文字在前、image_url data URL 在后', () => {
    const out = toOpenAiMessages('sys', [{ role: 'user', content: '这是什么', images: [img] }])
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
      ]
    })
  })

  it('无图 user 回合行为不变(字符串 content)', () => {
    expect(toAnthropicMessages([{ role: 'user', content: 'hi' }])[0]).toEqual({ role: 'user', content: 'hi' })
    expect(toOpenAiMessages('s', [{ role: 'user', content: 'hi' }])[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('纯图无文字:不产出空 text block', () => {
    const out = toAnthropicMessages([{ role: 'user', content: '', images: [img] }])
    expect((out[0].content as unknown[]).length).toBe(1)
  })
})
```

> 若测试文件顶部未 import 这两个函数,合并进现有 import:`import { toAnthropicMessages, toOpenAiMessages } from './messageMapping'`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/messageMapping.test.ts`
Expected: FAIL(带图 user 仍被当作字符串 content)

- [ ] **Step 3: 改 `toAnthropicMessages` 的 `else` 分支**

把 `messageMapping.ts:35-37` 的 `else { out.push({ role: m.role, content: m.content }) }` 替换为:

```ts
    } else if (m.role === 'user' && m.images && m.images.length > 0) {
      const blocks: Array<Record<string, unknown>> = m.images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 }
      }))
      if (m.content) blocks.push({ type: 'text', text: m.content })
      out.push({ role: 'user', content: blocks })
    } else {
      out.push({ role: m.role, content: m.content })
    }
```

- [ ] **Step 4: 改 `toOpenAiMessages` 的 `else` 分支**

把 `messageMapping.ts:61-63` 的 `else { out.push({ role: m.role, content: m.content }) }` 替换为:

```ts
    } else if (m.role === 'user' && m.images && m.images.length > 0) {
      const content: Array<Record<string, unknown>> = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const img of m.images) content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } })
      out.push({ role: 'user', content })
    } else {
      out.push({ role: m.role, content: m.content })
    }
```

- [ ] **Step 5: 运行确认通过 + 类型检查**

Run: `pnpm vitest run src/main/providers/messageMapping.test.ts && pnpm typecheck`
Expected: PASS;0 error

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/messageMapping.ts src/main/providers/messageMapping.test.ts
git commit -m "feat(vision): messageMapping 支持 user 图像块(两 Provider)"
```

---

## Task 4: Provider 视觉/工具错误提示

**Files:**
- Create: `src/main/providers/errorHint.ts`
- Test: `src/main/providers/errorHint.test.ts`
- Modify: `src/main/providers/openaiCompatProvider.ts`

**Interfaces:**
- Produces: `describeProviderError(msg: string): string`

- [ ] **Step 1: 写失败测试 `src/main/providers/errorHint.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { describeProviderError } from './errorHint'

describe('describeProviderError', () => {
  it('视觉相关错误加换模型提示', () => {
    expect(describeProviderError('model does not support image input')).toContain('支持视觉的模型')
  })
  it('工具相关错误加 function calling 提示', () => {
    expect(describeProviderError('this model does not support tools')).toContain('function calling')
  })
  it('无关错误原样返回', () => {
    expect(describeProviderError('rate limit exceeded')).toBe('rate limit exceeded')
  })
  it('视觉优先于工具(同时命中时给视觉提示)', () => {
    expect(describeProviderError('vision tool unsupported')).toContain('支持视觉的模型')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/errorHint.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/main/providers/errorHint.ts`**

```ts
/**
 * 把 provider 端点的错误信息包装成对用户可操作的提示。
 * 不预判能力:带图直发,端点报错时据错误文本给出换模型建议。视觉优先于工具。
 */
export function describeProviderError(msg: string): string {
  if (/image|vision|multimodal|视觉|不支持.*图/i.test(msg)) {
    return `${msg}(当前模型可能不支持识图,请在设置里换支持视觉的模型,如 gpt-4o、qwen-vl、GLM-4V、本地 llava)`
  }
  if (/tool|function/i.test(msg)) {
    return `${msg}(当前模型可能不支持工具调用,请换支持 function calling 的模型)`
  }
  return msg
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/errorHint.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 `openaiCompatProvider.ts`**

顶部加 import:

```ts
import { describeProviderError } from './errorHint'
```

把 `openaiCompatProvider.ts:73-74` 的:

```ts
        const msg = String((err as Error)?.message ?? err)
        yield { type: 'error', message: /tool|function/i.test(msg) ? `${msg}(当前模型可能不支持工具调用,请换支持 function calling 的模型)` : msg }
```

替换为:

```ts
        const msg = String((err as Error)?.message ?? err)
        yield { type: 'error', message: describeProviderError(msg) }
```

- [ ] **Step 6: 回归 provider 测试 + 类型检查**

Run: `pnpm vitest run src/main/providers/ && pnpm typecheck`
Expected: PASS(现有 openaiCompat 工具错误用例仍绿);0 error

- [ ] **Step 7: Commit**

```bash
git add src/main/providers/errorHint.ts src/main/providers/errorHint.test.ts src/main/providers/openaiCompatProvider.ts
git commit -m "feat(vision): provider 错误提示统一处理视觉/工具不支持"
```

---

## Task 5: chat.handleSend 图像编排

**Files:**
- Modify: `src/main/shell/chat.ts`
- Test: `src/main/shell/chat.test.ts`

**Interfaces:**
- Consumes: `ChatSendAttachment`(`@shared/ipc`)、`ImagePart`(`@shared/llm`)、`prepareImage`(由调用方注入,`chat.ts` 不 import electron)
- Produces:`createChatStore` opts 新增必填 `prepareImages: (atts: ChatSendAttachment[]) => ImagePart[]`;`handleSend` 支持带图/纯图

- [ ] **Step 1: 写失败测试(追加到 `chat.test.ts`)**

先把 `makeStore` 里的 `createChatStore({...})` 调用补一个注入项(在 `makeProvider` 行下面加一行):

```ts
    prepareImages: (atts) => atts.map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 })),
```

(测试用直通实现,避开 electron。)然后追加用例:

```ts
describe('chat 图像', () => {
  const att = { kind: 'image' as const, mimeType: 'image/jpeg', dataBase64: 'QUJD' }

  it('图挂在当前 user 回合,传给 provider', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: '看到啦' }), seen)
    store.handleSend({ text: '这是什么', attachments: [att] })
    await finished
    const last = seen[0].messages[seen[0].messages.length - 1]
    expect(last.role).toBe('user')
    expect((last as { images?: unknown[] }).images?.length).toBe(1)
  })

  it('transcript 用户回合存 [图片] 前缀,不含 base64', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '看看', attachments: [att] })
    await finished
    const raw = readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8')
    expect(raw).not.toContain('QUJD')
    const t = JSON.parse(raw)
    expect(t.messages[0].text).toBe('[图片] 看看')
  })

  it('纯图(空文字)也能发送', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '', attachments: [att] })
    await finished
    expect(seen.length).toBe(1)
  })

  it('无文字无图直接忽略', () => {
    const seen: StreamChatRequest[] = []
    const { store } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '   ' })
    expect(seen.length).toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: FAIL(`prepareImages` 未知选项 / 图未挂上 / 无 `[图片]` 前缀)

- [ ] **Step 3: 改 `chat.ts` opts 类型与 imports**

顶部 import 追加类型:

```ts
import type { ChatMessage, ChatSendPayload, ChatSendAttachment } from '@shared/ipc'
import type { ImagePart } from '@shared/llm'
```

(把原 `import type { ChatMessage, ChatSendPayload } from '@shared/ipc'` 合并成上面第一行。)

在 `createChatStore` 的 opts 对象类型里,`makeProvider?` 那行下方加:

```ts
  /** 主进程注入的图像预处理(chat.ts 不 import electron;测试注入直通实现) */
  prepareImages: (attachments: ChatSendAttachment[]) => ImagePart[]
```

- [ ] **Step 4: 改 `handleSend` 主体**

把 `chat.ts` 的 `handleSend(payload: ChatSendPayload): void { ... }`(约 55-124 行)整体替换为:

```ts
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      const rawAtts = payload?.attachments ?? []
      const hasImages = rawAtts.length > 0
      if (!text && !hasImages) return
      cancel() // 新消息取消在途

      // 单一预处理点:注入的 prepareImages 产出最终 ImagePart(图片永不落盘)
      const images: ImagePart[] = hasImages ? opts.prepareImages(rawAtts) : []
      // transcript 只存文本占位 + 标记;带图时前缀 [图片],让后续文本窗口知道这轮有图
      const storedText = hasImages ? (text ? `[图片] ${text}` : '[图片]') : text
      opts.memory.appendMessage(
        hasImages
          ? { role: 'user', text: storedText, attachments: rawAtts.map(() => ({ kind: 'image' as const })) }
          : { role: 'user', text: storedText }
      )
      opts.pushUpdate(opts.memory.messages())
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        opts.memory.appendMessage({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(opts.memory.messages())
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const provider = make(settings.provider, key)
      const backend = settings.search.backend === 'tavily'
        ? createTavilyBackend(() => opts.getSearchKey())
        : createDuckDuckGoBackend()
      const registry = createToolRegistry([
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t))
      ])

      const ctrl = new AbortController()
      inFlight = ctrl
      let acc = ''
      void (async () => {
        const recalled = await opts.memory.recall(text, ctrl.signal)
        if (ctrl.signal.aborted) return
        const { system, messages } = assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled)
        // 图挂当前回合:窗口末条即刚追加的 user 消息(assemblePrompt 已裁到 user 起头)
        const lastUser = messages[messages.length - 1]
        if (images.length > 0 && lastUser && lastUser.role === 'user') lastUser.images = images
        const res = await runAgent({
          provider,
          system,
          messages,
          registry,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          signal: ctrl.signal,
          onText: (t) => { acc += t; opts.pushStream(t) },
          onStatus: (t) => opts.pushStatus(t)
        })
        if (inFlight === ctrl) inFlight = null
        if (res.canceled) return
        if (res.error) {
          if (acc) opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
        } else {
          opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushDone()
          opts.emitPetEvent('replyDone')
        }
        opts.memory.maybeSummarize(() => {
          const k = opts.getKey()
          return k ? make(settings.provider, k) : null
        })
      })()
    }
```

- [ ] **Step 5: 在 `shell/index.ts` 接线 `prepareImages`(使本任务结束即全绿)**

`prepareImages` 是必填项,必须同步在唯一调用处提供,否则 typecheck 红。

`src/main/shell/index.ts` 顶部 import 追加:

```ts
import { prepareImage } from '../media/imagePrep'
```

在 `createChatStore({...})` 的 opts 里(`getSearchKey: () => searchSecrets.getKey(),` 行下面)加:

```ts
    prepareImages: (atts) => atts.map((a) => prepareImage(a)),
```

- [ ] **Step 6: 运行确认通过 + 类型检查**

Run: `pnpm vitest run src/main/shell/chat.test.ts && pnpm typecheck`
Expected: PASS;0 error(含 `shell/index.ts`)

- [ ] **Step 7: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/chat.test.ts src/main/shell/index.ts
git commit -m "feat(vision): chat 编排图像(挂当前回合+transcript占位+纯图发送)"
```

---

## Task 6: 选文件入口(preload + 主进程 handler)

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `IPC.MEDIA_PICK_IMAGE`、`prepareImage`、`MAX_ATTACHMENTS`、`ChatSendAttachment`
- Produces: `window.mediaApi.pickImage()`;主进程 `MEDIA_PICK_IMAGE` handler 返回 `ChatSendAttachment[]`(已降采样)

- [ ] **Step 1: preload 暴露 `mediaApi` 与 `overlayApi`**

`src/preload/index.ts` 顶部 import 追加:

```ts
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect
} from '@shared/ipc'
```

在 `contextBridge.exposeInMainWorld('settingsApi', settingsApi)` 之前加:

```ts
const mediaApi: MediaApi = {
  pickImage: (): Promise<ChatSendAttachment[]> => ipcRenderer.invoke(IPC.MEDIA_PICK_IMAGE),
  captureRegion: (): Promise<ChatSendAttachment | null> => ipcRenderer.invoke(IPC.MEDIA_CAPTURE_REGION)
}

const overlayApi: OverlayApi = {
  onInit: (cb: (d: OverlayInit) => void): void => {
    ipcRenderer.removeAllListeners(IPC.OVERLAY_INIT)
    ipcRenderer.on(IPC.OVERLAY_INIT, (_e, d: OverlayInit) => cb(d))
  },
  submit: (rect: OverlayRect): void => ipcRenderer.send(IPC.OVERLAY_SUBMIT, rect),
  cancel: (): void => ipcRenderer.send(IPC.OVERLAY_CANCEL)
}
```

文件末尾追加:

```ts
contextBridge.exposeInMainWorld('mediaApi', mediaApi)
contextBridge.exposeInMainWorld('overlayApi', overlayApi)
```

- [ ] **Step 2: 主进程 handler 所需 imports**

`src/main/shell/index.ts` 顶部:把 electron import 补 `dialog as electronDialog`,把 `node:fs` 的 `mkdirSync` 补 `readFileSync`:

```ts
import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, type Tray } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
```

追加:

```ts
import { MAX_ATTACHMENTS } from '@shared/ipcValidation'
import type { ChatSendAttachment } from '@shared/ipc'
```

(`prepareImage` 已在 Task 5 import;`createChatStore` 的 `prepareImages` 也已在 Task 5 接线,本任务不再重复。)

- [ ] **Step 3: 加 `MEDIA_PICK_IMAGE` handler**

在 `ipcMain.on(IPC.CHAT_SEND, ...)` 附近加一个 mime 小工具与 handler(放到 `ipcMain.on(IPC.CANCEL_CHAT, ...)` 之后):

```ts
function mimeFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

ipcMain.handle(IPC.MEDIA_PICK_IMAGE, async (): Promise<ChatSendAttachment[]> => {
  const r = await electronDialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (r.canceled) return []
  const out: ChatSendAttachment[] = []
  for (const p of r.filePaths.slice(0, MAX_ATTACHMENTS)) {
    try {
      const prepped = prepareImage({ mimeType: mimeFromPath(p), dataBase64: readFileSync(p).toString('base64') })
      out.push({ kind: 'image', mimeType: prepped.mimeType, dataBase64: prepped.dataBase64 })
    } catch (e) {
      console.warn('[media] 读取/预处理图片失败', p, e)
    }
  }
  return out
})
```

(主进程在此已 `prepareImage` 降采样,返回给渲染层的就是小图,不会触发 CHAT_SEND 的体积上限。)

- [ ] **Step 4: 构建验证(暂不接 UI)**

Run: `pnpm typecheck && pnpm build`
Expected: 0 error;三 bundle 产出成功

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/main/shell/index.ts
git commit -m "feat(vision): 选文件入口(mediaApi + 主进程读图预处理 handler)"
```

---

## Task 7: 截屏框选(desktopCapturer + 覆盖层窗口)

**Files:**
- Create: `src/main/media/screenCapture.ts`
- Create: `src/renderer/regionOverlay.html`
- Create: `src/renderer/regionOverlay.ts`
- Modify: `electron.vite.config.ts`
- Modify: `src/main/shell/index.ts`(加 `MEDIA_CAPTURE_REGION` handler)

**Interfaces:**
- Consumes: `IPC.OVERLAY_*`、`OverlayRect`、`ChatSendAttachment`、`prepareImage`、`validateOverlayRect`
- Produces: `captureRegion(opts): Promise<ChatSendAttachment | null>`;`window.mediaApi.captureRegion()` 端到端

> **本任务为 native/GUI,自动化测不到 → 全靠真机 `pnpm dev` 肉眼验收(Step 6)。**

- [ ] **Step 1: 加 renderer 入口到 `electron.vite.config.ts`**

在 `renderer.build.rollupOptions.input` 里,`settings:` 行下加:

```ts
          overlay: resolve('src/renderer/regionOverlay.html')
```

- [ ] **Step 2: 实现覆盖层 UI `src/renderer/regionOverlay.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; cursor: crosshair; user-select: none; }
      #shot { position: fixed; inset: 0; width: 100vw; height: 100vh; object-fit: fill; }
      #mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); }
      #sel { position: fixed; display: none; border: 2px solid #6ea8ff;
             background: rgba(110, 168, 255, 0.15); box-shadow: 0 0 0 9999px rgba(0,0,0,0.4); }
      #hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
              color: #fff; font: 13px system-ui; background: rgba(0,0,0,0.6);
              padding: 6px 12px; border-radius: 8px; pointer-events: none; }
    </style>
  </head>
  <body>
    <img id="shot" />
    <div id="mask"></div>
    <div id="sel"></div>
    <div id="hint">拖动框选区域发给宠物 · Esc 取消</div>
    <script type="module" src="./regionOverlay.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: 实现覆盖层脚本 `src/renderer/regionOverlay.ts`**

```ts
import type { OverlayRect } from '@shared/ipc'

const shot = document.getElementById('shot') as HTMLImageElement
const mask = document.getElementById('mask') as HTMLElement
const sel = document.getElementById('sel') as HTMLElement

let sx = 0, sy = 0, dragging = false

window.overlayApi.onInit((d) => { shot.src = d.screenshotDataUrl })

function rectOf(x: number, y: number): OverlayRect {
  return { x: Math.min(sx, x), y: Math.min(sy, y), width: Math.abs(x - sx), height: Math.abs(y - sy) }
}
function place(r: OverlayRect): void {
  sel.style.left = `${r.x}px`; sel.style.top = `${r.y}px`
  sel.style.width = `${r.width}px`; sel.style.height = `${r.height}px`
}

window.addEventListener('mousedown', (e) => {
  dragging = true; sx = e.clientX; sy = e.clientY
  mask.style.display = 'none' // 用 sel 的 box-shadow 充当遮罩,避免双层
  sel.style.display = 'block'; place(rectOf(e.clientX, e.clientY))
})
window.addEventListener('mousemove', (e) => { if (dragging) place(rectOf(e.clientX, e.clientY)) })
window.addEventListener('mouseup', (e) => {
  if (!dragging) return
  dragging = false
  window.overlayApi.submit(rectOf(e.clientX, e.clientY))
})
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.overlayApi.cancel() })
```

- [ ] **Step 4: 实现 `src/main/media/screenCapture.ts`**

```ts
import { BrowserWindow, desktopCapturer, ipcMain, type Display } from 'electron'
import { IPC, type ChatSendAttachment } from '@shared/ipc'
import { validateOverlayRect } from '@shared/ipcValidation'
import { prepareImage } from './imagePrep'

/**
 * 框选截屏:抓当前显示器全分辨率截图 → 弹全屏透明覆盖层 → 用户拖矩形 →
 * 按 scaleFactor 换算到设备像素裁剪 → prepareImage(JPEG)。Esc/空选/关窗 → null。
 * native + GUI,靠真机验收。限当前显示器(多显示器 deferred)。
 */
export async function captureRegion(opts: {
  preload: string
  overlayHtml: string
  overlayUrl?: string
  display: Display
}): Promise<ChatSendAttachment | null> {
  const { display } = opts
  const scale = display.scaleFactor
  const full = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full })
  const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!src) return null
  const shot = src.thumbnail // 全分辨率 nativeImage

  return await new Promise<ChatSendAttachment | null>((resolve) => {
    const win = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y,
      width: display.bounds.width, height: display.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, resizable: false, movable: false, enableLargerThanScreen: true,
      webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    let settled = false
    const cleanup = (): void => {
      ipcMain.removeListener(IPC.OVERLAY_SUBMIT, onSubmit)
      ipcMain.removeListener(IPC.OVERLAY_CANCEL, onCancel)
    }
    const finish = (v: ChatSendAttachment | null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!win.isDestroyed()) win.close()
      resolve(v)
    }
    const onSubmit = (_e: unknown, raw: unknown): void => {
      const rect = validateOverlayRect(raw)
      if (!rect) return finish(null)
      const dx = Math.round(rect.x * scale), dy = Math.round(rect.y * scale)
      const dw = Math.round(rect.width * scale), dh = Math.round(rect.height * scale)
      if (dw < 2 || dh < 2) return finish(null)
      try {
        const cropped = shot.crop({ x: dx, y: dy, width: dw, height: dh })
        const prepped = prepareImage({ mimeType: 'image/jpeg', dataBase64: cropped.toJPEG(85).toString('base64') })
        finish({ kind: 'image', mimeType: prepped.mimeType, dataBase64: prepped.dataBase64 })
      } catch {
        finish(null)
      }
    }
    const onCancel = (): void => finish(null)

    ipcMain.on(IPC.OVERLAY_SUBMIT, onSubmit)
    ipcMain.on(IPC.OVERLAY_CANCEL, onCancel)
    win.on('closed', () => finish(null))
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(IPC.OVERLAY_INIT, {
        screenshotDataUrl: shot.toDataURL(),
        width: display.bounds.width,
        height: display.bounds.height
      })
    })
    if (opts.overlayUrl) void win.loadURL(opts.overlayUrl)
    else void win.loadFile(opts.overlayHtml)
    win.show()
    win.focus()
  })
}
```

- [ ] **Step 5: 加 `MEDIA_CAPTURE_REGION` handler 到 `shell/index.ts`**

顶部 import 追加:

```ts
import { captureRegion } from '../media/screenCapture'
```

在 `startShell` 里(`dialogHtml` 定义附近)加覆盖层路径:

```ts
  const overlayHtml = join(dirname, '../renderer/regionOverlay.html')
  const overlayUrl = rendererUrl ? `${rendererUrl}/regionOverlay.html` : undefined
```

在 `MEDIA_PICK_IMAGE` handler 之后加:

```ts
ipcMain.handle(IPC.MEDIA_CAPTURE_REGION, async (): Promise<ChatSendAttachment | null> => {
  const [x, y] = petWin.getPosition()
  const [w, h] = petWin.getSize()
  const display = screen.getDisplayMatching({ x, y, width: w, height: h })
  return captureRegion({ preload, overlayHtml, overlayUrl, display })
})
```

- [ ] **Step 6: 真机验收(build 后 preview 或 dev)**

Run: `pnpm build`(先确认 0 error 与三 bundle + overlay 入口产出),再 `pnpm dev`
手动检查(见 Task 9 的验收清单第 3 条):触发截屏 → 覆盖层铺满当前屏 → 拖框 → 关闭覆盖层;`Esc` 取消不发送。

> 触发方式在 Task 8 接 UI 按钮;本步可临时在 dialog.ts 里挂个测试调用,或直接进入 Task 8 后连测。

- [ ] **Step 7: Commit**

```bash
git add src/main/media/screenCapture.ts src/renderer/regionOverlay.html src/renderer/regionOverlay.ts electron.vite.config.ts src/main/shell/index.ts
git commit -m "feat(vision): 截屏框选(desktopCapturer + 全屏覆盖层裁剪)"
```

---

## Task 8: 对话框图像 UI(缩略图带 / 拖粘 / 按钮 / 历史标记)

**Files:**
- Modify: `src/renderer/dialog.html`
- Modify: `src/renderer/dialog.ts`

**Interfaces:**
- Consumes: `window.mediaApi`、`ChatSendAttachment`、`ChatMessage.attachments`
- Produces:渲染层待发附件管理 + 四种输入接线 + 纯图发送 + 历史 `🖼×N` 标记

> **GUI,自动化测不到 → 真机 `pnpm dev` 肉眼验收(Task 9)。**

- [ ] **Step 1: 改 `dialog.html`(CSP + DOM + 样式)**

把 CSP meta 改为(加 `img-src`):

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
```

在 `<style>` 末尾(`#panel.expanded #send` 规则后)加:

```css
      /* 待发缩略图带 */
      #attach { display: none; flex-shrink: 0; gap: 6px; flex-wrap: wrap; -webkit-app-region: no-drag; }
      #attach .thumb { position: relative; width: 44px; height: 44px; }
      #attach .thumb img { width: 44px; height: 44px; object-fit: cover; border-radius: 6px; }
      #attach .thumb button { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px;
             padding: 0; line-height: 14px; border-radius: 8px; font-size: 11px;
             background: rgba(30,30,40,0.95); color: #fff; }
      #bar button.icon { padding: 6px 7px; }
      .msg .imgmark { opacity: 0.85; margin-right: 4px; }
```

把 `#bar` 那段 DOM 替换为(加 `#attach` 带 + 两个按钮):

```html
      <div id="attach"></div>
      <div id="bar">
        <input id="input" type="text" placeholder="说点什么…" />
        <button id="pick" class="icon" title="选择图片">＋</button>
        <button id="shot" class="icon" title="框选截屏">📷</button>
        <button id="toggle" title="展开">⤢</button>
        <button id="send">发送</button>
      </div>
```

- [ ] **Step 2: 改 `dialog.ts` — 待发附件状态与渲染**

顶部 import 改为携带 `ChatSendAttachment`:

```ts
import type { ChatMessage, ChatSendAttachment } from '@shared/ipc'
```

在 `const sendBtn = ...` 后加元素引用与状态:

```ts
const pickBtn = document.getElementById('pick') as HTMLButtonElement
const shotBtn = document.getElementById('shot') as HTMLButtonElement
const attachStrip = document.getElementById('attach') as HTMLElement

const MAX_ATTACH = 6
let pending: ChatSendAttachment[] = []

function renderPending(): void {
  attachStrip.innerHTML = ''
  attachStrip.style.display = pending.length ? 'flex' : 'none'
  pending.forEach((a, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'thumb'
    const im = document.createElement('img')
    im.src = `data:${a.mimeType};base64,${a.dataBase64}`
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = '移除'
    x.addEventListener('click', () => { pending.splice(i, 1); renderPending() })
    wrap.append(im, x)
    attachStrip.appendChild(wrap)
  })
}

function addPending(atts: ChatSendAttachment[]): void {
  for (const a of atts) { if (pending.length >= MAX_ATTACH) break; pending.push(a) }
  renderPending()
}

/** 渲染层统一降采样到 ≤1568 JPEG,保证 IPC payload 有界 */
async function downscale(file: File, maxEdge = 1568): Promise<ChatSendAttachment> {
  const bmp = await createImageBitmap(file)
  const longest = Math.max(bmp.width, bmp.height)
  const s = longest > maxEdge ? maxEdge / longest : 1
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const url = c.toDataURL('image/jpeg', 0.85)
  return { kind: 'image', mimeType: 'image/jpeg', dataBase64: url.split(',')[1] }
}

async function addFiles(files: Iterable<File>): Promise<void> {
  const out: ChatSendAttachment[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try { out.push(await downscale(f)) } catch { /* 跳过坏图 */ }
  }
  if (out.length) addPending(out)
}
```

- [ ] **Step 3: 改 `submit()` 支持带图/纯图 + 清空**

把 `submit()` 函数体替换为:

```ts
function submit(): void {
  const text = input.value.trim()
  if (!text && pending.length === 0) return
  streaming = ''
  document.getElementById('streaming-msg')?.remove()
  clearStatus()
  if (bubbleTimer !== null) { clearTimeout(bubbleTimer); bubbleTimer = null }
  bubble.classList.remove('show')
  bubble.textContent = ''
  window.chatApi.send({ text, attachments: pending.length ? pending : undefined })
  input.value = ''
  pending = []
  renderPending()
}
```

- [ ] **Step 4: 接线按钮 / 拖拽 / 粘贴**

在 `input.addEventListener('keydown', ...)` 那行下面加:

```ts
pickBtn.addEventListener('click', async () => {
  const atts = await window.mediaApi.pickImage()
  if (atts.length) addPending(atts)
})
shotBtn.addEventListener('click', async () => {
  const att = await window.mediaApi.captureRegion()
  if (att) addPending([att])
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
})
window.addEventListener('paste', (e) => {
  const files: File[] = []
  for (const it of e.clipboardData?.items ?? []) {
    if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f) }
  }
  if (files.length) void addFiles(files)
})
```

- [ ] **Step 5: 历史里给带图用户消息加标记**

在 `render()` 的 `for (const m of messages)` 循环里,把 user 分支改为在文本前加 `🖼×N`:

把:

```ts
    if (m.role === 'pet') el.innerHTML = renderMarkdownSafe(m.text)
    else el.textContent = m.text
```

替换为:

```ts
    if (m.role === 'pet') {
      el.innerHTML = renderMarkdownSafe(m.text)
    } else {
      const n = m.attachments?.length ?? 0
      if (n > 0) {
        const mark = document.createElement('span')
        mark.className = 'imgmark'
        mark.textContent = `🖼×${n}`
        el.appendChild(mark)
      }
      el.appendChild(document.createTextNode(m.text))
    }
```

- [ ] **Step 6: 真机验收全链路**

Run: `pnpm build && pnpm dev`
逐条走 Task 9 验收清单第 1~5 条。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/dialog.html src/renderer/dialog.ts
git commit -m "feat(vision): 对话框图像 UI(缩略图带/选图/截屏/拖粘/历史标记)"
```

---

## Task 9: 全量回归 + 文档

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

- [ ] **Step 1: 全量自动化回归**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿(原 204 条 + 本期新增用例);typecheck 0 error;三 bundle + overlay 入口产出。

- [ ] **Step 2: 真机验收清单(逐条肉眼确认;强模型如 claude-haiku / gpt-4o / qwen-vl)**

1. **选文件识图**:点「＋」→ 选一张图 → 缩略图带出现该图 →(可加文字)发送 → 宠物描述图像内容;缩略图带发送后清空。
2. **拖拽 / 粘贴识图**:把图片文件拖进对话框、或 Ctrl+V 粘贴截图 → 出现缩略图 → 发送 → 宠物正确描述。
3. **截屏框选**:点「📷」→ 全屏覆盖层出现 → 拖出一块区域松手 → 覆盖层关闭、缩略图带出现该区域 → 发送 → 宠物描述该区域;再次触发按 `Esc` → 取消、不发送、不留缩略图。
4. **不支持视觉的模型**:设置切到纯文本 openai-compat 模型(如 deepseek-chat)带图发送 → 对话框出现「…当前模型可能不支持识图,请换支持视觉的模型」提示。
5. **不落盘核对**:打开宠物记忆目录的 `transcript.json` → 带图那轮是 `[图片] …`、**搜不到 base64 长串**;`facts.json` / `vector-index.json` 无图像数据。
6. **回归**:不带图的普通对话、搜索、记忆一切照旧。

- [ ] **Step 3: 更新 `PROGRESS.md`**

- 顶部状态行与 §1 改为 MVP-07 完成;§6 路线图加一条:

```markdown
- ✅ **MVP-07** 多模态识图(归一化图像管线 + 两 Provider 图像序列化 + 选文件/拖拽/粘贴/截屏框选 + 缩略图带 UI + 视觉能力错误兜底 + 图片不落盘)
```

- §4 代码地图 `main/` 下加 `media/`(imageResize/imagePrep/screenCapture);`renderer/` 加 regionOverlay;§7 记一条本期遗留(见 Step 4)。

- [ ] **Step 4: 记录已知遗留到 `PROGRESS.md` §7**

```markdown
- **MVP-07** 多模态识图遗留 Minor:截屏框选限当前显示器(多显示器 deferred);`prepareImage`/`screenCapture` 为 native 封装无单测(靠真机);拖粘图在渲染层用 canvas 降采样为 JPEG(丢弃透明通道,识图无碍);宠物"自主截屏工具"未实现(留给后续浏览器自动化,管线已预留复用点);截屏时对话框窗口未自动隐藏,可能一并被截入(低概率,可后续优化)。
```

- [ ] **Step 5: 更新 `README.md` 隐私/权限告知**

在隐私相关小节加一句:

```markdown
- **截屏识图**:使用「框选截屏」时,应用会抓取当前屏幕画面用于框选并发送所选区域给你配置的视觉模型端点;图片仅本次发送使用,**不写入本地记忆/历史**(仅存 `[图片]` 文本占位)。是否发往在线模型取决于你选的 Provider。
```

- [ ] **Step 6: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs(vision): MVP-07 多模态识图进度、遗留与截屏隐私告知"
```

---

## 自检对照(Spec 覆盖)

- Spec §2.1 图像类型 → Task 1;§2.2 两 Provider 序列化 → Task 3;§2.3 imagePrep → Task 2。
- Spec §3.1 选文件 → Task 6;§3.2 拖拽/粘贴 → Task 8;§3.3 截屏框选 → Task 7。
- Spec §4.1 缩略图带 UI → Task 8;§4.2 视觉错误兜底 → Task 4;§4.3 持久化(图不落盘)→ Task 5;§4.4 IPC 加固 → Task 1;§4.5 四文件同步 → Task 1/6/7/8。
- Spec §6 为自主截屏预留 → screenCapture 抓屏与覆盖层解耦(Task 7)、`ChatTurn.images` 通用(Task 1)。
- Spec §8 测试:纯逻辑 TDD(Task 1/2/3/4/5)+ 真机清单(Task 9 Step 2)。
```
