# 对话框瘦身 + 展开态双栏聊天 + 宠物热切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉折叠对话框输入胶囊上方的空白冗余;把展开态改成 MomoTalk 双栏(左侧宠物列表 + 右侧聊天),点头像即可热切换宠物(精灵/人设/记忆/语音整束切换、聊天历史与时间戳随之切换、持久化为新的默认宠物)。

**Architecture:** 把 `startShell()` 里绑死单个 `petDir` 的所有"宠物作用域件"(memory / chat / persona / appFocusWatcher / controlIndicator / voice)抽成可重建的 `createPetSession(petId)` 工厂;startShell 持 `let session`,`switchPet(petId)` 用"先建后弃"换会话并让 petWin 热重载精灵。折叠态高度改由渲染层测量上报(复用 bubble 的 measure→resize 机制)。

**Tech Stack:** Electron(CJS 主进程/preload)· TypeScript(strict)· electron-vite · Vitest · 无新增运行时依赖(头像裁剪用 Electron 内置 `nativeImage`)。

## Global Constraints

- 包管理器是 **pnpm**;**绝不**给 `package.json` 加 `"type": "module"`(会让 CJS 主进程崩)。
- 跨进程值一律走 `src/shared` + `@shared/*` 别名;IPC 通道名只用 `IPC` 常量,新增能力**四文件 lockstep**:`src/shared/ipc.ts`(常量 + 类型)、`src/main/shell/index.ts`(处理器)、`src/preload/index.ts`(暴露)、渲染层调用方。
- 安全基线不动:`contextIsolation:true, sandbox:true, nodeIntegration:false`,渲染层零文件访问(图像/头像都由主进程或既有 data URL 通道提供)。
- **TDD**:纯逻辑先写失败的 Vitest;GUI/Electron 接线用 `pnpm build && pnpm preview` 真机确认(`typecheck`/`test`/`build` 通过 ≠ 窗口能渲染)。
- 提交:小步、Chinese conventional-commit(`feat(dialog): …` / `refactor(shell): …`)。
- 命令:`pnpm typecheck` / `pnpm test` / `pnpm vitest run <file>` / `pnpm build` / `pnpm preview`。
- **同一时刻桌面只有一只宠物**(非同屏多宠物);列表**不做**未读红点/排序下拉(非目标)。
- 换宠物持久化到 `settings.activePetId`(下次启动即这只);待办是全局数据,不随宠物走。

---

# Phase 1 — 折叠态瘦身(独立可交付)

## Task 1: `validateCollapsedHeight` 校验(纯逻辑)

**Files:**
- Modify: `src/shared/ipcValidation.ts`(末尾追加,仿 `validateBubbleHeight`)
- Test: `src/shared/ipcValidation.test.ts`(末尾追加 describe 块)

**Interfaces:**
- Produces: `validateCollapsedHeight(v: unknown): number | null` —— 合法有限数、范围 `[0, 400]` 内返回该数,否则 `null`。

- [ ] **Step 1: 写失败测试**(追加到 `src/shared/ipcValidation.test.ts` 末尾)

```ts
describe('validateCollapsedHeight', () => {
  it('接受合法有限非负数', () => {
    expect(validateCollapsedHeight(52)).toBe(52)
    expect(validateCollapsedHeight(0)).toBe(0)
    expect(validateCollapsedHeight(400)).toBe(400)
  })
  it('拒绝负数/NaN/Infinity/超上限/非数字', () => {
    expect(validateCollapsedHeight(-1)).toBeNull()
    expect(validateCollapsedHeight(NaN)).toBeNull()
    expect(validateCollapsedHeight(Infinity)).toBeNull()
    expect(validateCollapsedHeight(401)).toBeNull()
    expect(validateCollapsedHeight('52')).toBeNull()
    expect(validateCollapsedHeight(null)).toBeNull()
  })
})
```

同时把 `validateCollapsedHeight` 加进该测试文件顶部的 import 列表(与 `validateBubbleHeight` 并列)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL —— `validateCollapsedHeight is not a function`。

- [ ] **Step 3: 实现**(追加到 `src/shared/ipcValidation.ts` 末尾)

```ts
export function validateCollapsedHeight(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 400 ? v : null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts
git commit -m "feat(dialog): 折叠态高度上报校验 validateCollapsedHeight"
```

---

## Task 2: 折叠态瘦身接线(IPC + 窗口 + CSS + 渲染层测量)

**Files:**
- Modify: `src/shared/ipc.ts`(加常量 `DIALOG_REPORT_COLLAPSED_HEIGHT` + `ChatApi.reportCollapsedHeight`)
- Modify: `src/preload/index.ts`(chatApi 暴露 `reportCollapsedHeight`)
- Modify: `src/main/shell/dialogWindow.ts`(`COLLAPSED` 高度收小 + 新增 `setCollapsedHeight`)
- Modify: `src/main/shell/index.ts`(注册 `DIALOG_REPORT_COLLAPSED_HEIGHT` 处理器)
- Modify: `src/renderer/dialog.html`(折叠态 `#panel` 透明、height:auto)
- Modify: `src/renderer/dialog.ts`(测量并上报折叠高度)

**Interfaces:**
- Consumes: `validateCollapsedHeight`(Task 1)。
- Produces: `ChatApi.reportCollapsedHeight(height: number): void`;`DialogController.setCollapsedHeight(height: number): void`。

- [ ] **Step 1: 加 IPC 常量与类型**

`src/shared/ipc.ts` —— 在 `IPC` 对象里 `DIALOG_SET_SIZE` 附近加一行:

```ts
  DIALOG_REPORT_COLLAPSED_HEIGHT: 'dialog:report-collapsed-height',
```

在 `ChatApi` 接口里(`setSize` 附近)加:

```ts
  /** 折叠态渲染层测量到内容自然高度后上报,主进程夹取范围后重设折叠窗口高度 */
  reportCollapsedHeight(height: number): void
```

- [ ] **Step 2: preload 暴露**

`src/preload/index.ts` —— 在 `chatApi` 对象里(`setSize` 之后)加:

```ts
  reportCollapsedHeight: (height: number): void => ipcRenderer.send(IPC.DIALOG_REPORT_COLLAPSED_HEIGHT, height),
```

- [ ] **Step 3: 主进程窗口——收小 COLLAPSED + 新增 setCollapsedHeight**

`src/main/shell/dialogWindow.ts`:

把顶部常量改为(高度作为"到达上报前的临时保守初值",宽度不变):

```ts
const COLLAPSED = { width: 320, height: 56 }
const EXPANDED = { width: 520, height: 470 }
const COLLAPSED_MIN = 44
const COLLAPSED_MAX = 400
```

在 `DialogController` 接口里加:

```ts
  setCollapsedHeight(height: number): void
```

在返回对象里(`setSize` 之后)加实现(复用既有 resizable 绕过法):

```ts
    setCollapsedHeight(height: number): void {
      if (!win || !collapsed) return // 仅折叠态生效;展开态忽略上报
      const h = Math.max(COLLAPSED_MIN, Math.min(Math.round(height), COLLAPSED_MAX))
      const wasResizable = win.isResizable()
      if (!wasResizable) win.setResizable(true)
      win.setSize(COLLAPSED.width, h)
      if (!wasResizable) win.setResizable(false)
    },
```

> `EXPANDED` 从 `320×470` 改成 `520×470` 是 Phase 2 双栏要用的宽度;Phase 1 先改无害(折叠态不受影响,展开态本 Task 暂时还是单栏、只是更宽,Phase 2 才填左栏)。

- [ ] **Step 4: 主进程注册上报处理器**

`src/main/shell/index.ts`:

import 追加 `validateCollapsedHeight`(与既有 `validateBubbleHeight` 并列):

```ts
  validateReactionCategory, validateBubbleHeight, validateCollapsedHeight
```

在 `IPC.DIALOG_SET_SIZE` 处理器附近加:

```ts
  ipcMain.on(IPC.DIALOG_REPORT_COLLAPSED_HEIGHT, (_e, raw) => {
    const h = validateCollapsedHeight(raw)
    if (h === null) return
    dialog.setCollapsedHeight(h)
  })
```

- [ ] **Step 5: 渲染层 CSS——折叠态去容器**

`src/renderer/dialog.html`:在 `<style>` 里 `#panel` 规则之后,加折叠态覆盖(去底色/阴影,高度贴合内容,让上方不再有空矩形):

```css
      /* 折叠态:去掉整块容器外观,只留输入胶囊自身;高度贴合内容(交给渲染层测量上报) */
      #panel.collapsed { height: auto; background: transparent; box-shadow: none; }
```

(`#panel` 基础规则里的 `height:100%` 保留,展开态仍需要它撑满窗口让 `#history` 内部滚动。)

- [ ] **Step 6: 渲染层测量并上报**

`src/renderer/dialog.ts`:

加一个测量上报函数(放在 `setCollapsed` 定义之前):

```ts
function reportCollapsedHeight(): void {
  if (!collapsed) return
  // 折叠态 #panel 为 height:auto,getBoundingClientRect().height 即内容自然高度
  requestAnimationFrame(() => {
    if (!collapsed) return
    const h = Math.ceil(panel.getBoundingClientRect().height)
    window.chatApi.reportCollapsedHeight(h)
  })
}
```

在这些位置调用它:
1. `setCollapsed(c)` 末尾(切到折叠态时上报一次):

```ts
function setCollapsed(c: boolean): void {
  collapsed = c
  panel.classList.toggle('collapsed', c)
  panel.classList.toggle('expanded', !c)
  toggleBtn.textContent = c ? '⤢' : '⤡'
  toggleBtn.title = c ? '展开' : '收起'
  window.chatApi.setSize(c)
  reportCollapsedHeight()
}
```

2. `renderPending()` 末尾(附件缩略图带增删会改变折叠高度):在函数最后一行后加 `reportCollapsedHeight()`。
3. 输入框 `input` 事件里(textarea 自增高会改变胶囊高度):在既有 `input.addEventListener('input', …)` 回调末尾加 `reportCollapsedHeight()`。
4. 既有 `visibilitychange` 回调里,`window.chatApi.setSize(collapsed)` 之后加 `reportCollapsedHeight()`。

- [ ] **Step 7: 构建 + 真机确认**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿(测试数不减)。

Run: `pnpm preview`
真机确认:
- 折叠态只剩那颗输入胶囊,**上方没有空的圆角矩形**;
- 点 ＋ 选一张图 → 缩略图带出现、窗口按需长高;移除图 → 缩回;
- 展开再折叠,能正确缩回小胶囊(不卡在大尺寸);
- 多行输入(Shift+Enter)时胶囊长高、窗口跟着长高。

- [ ] **Step 8: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/dialogWindow.ts src/main/shell/index.ts src/renderer/dialog.html src/renderer/dialog.ts
git commit -m "feat(dialog): 折叠态去掉输入胶囊上方空白冗余,高度随内容自适应"
```

---

# Phase 2 — 展开双栏 + 宠物热切换

## Task 3: 抽出 `PetSession`(行为保持的重构)

把 `startShell()` 里所有宠物作用域件抽进 `createPetSession(petId, deps)`。**本 Task 不引入任何新用户功能**:仍是单只宠物,不能切换;目标是重构后 `pnpm preview` 行为与之前**完全一致**(宠物加载、聊天、语音、appFocus、桌面控制指示器均正常)。

**Files:**
- Create: `src/main/shell/petSession.ts`
- Modify: `src/main/shell/index.ts`(把宠物件构造搬进工厂;持 `let session`;闭包改引用 `session.*`)

**Interfaces:**
- Produces:
```ts
export interface PetSession {
  petId: string
  petDir: string
  memoryDir: string
  memory: MemoryManager
  chat: ChatStore
  messages(): ChatMessage[]
  startVoice(): void
  dispose(): Promise<void>
}
export function createPetSession(petId: string, deps: PetSessionDeps): PetSession
```

- [ ] **Step 1: 建 `petSession.ts` 骨架 + 依赖类型**

`src/main/shell/petSession.ts`:

```ts
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ChatMessage } from '@shared/ipc'
import type { AppSettings } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { ensurePetHome } from '../pets/petHome'
import { createMemoryManager, type MemoryManager } from '../memory/memoryManager'
import { createChatStore, type ChatStore } from './chat'
import { startAppFocusWatcher } from '../context/appFocusWatcher'
import { loadPersona } from '../persona/personaLoader'
import { generateContextualLine } from '../context/contextualLineGenerator'
import { loadPet } from '../petLoader'
import type { Embedder } from '../providers/embedder'
import type { SkillIndex } from '../skills/skillLoader'
import type { TodoStore } from '../todos/todoStore'
import type { ToolSpec } from '../tools/toolSpec'
import type { ChatSendAttachment } from '@shared/ipc'
import type { ImagePart } from '@shared/llm'

export interface PetSessionDeps {
  userData: string
  bundledPetsDir: string
  legacyMemoryDir: string
  defaultPetId: string
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  getFirecrawlKey: () => string | null
  getEmbedder: () => Embedder | null
  skills: SkillIndex
  todoStore: TodoStore
  petWin: BrowserWindow
  // appFocusWatcher(PowerShell 前台窗口检测)+ 语音翻译共用
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
  createProvider: (p: import('@shared/llm').ProviderSettings, key: string) => import('../providers/llmProvider').LlmProvider
  // 全局自动化件(跨会话共享,由 startShell 建一次)
  buildDesktopTools: () => ToolSpec[]
  wrapDesktopTools: (tools: ToolSpec[]) => ToolSpec[]
  beginDesktopControlTurn: () => number
  endDesktopControlTurn: (token: number) => void
  buildBrowserTools: () => ToolSpec[]
  prepareImages: (a: ChatSendAttachment[]) => ImagePart[]
  clipboard: { readText: () => string; writeText: (t: string) => void }
  // 渲染层推送回调(startShell 里已有的那几个)
  emitPetEvent: (e: PetEvent) => void
  pushUpdate: (m: ChatMessage[]) => void
  pushStream: (t: string) => void
  pushStatus: (t: string) => void
  pushDone: () => void
  pushError: (m: string) => void
  openSettings: () => void
  // appFocus 情境信号推送(命中时)
  onAppFocusMatch: (lineText: string) => void
  // 语音接线所需(见 Step 3)
  voiceDeps: VoiceSessionDeps
}
```

`VoiceSessionDeps` 在 Step 3 定义。

- [ ] **Step 2: 工厂主体——memory / chat / appFocusWatcher / controlIndicator**

在 `petSession.ts` 里实现工厂(语音留到 Step 3 填 `startVoice`/`dispose` 的语音部分):

```ts
export function createPetSession(petId: string, deps: PetSessionDeps): PetSession {
  const { petHome, memoryDir } = ensurePetHome({
    userDataDir: deps.userData,
    bundledPetsDir: deps.bundledPetsDir,
    activePetId: petId,
    // 旧全局 memory 只在默认宠物首次落地时迁移(与 resolvePetHome 口径一致)
    legacyMemoryDir: petId === deps.defaultPetId ? deps.legacyMemoryDir : undefined
  })
  const petDir = petHome

  const memory = createMemoryManager({ dir: memoryDir, getEmbedder: deps.getEmbedder })

  const chat = createChatStore({
    petDir,
    skills: deps.skills,
    memory,
    todoStore: deps.todoStore,
    loadSettings: deps.loadSettings,
    getKey: deps.getKey,
    getSearchKey: deps.getSearchKey,
    getFirecrawlKey: deps.getFirecrawlKey,
    buildDesktopTools: deps.buildDesktopTools,
    wrapDesktopTools: deps.wrapDesktopTools,
    beginDesktopControlTurn: deps.beginDesktopControlTurn,
    endDesktopControlTurn: deps.endDesktopControlTurn,
    buildBrowserTools: deps.buildBrowserTools,
    prepareImages: deps.prepareImages,
    clipboard: deps.clipboard,
    emitPetEvent: deps.emitPetEvent,
    pushUpdate: deps.pushUpdate,
    pushStream: deps.pushStream,
    pushStatus: deps.pushStatus,
    pushDone: deps.pushDone,
    pushError: deps.pushError,
    openSettings: deps.openSettings,
    voice: makeVoiceFacade() // Step 3 定义,读本会话的 speechSequencer
  })

  const appFocusWatcher = startAppFocusWatcher(petDir, {
    execFile: deps.execFile,
    onMatch: (line) => deps.onAppFocusMatch(line.text),
    generateOpener: async ({ processName, windowTitle }) => {
      const s = deps.loadSettings()
      if (!s.appFocusLlmOpener.enabled) return null
      const key = deps.getKey()
      if (!key) return null
      const persona = loadPersona(petDir)
      const provider = deps.createProvider(s.provider, key)
      return generateContextualLine({ personaText: persona.persona, processName, windowTitle, provider })
    }
  })

  // ...语音成员(voiceProviderInstance/speechSequencerInstance/voiceSidecarInstance +
  //    startVoice/stopVoice/makeVoiceFacade)见 Step 3,定义在此处、被下面 return 引用...

  return {
    petId, petDir, memoryDir, memory, chat,
    messages: () => memory.messages(),
    startVoice, // Step 3 定义
    async dispose() {
      try { chat.cancel() } catch (e) { console.warn('[petSession] chat.cancel', e) }
      try { appFocusWatcher.stop() } catch (e) { console.warn('[petSession] appFocus.stop', e) }
      try { await stopVoice() } catch (e) { console.warn('[petSession] stopVoice', e) } // Step 3 定义
    }
  }
}
```

> **controlIndicator 不进会话**:它现状是 startShell 里的全局单例,被 `indicatorGate` 的 show/hide 闭包引用。本计划让它**保持全局**(避免改动 indicatorGate),`createPetSession` 不构造它、`PetSession` 接口不含它。已知小瑕疵:切换后指示器显示名停留在初始宠物名——桌面控制默认关闭,优先级低,不在本计划范围内修。`import { createControlIndicator }` 也不需要出现在 `petSession.ts`(Step 1 的 import 列表里删掉它)。

- [ ] **Step 3: 语音搬进会话**

把 `index.ts` 现有的 `startVoiceIfConfigured`(约 426–511 行)、`createProviderForVoice`(约 513–517 行)、三个模块级 `let voiceProviderInstance/speechSequencerInstance/voiceSidecarInstance`(约 422–424 行)整体**搬进** `createPetSession`,做如下替换:
- `petDir` → 本会话的 `petDir`;
- 三个 `let …Instance` → 会话内局部变量;
- `loadSettings(settingsFile)` → `deps.loadSettings()`;
- `secrets.getKey()` → `deps.getKey()`;
- `petWin.webContents.send(...)` → `deps.petWin.webContents.send(...)`;
- 依赖的 `getVoiceRuntimeState`/`getGenieRuntimeState`/`realSpawnProcess`/`realSpawnGenieProcess`/`realPostSse`/`createProvider`/端口常量/脚本路径,全部经 `deps.voiceDeps` 注入。

在 `petSession.ts` 顶部定义(`ProviderSettings`/`LlmProvider` 已由 Step 1 接口的内联 import 覆盖,这里不再单独 import):

```ts
import { createVoiceSidecar } from '../voice/voiceSidecar'
import { createVoiceProvider } from '../voice/voiceProvider'
import { createSpeechSequencer } from '../voice/speechSequencer'
import { createLlmTranslator } from '../voice/translate'
import type { VoiceRuntimeState, GenieRuntimeState } from '@shared/ipc'

export interface VoiceSessionDeps {
  getVoiceRuntimeState: () => VoiceRuntimeState
  getGenieRuntimeState: () => GenieRuntimeState
  resolveVoiceBackend: (petVoice: import('@shared/petPackage').PetVoice, selected: import('@shared/llm').TtsBackend) => 'gsv-tts-lite' | 'genie-tts' | null
  ports: { gsv: number; genie: number }
  scriptPaths: { gsv: string; genie: string }
  spawnGsv: typeof import('../voice/realVoiceTransport').realSpawnProcess
  spawnGenie: typeof import('../voice/realVoiceTransport').realSpawnGenieProcess
  postSse: typeof import('../voice/realVoiceTransport').realPostSse
  onAudioChunk: (c: import('@shared/ipc').VoicePcmChunk) => void
  onAudioError: (m: string) => void
}
```

在工厂内实现语音三件(`startVoice`/`stopVoice`/`makeVoiceFacade`),把搬来的 `startVoiceIfConfigured` 体作为 `startVoice` 的实现(去掉原来的 `void` 自调,改为方法);`makeVoiceFacade()` 返回:

```ts
function makeVoiceFacade() {
  return {
    getSettings: () => deps.loadSettings().tts,
    speak: (text: string) => speechSequencerInstance?.speak(text),
    stop: () => speechSequencerInstance?.stop()
  }
}
async function stopVoice(): Promise<void> {
  speechSequencerInstance?.stop()
  await voiceSidecarInstance?.stop()
  voiceSidecarInstance = null
  speechSequencerInstance = null
  voiceProviderInstance = null
}
```

> 语音 sidecar 端口固定(gsv 8850 / genie 8851),换宠物必须**先 dispose 旧的释放端口、再 startVoice 新的**——所以 `startVoice` 与工厂构造分离、由调用方显式触发(见 Task 7)。

- [ ] **Step 4: startShell 改用会话**

`src/main/shell/index.ts`:
1. 在 `resolvePetHome` 得到 `petHome/memoryDir` 之后,**删掉**这些内联构造并改由会话持有:`const memory = createMemoryManager(...)`、`const chat = createChatStore({...})`、`startVoiceIfConfigured`/`createProviderForVoice`/三个 `voice*Instance`、`startAppFocusWatcher(...)` 调用。**保留**在 startShell 的全局件:`petWin`/`dialog`/`bubble`/`settings`/`todoWin`、`todoStore`、secrets、`skills`、`automationControl`/`automationWithTracking`/`lastAiPos`/`indicatorGate`/`controlIndicator`、`browserControl`、`getEmbedder`、scheduler、hotkeys、tray、以及 `getVoiceRuntimeState`/`getGenieRuntimeState`/所有 voice/genie 安装类 IPC 处理器(它们是 settings/install 作用域,不随宠物)。

2. controlIndicator 保持全局:现状 `createControlIndicator` 在 `loadPet(petDir).then(...)` 里建;改成 `loadPet(session.petDir)`。indicatorGate 的 show/hide 继续引用这个全局 `controlIndicator`,不变。

3. 组装 `sessionDeps: PetSessionDeps` 并建初始会话:

```ts
const sessionDeps: PetSessionDeps = {
  userData, bundledPetsDir: petCatalogDirs.bundledPetsDir, legacyMemoryDir,
  defaultPetId,
  loadSettings: () => loadSettings(settingsFile),
  getKey: () => secrets.getKey(),
  getSearchKey: () => searchSecrets.getKey(),
  getFirecrawlKey: () => firecrawlSecrets.getKey(),
  getEmbedder,
  skills, todoStore, petWin,
  execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
  createProvider,
  buildDesktopTools: () => createDesktopTools({
    platform: process.platform,
    automation: automationWithTracking,
    screenshotState: createScreenshotState(),
    captureScreen: () => captureFullScreen(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  }),
  wrapDesktopTools: (tools) => wrapToolsWithGate(tools, indicatorGate),
  beginDesktopControlTurn: () => indicatorGate.beginTurn(),
  endDesktopControlTurn: (token) => indicatorGate.endTurn(token),
  buildBrowserTools: () => createBrowserTools({ control: browserControl }),
  prepareImages: (atts) => atts.map((a) => prepareImage(a)),
  clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
  emitPetEvent,
  pushUpdate: (msgs) => dialog.pushUpdate(msgs),
  pushStream: (t) => { dialog.window()?.webContents.send(IPC.CHAT_STREAM, t); bubbleHasContent = true; refreshBubble(); bubble.pushStream(t) },
  pushStatus: (t) => { dialog.window()?.webContents.send(IPC.CHAT_STATUS, t); bubbleHasContent = true; refreshBubble(); bubble.pushStatus(t) },
  pushDone: () => { dialog.window()?.webContents.send(IPC.CHAT_DONE); bubble.pushDone() },
  pushError: (m) => { dialog.window()?.webContents.send(IPC.CHAT_ERROR, m); bubbleHasContent = true; refreshBubble(); bubble.pushError(m) },
  openSettings: () => openSettings(),
  onAppFocusMatch: (lineText) => {
    if (dialog.isOpen()) return
    pendingAppFocusText = lineText
    petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')
  },
  voiceDeps: {
    getVoiceRuntimeState, getGenieRuntimeState, resolveVoiceBackend,
    ports: { gsv: VOICE_PORT, genie: GENIE_VOICE_PORT },
    scriptPaths: { gsv: voiceScriptPath, genie: genieScriptPath },
    spawnGsv: realSpawnProcess, spawnGenie: realSpawnGenieProcess, postSse: realPostSse,
    onAudioChunk: (c) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
    onAudioError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
  }
}

let session = createPetSession(configuredPetId, sessionDeps)
session.startVoice()
```

> 注:`buildDesktopTools` 里的 `createScreenshotState()`/`captureFullScreen(...)` 等照抄现状即可(它们不依赖 petDir)。

4. 全局把内联 `chat`/`memory`/`memoryDir`/`petDir` 的引用改成 `session.*`:
   - `ipcMain.on(IPC.CHAT_SEND …)` → `session.chat.handleSend(payload)`
   - `ipcMain.on(IPC.CANCEL_CHAT …)` → `session.chat.cancel()`
   - `dialog.onOpened` 里 `dialog.pushUpdate(chat.messages())` → `session.messages()`
   - `indicatorGate` 的 `onOverride: () => { chat.cancel() }` → `session.chat.cancel()`
   - tray `onQuickAction` → `session.chat.runQuickAction(id)`
   - `ipcMain.handle(IPC.GET_PET …)` → `loadPet(session.petDir)`
   - `ipcMain.handle(IPC.GET_SETTINGS …)` 里 `loadPet(petDir)` → `loadPet(session.petDir)`
   - `ipcMain.on(IPC.OPEN_MEMORY_DIR …)` 里 `memoryDir` → `session.memoryDir`
   - `loadPet(petDir).then(... createControlIndicator ...)` → `loadPet(session.petDir)`(controlIndicator 仍全局构造,只是读 `session.petDir`)
   - `app.on('will-quit', …)`:**删掉**已随会话搬走的 `appFocusWatcher.stop()` 与 `voiceSidecarInstance?.stop()`,改为 `void session.dispose()`;其余(`unregisterHotkeys()`/`scheduler.stop()`/`idleWatcher.stop()`/`void browserControl.close()`)保留。即:
     ```ts
     app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close(); void session.dispose() })
     ```

- [ ] **Step 5: typecheck + 测试 + 真机行为一致性确认**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿(测试数不减;本 Task 不加新测,是重构)。

Run: `pnpm preview`
真机确认(**与重构前一致**):宠物正常加载播 idle;开对话框能发消息、流式回复;折叠气泡正常;(若已配 key/语音)语音正常;桌面控制指示器开关正常。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/petSession.ts src/main/shell/index.ts
git commit -m "refactor(shell): 抽出 createPetSession 会话工厂(宠物作用域件可重建,行为不变)"
```

---

## Task 4: Phase-2 IPC 契约 + 类型 + preload

**Files:**
- Modify: `src/shared/ipc.ts`(常量 + 类型 + `ChatApi`/`PetApi` 追加)
- Modify: `src/shared/ipcValidation.ts`(加 `validatePetId`)
- Modify: `src/shared/ipcValidation.test.ts`(测 `validatePetId`)
- Modify: `src/preload/index.ts`(chatApi/petApi 暴露新方法)

**Interfaces:**
- Produces:
```ts
export interface PetChatListItem { id: string; displayName: string; avatarDataUrl: string; lastMessage?: string; lastMessageTime?: number; active: boolean }
export interface PetSwitchedPayload { petId: string; displayName: string }
// ChatApi: listPetsForChat(): Promise<PetChatListItem[]>; switchPet(id): Promise<boolean>; onSwitched(cb)
// PetApi:  onPetChanged(cb: () => void): void
// validatePetId(v: unknown): string | null
```

- [ ] **Step 1: 写 `validatePetId` 失败测试**(追加到 `ipcValidation.test.ts`)

```ts
describe('validatePetId', () => {
  it('接受合法 id(字母数字下划线连字符)', () => {
    expect(validatePetId('luluka')).toBe('luluka')
    expect(validatePetId('pet_01-a')).toBe('pet_01-a')
  })
  it('拒绝空/含分隔符/路径穿越/非字符串', () => {
    expect(validatePetId('')).toBeNull()
    expect(validatePetId('a/b')).toBeNull()
    expect(validatePetId('../x')).toBeNull()
    expect(validatePetId('a.b')).toBeNull()
    expect(validatePetId(123)).toBeNull()
  })
})
```

顶部 import 加入 `validatePetId`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL —— `validatePetId is not a function`。

- [ ] **Step 3: 实现 `validatePetId`**(`ipcValidation.ts` 末尾)

```ts
export function validatePetId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) ? v : null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: PASS。

- [ ] **Step 5: 加 IPC 常量 + 类型**

`src/shared/ipc.ts` —— `IPC` 对象里加:

```ts
  CHAT_LIST_PETS: 'chat:list-pets',
  SWITCH_PET: 'chat:switch-pet',
  PET_SWITCHED: 'chat:pet-switched',
  PET_CHANGED: 'pet:changed',
```

类型区(`PetSummary` 附近)加:

```ts
export interface PetChatListItem {
  id: string
  displayName: string
  avatarDataUrl: string        // 主进程裁好的小头像;裁不出为 '',渲染层退回色块占位
  lastMessage?: string
  lastMessageTime?: number
  active: boolean
}
export interface PetSwitchedPayload { petId: string; displayName: string }
```

`ChatApi` 追加(注意与 `SettingsApi.listPets` 区分命名):

```ts
  /** 展开态左栏用:头像 + 名字 + 末条消息预览 + 活跃标记(与 SettingsApi.listPets 返回形不同,专供聊天面板) */
  listPetsForChat(): Promise<PetChatListItem[]>
  /** 点头像热切换宠物;返回是否切换成功 */
  switchPet(id: string): Promise<boolean>
  /** 切换完成后主进程通知,渲染层据此刷新右栏头部 + 左栏高亮 */
  onSwitched(cb: (p: PetSwitchedPayload) => void): void
```

`PetApi` 追加:

```ts
  /** 主进程通知宠物已换,渲染层重载精灵(重新 getPet + 重建 SpritePlayer) */
  onPetChanged(cb: () => void): void
```

- [ ] **Step 6: preload 暴露**

`src/preload/index.ts`:

`chatApi` 里加:

```ts
  listPetsForChat: (): Promise<PetChatListItem[]> => ipcRenderer.invoke(IPC.CHAT_LIST_PETS),
  switchPet: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.SWITCH_PET, id),
  onSwitched: (cb: (p: PetSwitchedPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_SWITCHED)
    ipcRenderer.on(IPC.PET_SWITCHED, (_e, p: PetSwitchedPayload) => cb(p))
  },
```

`petApi` 里加:

```ts
  onPetChanged: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_CHANGED)
    ipcRenderer.on(IPC.PET_CHANGED, () => cb())
  },
```

顶部 import 从 `@shared/ipc` 补上 `PetChatListItem`、`PetSwitchedPayload` 类型。

- [ ] **Step 7: typecheck**

Run: `pnpm typecheck && pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: typecheck 全绿;测试 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts src/preload/index.ts
git commit -m "feat(dialog): 宠物列表/热切换 IPC 契约 + validatePetId"
```

---

## Task 5: `petChatList` 纯逻辑(预览截断 + 列表组装)

**Files:**
- Create: `src/main/pets/petChatList.ts`
- Test: `src/main/pets/petChatList.test.ts`

**Interfaces:**
- Consumes: `PetChatListItem`(Task 4)、`ChatMessage`、`PetSummary`。
- Produces:
```ts
export function previewOf(msg: ChatMessage | undefined): string | undefined
export interface PetChatListInput {
  pets: PetSummary[]; activeId: string; activeMessages: ChatMessage[]
  peekLast: (petId: string) => ChatMessage | undefined
  avatarOf: (petId: string) => string
}
export function buildPetChatList(input: PetChatListInput): PetChatListItem[]
```

- [ ] **Step 1: 写失败测试**

`src/main/pets/petChatList.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { previewOf, buildPetChatList } from './petChatList'
import type { ChatMessage, PetSummary } from '@shared/ipc'

describe('previewOf', () => {
  it('无消息返回 undefined', () => { expect(previewOf(undefined)).toBeUndefined() })
  it('折叠空白、去首尾空格', () => {
    expect(previewOf({ role: 'pet', text: '  你好\n  世界  ' })).toBe('你好 世界')
  })
  it('超长截断加省略号(20 字上限)', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三'
    expect(previewOf({ role: 'user', text: long })).toBe(long.slice(0, 20) + '…')
  })
  it('纯空白返回 undefined', () => { expect(previewOf({ role: 'pet', text: '   ' })).toBeUndefined() })
})

describe('buildPetChatList', () => {
  const pets: PetSummary[] = [
    { id: 'a', displayName: 'Alpha', description: '' },
    { id: 'b', displayName: 'Bravo', description: '' }
  ]
  it('活跃宠物用 activeMessages 末条,非活跃用 peekLast,active 标记正确', () => {
    const activeMessages: ChatMessage[] = [
      { role: 'user', text: 'hi', timestamp: 100 },
      { role: 'pet', text: '在的', timestamp: 200 }
    ]
    const peekLast = (id: string): ChatMessage | undefined =>
      id === 'b' ? { role: 'pet', text: '好久不见', timestamp: 50 } : undefined
    const avatarOf = (id: string): string => (id === 'a' ? 'data:img-a' : '')
    const out = buildPetChatList({ pets, activeId: 'a', activeMessages, peekLast, avatarOf })
    expect(out).toEqual([
      { id: 'a', displayName: 'Alpha', avatarDataUrl: 'data:img-a', lastMessage: '在的', lastMessageTime: 200, active: true },
      { id: 'b', displayName: 'Bravo', avatarDataUrl: '', lastMessage: '好久不见', lastMessageTime: 50, active: false }
    ])
  })
  it('无历史的宠物 lastMessage/lastMessageTime 为 undefined', () => {
    const out = buildPetChatList({ pets, activeId: 'a', activeMessages: [], peekLast: () => undefined, avatarOf: () => '' })
    expect(out[0].lastMessage).toBeUndefined()
    expect(out[0].lastMessageTime).toBeUndefined()
    expect(out[1].active).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/pets/petChatList.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/main/pets/petChatList.ts`:

```ts
import type { ChatMessage, PetSummary, PetChatListItem } from '@shared/ipc'

const PREVIEW_MAX = 20

export function previewOf(msg: ChatMessage | undefined): string | undefined {
  if (!msg) return undefined
  const t = msg.text.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t
}

export interface PetChatListInput {
  pets: PetSummary[]
  activeId: string
  activeMessages: ChatMessage[]
  peekLast: (petId: string) => ChatMessage | undefined
  avatarOf: (petId: string) => string
}

export function buildPetChatList(input: PetChatListInput): PetChatListItem[] {
  return input.pets.map((p) => {
    const last = p.id === input.activeId
      ? input.activeMessages[input.activeMessages.length - 1]
      : input.peekLast(p.id)
    const item: PetChatListItem = {
      id: p.id,
      displayName: p.displayName,
      avatarDataUrl: input.avatarOf(p.id),
      active: p.id === input.activeId
    }
    const preview = previewOf(last)
    if (preview !== undefined) { item.lastMessage = preview; item.lastMessageTime = last?.timestamp }
    return item
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/pets/petChatList.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/pets/petChatList.ts src/main/pets/petChatList.test.ts
git commit -m "feat(dialog): 宠物列表纯逻辑(previewOf 预览截断 + buildPetChatList 组装)"
```

---

## Task 6: `CHAT_LIST_PETS` 处理器(头像裁剪 + 末条 peek + 缓存)

**Files:**
- Create: `src/main/pets/petAvatar.ts`(nativeImage 裁头像 + mtime 缓存;import electron,无单测)
- Modify: `src/main/shell/index.ts`(注册 `CHAT_LIST_PETS`)

**Interfaces:**
- Consumes: `buildPetChatList`/`previewOf`(Task 5)、`listPets`、`loadTranscript`、`frameRect`、`parsePetManifest`。
- Produces: `createPetAvatarCache(): { avatarOf(petDir, petId): string }`;`resolvePetDir(petId, dirs): string`。

- [ ] **Step 1: 建 `petAvatar.ts`**

`src/main/pets/petAvatar.ts`:

```ts
import { nativeImage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { frameRect, parsePetManifest } from '@shared/petPackage'

const AVATAR_PX = 48

/** userData 包优先(与 listPets 去重口径一致),否则内置只读包。 */
export function resolvePetDir(petId: string, dirs: { bundledPetsDir: string; userPetsDir: string }): string {
  const userDir = join(dirs.userPetsDir, petId)
  return existsSync(join(userDir, 'pet.json')) ? userDir : join(dirs.bundledPetsDir, petId)
}

/** 从宠物 spritesheet 裁 idle 首帧成小圆头像的 data URL;按 spritesheet mtime 缓存。
 *  webp 解码失败(某些平台 nativeImage 不支持)或缺 idle 动画 → 返回 ''(渲染层退回色块占位)。 */
export function createPetAvatarCache(): { avatarOf: (petDir: string, petId: string) => string } {
  const cache = new Map<string, { mtimeMs: number; url: string }>()
  return {
    avatarOf(petDir, petId) {
      try {
        const manifestPath = join(petDir, 'pet.json')
        const manifest = parsePetManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
        const idle = manifest.animations.idle
        if (!idle) return ''
        const sheetPath = join(petDir, manifest.spritesheetPath)
        const mtimeMs = statSync(sheetPath).mtimeMs
        const hit = cache.get(petId)
        if (hit && hit.mtimeMs === mtimeMs) return hit.url
        const img = nativeImage.createFromPath(sheetPath)
        if (img.isEmpty()) { cache.set(petId, { mtimeMs, url: '' }); return '' }
        const r = frameRect(manifest.sheet, idle.row, 0)
        const url = img.crop({ x: r.x, y: r.y, width: r.w, height: r.h })
          .resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'good' })
          .toDataURL()
        cache.set(petId, { mtimeMs, url })
        return url
      } catch (e) {
        console.warn('[petAvatar] 裁头像失败', petId, e)
        return ''
      }
    }
  }
}
```

- [ ] **Step 2: 注册 `CHAT_LIST_PETS` 处理器**

`src/main/shell/index.ts`:

顶部 import 追加:

```ts
import { buildPetChatList } from '../pets/petChatList'
import { createPetAvatarCache, resolvePetDir } from '../pets/petAvatar'
import { loadTranscript } from '../memory/transcriptStore'
```

在 startShell 里(建 `session` 之后)建缓存并注册处理器:

```ts
const petAvatarCache = createPetAvatarCache()

ipcMain.handle(IPC.CHAT_LIST_PETS, async (): Promise<PetChatListItem[]> => {
  const pets = listPets(petCatalogDirs)
  return buildPetChatList({
    pets,
    activeId: session.petId,
    activeMessages: session.messages(),
    peekLast: (petId) => {
      const dir = resolvePetDir(petId, petCatalogDirs)
      const t = loadTranscript(join(dir, 'memory', 'transcript.json'))
      return t.messages[t.messages.length - 1]
    },
    avatarOf: (petId) => petAvatarCache.avatarOf(resolvePetDir(petId, petCatalogDirs), petId)
  })
})
```

从 `@shared/ipc` 的 import 里补上 `PetChatListItem` 类型。

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add src/main/pets/petAvatar.ts src/main/shell/index.ts
git commit -m "feat(dialog): CHAT_LIST_PETS 处理器(nativeImage 裁头像+mtime缓存+末条消息peek)"
```

---

## Task 7: `switchPet` 后端 + 精灵热重载

**Files:**
- Modify: `src/renderer/spritePlayer.ts`(加 `reload`)
- Modify: `src/renderer/petController.ts`(加 `reload`)
- Modify: `src/renderer/main.ts`(注册 `onPetChanged`)
- Modify: `src/main/shell/index.ts`(`switchPet` 函数 + `SWITCH_PET` 处理器)

**Interfaces:**
- Consumes: `PetSession`(Task 3)、`createPetSession`、`validatePetId`(Task 4)、`PET_CHANGED`/`PET_SWITCHED`/`SWITCH_PET`(Task 4)。
- Produces: `SpritePlayer.reload(sheet, manifest)`;`PetController.reload(): Promise<void>`;`switchPet(petId): Promise<boolean>`。

- [ ] **Step 1: `SpritePlayer.reload`**

`src/renderer/spritePlayer.ts` —— 在 `stop()` 之后加:

```ts
  /** 热切换宠物:换图集与 manifest,复位帧/状态,由下一次 play() 重新起播。 */
  reload(sheet: HTMLImageElement, manifest: PetManifest): void {
    this.stop()
    this.sheet = sheet
    this.manifest = manifest
    this.frame = 0
    this.state = ''
  }
```

(`sheet`/`manifest` 是构造函数的 `private` 参数字段,非 `readonly`,可重新赋值。)

- [ ] **Step 2: `PetController.reload`**

`src/renderer/petController.ts` —— 在 `stop()` 之后加(复位大脑到 idle,让 tick 循环用新图集重新起播;`currentAnim=''` 强制下一 tick 重新 `play`):

```ts
  /** 热切换宠物:重新拉取宠物数据、换掉 SpritePlayer 的图集/manifest,大脑复位到 idle。 */
  async reload(): Promise<void> {
    const { manifest, spritesheetDataUrl } = await window.petApi.getPet()
    const sheet = new Image()
    sheet.src = spritesheetDataUrl
    await sheet.decode()
    this.player.reload(sheet, manifest)
    this.ctx = initBrain()
    this.currentAnim = ''
  }
```

(`initBrain` 已在文件顶部 import;`this.player` 已是私有字段。)

- [ ] **Step 3: 渲染层注册 onPetChanged**

`src/renderer/main.ts` —— 在 `window.petApi.onContextSignal(...)` 附近加:

```ts
  window.petApi.onPetChanged(() => {
    void controller.reload().catch((err) => console.warn('pet reload failed', err))
  })
```

- [ ] **Step 4: 主进程 `switchPet` + 处理器**

`src/main/shell/index.ts` —— 顶部 import 补 `validatePetId`;在 startShell 里(`session` 与 `CHAT_LIST_PETS` 之后)加:

```ts
async function switchPet(petId: string): Promise<boolean> {
  if (petId === session.petId) return false
  if (!listPets(petCatalogDirs).some((p) => p.id === petId)) {
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '找不到这只宠物')
    return false
  }
  // 先建后弃:新会话构建成功才 dispose 旧的,失败则旧会话原封不动
  let next: PetSession
  try {
    next = createPetSession(petId, sessionDeps)
  } catch (e) {
    console.warn('[switchPet] 新会话构建失败,保留当前宠物', e)
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '切换失败,已保留当前宠物')
    return false
  }
  await session.dispose()          // 停旧语音(释放端口)、停 appFocus、取消在途
  session = next
  session.startVoice()             // 端口已释放,启新宠物语音(未配置则静默不启)
  saveSettings(settingsFile, { ...loadSettings(settingsFile), activePetId: petId })
  petWin.webContents.send(IPC.PET_CHANGED)     // 渲染层重载精灵
  dialog.pushUpdate(session.messages())        // 右栏历史热切换
  const loaded = await loadPet(session.petDir).catch(() => null)
  dialog.window()?.webContents.send(IPC.PET_SWITCHED, {
    petId, displayName: loaded?.manifest.displayName ?? petId
  })
  // 清跨宠物残留气泡
  clearAmbientLine(); bubbleHasContent = false; bubble.clear(); bubble.hide()
  return true
}

ipcMain.handle(IPC.SWITCH_PET, async (_e, raw): Promise<boolean> => {
  const id = validatePetId(raw)
  if (!id) return false
  return switchPet(id)
})
```

需要 `PetSession` 类型 import:`import { createPetSession, type PetSession, type PetSessionDeps } from './petSession'`(把 Task 3 的 import 补全类型)。

- [ ] **Step 5: typecheck + build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿。

> 真机切换验收留到 Task 9(需要左栏 UI 才能点头像触发);本 Task 只保证编译与既有测试通过。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/spritePlayer.ts src/renderer/petController.ts src/renderer/main.ts src/main/shell/index.ts
git commit -m "feat(dialog): switchPet 后端(先建后弃)+ 精灵热重载(PetController/SpritePlayer.reload)"
```

---

## Task 8: 展开态双栏布局(HTML/CSS)

把展开态从单栏改成"左栏 `#pet-list` + 右栏 `#chat-pane`";折叠态仍是单栏胶囊。本 Task 只做**结构与样式**,列表数据/交互在 Task 9。

**Files:**
- Modify: `src/renderer/dialog.html`(结构 + 样式)

- [ ] **Step 1: 重排 `#panel` 内部结构**

`src/renderer/dialog.html` `<body>` 里,把现有 `#panel` 内容改成(把原 `#chat-head`/`#history`/`#attach`/`#bar` 包进新的 `#chat-pane`,前面加 `#pet-list`):

```html
    <div id="panel" class="collapsed">
      <div id="pet-list"></div>
      <div id="chat-pane">
        <div id="chat-head">
          <div id="avatar"></div>
          <div id="pet-name"></div>
          <button id="headCollapse" type="button" title="收起">⤡</button>
        </div>
        <div id="history"></div>
        <div id="attach"></div>
        <div id="bar">
          <textarea id="input" rows="1" placeholder="说点什么…"></textarea>
          <button id="pick" class="icon" title="选择图片">＋</button>
          <button id="shot" class="icon" title="框选截屏">📷</button>
          <button id="toggle" title="展开">⤢</button>
          <button id="send">➤</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: 双栏样式**

在 `<style>` 里加/改:

`#panel` 基础规则改为横向 flex 容纳两栏(展开态),折叠态维持纵向单栏胶囊:

```css
      /* 展开态:横向双栏 */
      #panel.expanded { flex-direction: row; }
      #panel.collapsed #pet-list { display: none; }
      #panel.collapsed #chat-pane { flex-direction: column; height: 100%; width: 100%; }

      /* 右栏:承载原有 head/history/attach/bar,纵向 */
      #chat-pane { display: flex; flex-direction: column; min-width: 0; flex: 1; height: 100%; }

      /* 左栏:宠物列表 */
      #pet-list { -webkit-app-region: no-drag; width: 150px; flex-shrink: 0; height: 100%;
                  overflow-y: auto; background: var(--surface-grad);
                  border-right: 1px solid var(--border); display: flex; flex-direction: column;
                  scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; }
      #pet-list::-webkit-scrollbar { width: 6px; }
      #pet-list::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: var(--radius-pill); }
      #panel.collapsed #pet-list { display: none; }

      .pet-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
                 position: relative; border-bottom: 1px solid var(--border); }
      .pet-row:hover { background: var(--accent-soft); }
      .pet-row.active { background: var(--accent-soft); }
      .pet-row.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0;
                                width: 3px; background: var(--accent); }
      .pet-row .pr-avatar { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
                            background-color: var(--accent-soft); background-size: cover; background-position: center; }
      .pet-row .pr-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .pet-row .pr-name { font-size: 12px; font-weight: 700; color: var(--text-primary);
                          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pet-row .pr-last { font-size: 10.5px; color: var(--text-secondary);
                          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

> `#history` 的既有样式不变(仍 `#panel.expanded #history { display:flex }`)。因为现在 history 在 `#chat-pane` 内、chat-pane 在展开态是 row 的一个 flex 子项且自身 column,`#history { flex:1; min-height:0 }` 的滚动行为不受影响。`#chat-head`/`#send`/`#toggle` 的 `#panel.expanded` 选择器仍生效(祖先仍有 `.expanded`)。

- [ ] **Step 3: 真机确认布局**

Run: `pnpm build && pnpm preview`
真机确认:
- 折叠态:仍只有输入胶囊,无左栏、无空白(Phase 1 不回归)。
- 展开态:左侧出现一条(暂时可能空白,数据在 Task 9)竖栏 + 右侧聊天区;窗口约 520 宽;右栏 head/history/输入条布局正常、history 能滚动、输入条常驻底部。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/dialog.html
git commit -m "feat(dialog): 展开态改双栏结构(左栏宠物列表 + 右栏聊天)"
```

---

## Task 9: 左栏列表渲染 + 点头像热切换(交互 + 整体验收)

**Files:**
- Modify: `src/renderer/dialog.ts`(渲染列表、点击切换、onSwitched 刷新、CHAT_UPDATE 后刷新预览)

**Interfaces:**
- Consumes: `chatApi.listPetsForChat`/`switchPet`/`onSwitched`(Task 4)、`PetChatListItem`(Task 4)。

- [ ] **Step 1: 列表渲染函数**

`src/renderer/dialog.ts` —— 顶部取 `#pet-list` 元素(与其他 `getElementById` 并列):

```ts
const petListEl = document.getElementById('pet-list') as HTMLElement
```

从 `@shared/ipc` import 补 `PetChatListItem` 类型。加渲染 + 刷新函数:

```ts
function renderPetList(items: PetChatListItem[]): void {
  petListEl.innerHTML = ''
  for (const it of items) {
    const row = document.createElement('div')
    row.className = it.active ? 'pet-row active' : 'pet-row'
    const av = document.createElement('div')
    av.className = 'pr-avatar'
    if (it.avatarDataUrl) av.style.backgroundImage = `url(${it.avatarDataUrl})`
    const text = document.createElement('div')
    text.className = 'pr-text'
    const name = document.createElement('div')
    name.className = 'pr-name'
    name.textContent = it.displayName
    const last = document.createElement('div')
    last.className = 'pr-last'
    last.textContent = it.lastMessage ?? '还没聊过'
    text.append(name, last)
    row.append(av, text)
    if (!it.active) row.addEventListener('click', () => { void switchTo(it.id) })
    petListEl.appendChild(row)
  }
}

async function refreshPetList(): Promise<void> {
  try { renderPetList(await window.chatApi.listPetsForChat()) }
  catch (e) { console.warn('list pets failed', e) }
}

let switching = false
async function switchTo(petId: string): Promise<void> {
  if (switching) return
  switching = true
  try { await window.chatApi.switchPet(petId) }
  finally { switching = false }
  // 切换结果由 onSwitched 推送驱动界面刷新(见 Step 2),这里不直接改 UI
}
```

- [ ] **Step 2: onSwitched 刷新右栏头部 + 列表;首次展开与每次更新时刷新列表**

在文件底部(既有 `window.chatApi.onUpdate(render)` 等注册处附近)加/改:

```ts
window.chatApi.onSwitched((p) => {
  petNameEl.textContent = p.displayName          // 立即更新右栏名字(避免等 loadAvatar)
  void loadAvatar().catch(() => { /* 头像装饰,失败不影响 */ })  // 刷新右栏头像 + 内部 avatarDataUrl
  void refreshPetList()                           // 刷新左栏高亮 + 预览
})
```

把既有 `window.chatApi.onUpdate(render)` 改为渲染消息后同时刷新列表预览:

```ts
window.chatApi.onUpdate((messages) => {
  render(messages)
  void refreshPetList()
})
```

在 `setCollapsed` 里,展开时拉一次列表(折叠→展开首次填充左栏)。在 `setCollapsed` 末尾加:

```ts
  if (!c) void refreshPetList()
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿。

- [ ] **Step 4: 整体真机验收**

Run: `pnpm preview`
逐项确认:
1. 展开对话框 → 左栏列出全部已安装宠物(头像/名字/末条预览),当前宠物高亮。
2. 点另一只宠物头像 → **桌面精灵换成那只**;右栏历史换成那只宠物自己的历史(**时间戳仍在**);右栏头部头像/名字更新;左栏高亮移动到新宠物。
3. 关掉 app 重开 → 默认加载最后切到的那只(`settings.json` 的 `activePetId` 已改)。
4. 切到一只"从未激活过的内置宠物" → 正常播种、可聊天、列表预览从空变有。
5. 切换时若正有回复在流式 → 旧回复干净中止,不串进新宠物。
6. 折叠态不回归(仍只有胶囊、无空白)。
7. (若配了语音)切到有语音的宠物念得出;切走后旧语音进程停(任务管理器无残留 python)。

> 真机若发现问题,走 `superpowers:systematic-debugging`;GPU/语音/真实多宠物等无法在无显示会话自动化的项,按 [[feedback_dont-stall-on-hard-to-automate-tests]] 明确交回用户验收,不空转。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/dialog.ts
git commit -m "feat(dialog): 左栏宠物列表渲染 + 点头像热切换(热切精灵/历史/头像,保留时间戳)"
```

---

## 附:自查覆盖(spec → task 映射)

- spec 一(折叠瘦身)→ Task 1 + Task 2。
- spec 二(双栏结构)→ Task 8(布局) + Task 9(列表数据/交互)。
- spec 三(热切换架构:PetSession 抽取 + switchPet 先建后弃 + 语音端口序列)→ Task 3 + Task 7。
- spec 3.4(精灵热重载)→ Task 7 Step 1-3。
- spec 四(新增 IPC 契约)→ Task 2(折叠上报) + Task 4(列表/切换/PET_CHANGED)。
- spec 五(列表数据:头像裁剪 + 末条 peek + 缓存)→ Task 5(纯逻辑) + Task 6(nativeImage/peek/缓存)。
- spec 六(边界:点自己/在途取消/坏包先建后弃/语音停/待办不动/onboarding 不挂)→ Task 7(点自己+先建后弃+语音序列)、Task 3(dispose 取消在途)、Task 6(resolvePetDir 内置回退)、startShell 既有 onboarding 分支不动(不挂 chat 侧新 IPC)。
- spec 持久化(activePetId)→ Task 7 Step 4。

> 已知取舍(spec 已列/本计划明确):controlIndicator 保持全局单例、切换后指示器显示名停留在初始宠物名(桌面控制默认关闭,优先级低,不在本计划范围内改);列表默认按 `listPets` 的 displayName 排序,`lastMessageTime` 已随项下发,"按最近活跃排序"未实现(非契约,可后续)。
