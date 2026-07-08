# 宠物自主截屏 + 鼠标键盘控制工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pet's agent six new tools — `take_screenshot`, `list_windows`, `focus_window`, `click_at`, `type_text`, `press_key` — so it can autonomously see the screen and drive the mouse/keyboard during normal chat, gated behind a default-off, explicitly-confirmed "desktop control" setting.

**Architecture:** Six `ToolSpec`s registered in the existing `chat.ts` tool loop (same mechanism as `web_search`/`weather`/`firecrawl`), backed by a new `src/main/automation/` module (pure PowerShell/Win32 script builders + an injectable `execFile` wrapper) for mouse/keyboard/window control, and a new full-screen capture helper reusing the existing MVP-07 image pipeline for screenshots. A small cross-provider protocol extension lets tool results carry images (needed so `take_screenshot`'s result can include the actual image). Risk is bounded by: default-off setting + a native confirm dialog before enabling, a visible on-screen indicator while any of the six tools is executing, a manual-mouse-override safety net that aborts the run if the human grabs the mouse, and a small explicit key-name allowlist for `press_key`.

**Tech Stack:** Electron/TypeScript (existing stack), Windows `powershell.exe` + Win32 API via P/Invoke (`Add-Type`) — no new npm dependencies.

## Global Constraints

- Windows-only: all six tools must return a clear "此功能仅支持 Windows" error on non-`win32` platforms, never silently no-op.
- Default off: `AppSettings.desktopControl.enabled` defaults to `false`. `SETTINGS_SCHEMA_VERSION` bumps 6→7 with a migration that fills the default for old settings files.
- Enabling requires an explicit native confirm dialog (`dialog.showMessageBox`) stating the privacy/misuse risk in Chinese; canceling leaves the setting off. A plain checkbox toggle is not sufficient on its own.
- While any of the six tools is executing, show a visible always-on-top indicator reading `"<宠物 displayName> 正在控制鼠标"` — **never** "AI 正在控制鼠标". Hide it as soon as no desktop-control tool is active.
- `click_at` must error if no `take_screenshot` has happened yet in the current turn — never guess coordinates.
- `press_key` only accepts an explicit allowlist (Enter/Tab/Escape/Backspace/Delete/arrows/Ctrl+A|C|V|X|Z) — reject everything else, including any Alt/Win/Ctrl+Alt combos.
- `type_text` caps at 2000 characters — reject (don't silently truncate) longer input.
- When `desktopControl.enabled` is true, `runAgent` gets `maxToolRounds: 20` instead of the default 6 (a real screenshot→click→screenshot loop needs more than 6 tool calls; still a hard ceiling).
- No new npm dependencies. Native/impure code (PowerShell invocation, `BrowserWindow` creation, `desktopCapturer`) is verified by hand (`pnpm build && pnpm preview`), matching this repo's existing precedent for `screenCapture.ts`/`imagePrep.ts`. Pure logic (script builders, stdout parsers, coordinate math, allowlists, settings normalization) gets Vitest coverage — write it first, TDD.
- Any string interpolated into a PowerShell script (typed text, window-title search string) must be base64-encoded before embedding and decoded inside the script — never string-interpolate raw untrusted text into a shell command.
- Six tools are project-default-injected (like `weather`/`firecrawl`), never placed in a pet package, never gated by `persona.md`.

---

## Task 1: Settings schema — `desktopControl.enabled`

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify (test): `src/main/config/settings.test.ts`
- Modify (test): `src/main/config/settingsMigration.test.ts`
- Modify: `src/main/shell/chat.test.ts` (settings fixture needs the new field to keep compiling)
- Modify: `src/main/providers/embedder.test.ts` (same reason)

**Interfaces:**
- Produces: `DesktopControlSettings { enabled: boolean }`, `AppSettings.desktopControl: DesktopControlSettings`, `DEFAULT_SETTINGS.desktopControl = { enabled: false }`, `SETTINGS_SCHEMA_VERSION = 7`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/config/settings.test.ts` (round-trip test needs the new field, and a fresh assertion group):

```ts
// in the existing round-trip literal (line ~26), add the field:
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false } }
```

Update every `toBe(6)` in this file to `toBe(7)` (there is one, in the `activePetId` describe block: `'归一化后 schemaVersion 升为 6'` → rename to `7` and assert `toBe(7)`).

Add to `src/main/config/settingsMigration.test.ts` a new describe block, and bump all existing `toBe(6)` (9 occurrences across this file) to `toBe(7)`, renaming the Chinese test titles that say "升到 6"/"升为 6" to "7" for consistency:

```ts
describe('desktopControl 迁移', () => {
  it('缺失 desktopControl 时补默认 { enabled:false } 且 schemaVersion 升到 7', () => {
    const out = normalizeSettings({
      schemaVersion: 6,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false },
      firecrawl: { enabled: false }
    })
    expect(out.schemaVersion).toBe(7)
    expect(out.desktopControl).toEqual({ enabled: false })
  })

  it('保留已存的 enabled:true', () => {
    const out = normalizeSettings({ desktopControl: { enabled: true } })
    expect(out.desktopControl.enabled).toBe(true)
  })

  it('enabled 非布尔退化为 false', () => {
    const out = normalizeSettings({ desktopControl: { enabled: 'yes' } })
    expect(out.desktopControl.enabled).toBe(false)
  })
})
```

Update `src/main/shell/chat.test.ts`'s `settings` object literal (line ~19) and `src/main/providers/embedder.test.ts`'s literal (line ~62) to each add `desktopControl: { enabled: false }` — these are `AppSettings`-typed and will fail to compile otherwise.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts`
Expected: FAIL — `desktopControl` missing on `AppSettings`/`normalizeSettings` output, `schemaVersion` assertions off by one, plus TypeScript compile errors in `chat.test.ts`/`embedder.test.ts` about the missing property.

- [ ] **Step 3: Implement**

In `src/shared/llm.ts`, add near `FirecrawlSettings`:

```ts
export interface DesktopControlSettings { enabled: boolean }
```

Change `SETTINGS_SCHEMA_VERSION` and `AppSettings`/`DEFAULT_SETTINGS`:

```ts
export const SETTINGS_SCHEMA_VERSION = 7

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false }
}
```

In `src/main/config/settings.ts`, inside `normalizeSettings`, after the `firecrawl` block:

```ts
  const dc = (r.desktopControl ?? {}) as Record<string, unknown>
  const desktopControl = { enabled: dc.enabled === true }
```

and add `desktopControl` to the returned object (after `firecrawl`):

```ts
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts src/main/shell/chat.test.ts src/main/providers/embedder.test.ts`
Expected: PASS, all green.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (this ripples into every file that constructs an `AppSettings` literal — the two test files above were identified via `grep -rn "firecrawl: { enabled"` across `src/`; if typecheck surfaces any other literal this search missed, add `desktopControl: { enabled: false }` there too).

- [ ] **Step 6: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts src/main/shell/chat.test.ts src/main/providers/embedder.test.ts
git commit -m "feat(settings): 新增 desktopControl.enabled 开关(默认关闭,schemaVersion 6→7)"
```

---

## Task 2: Tool-result image protocol (cross-provider)

**Files:**
- Modify: `src/main/tools/toolSpec.ts`
- Modify: `src/main/tools/toolRegistry.ts`
- Modify (test): `src/main/tools/toolRegistry.test.ts`
- Modify: `src/shared/llm.ts` (tool_result variant of `AgentMessage`)
- Modify: `src/main/agent/agentLoop.ts`
- Modify: `src/main/providers/messageMapping.ts`
- Modify (test): `src/main/providers/messageMapping.test.ts`

**Interfaces:**
- Produces: `ToolSpec.run(input, ctx): Promise<string | { content: string; images?: ImagePart[] }>` (widened, backward compatible with every existing tool that still returns a plain `string`). `ToolRunResult { content: string; isError?: boolean; images?: ImagePart[] }`. `AgentMessage`'s `tool_result` variant gains `images?: ImagePart[]`.
- Consumes (Task 8): `desktopTools.ts`'s `take_screenshot` tool returns the object form with `images`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/tools/toolRegistry.test.ts`:

```ts
const withImage: ToolSpec = {
  name: 'shot',
  description: '返回图片',
  inputSchema: { type: 'object', properties: {}, required: [] },
  run: async () => ({ content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'AAA' }] })
}
```

and inside `describe('createToolRegistry', ...)` (extend the registry under test and add a case):

```ts
  const registry = createToolRegistry([echo, boom, withImage])
  // ...
  it('工具返回 { content, images } 对象时原样透传 images', async () => {
    const r = await registry.run('shot', {}, ctx)
    expect(r).toEqual({ content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'AAA' }] })
  })
```

(Note: the `defs()` test's `toHaveLength(2)` must become `toHaveLength(3)`.)

Add to `src/main/providers/messageMapping.test.ts`:

```ts
describe('tool_result 带图像', () => {
  const shotMsg: AgentMessage[] = [
    { role: 'tool_result', toolUseId: 'tu_1', content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'QUJD' }] }
  ]

  it('anthropic:tool_result content 数组内追加 image 块', () => {
    const out = toAnthropicMessages(shotMsg)
    expect(out).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'tu_1',
        content: [
          { type: 'text', text: '已截屏' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
        ]
      }]
    }])
  })

  it('openai-compat:tool 消息纯文本,紧随一条合成的 user image 消息', () => {
    const out = toOpenAiMessages('sys', shotMsg)
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '已截屏' })
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]
    })
  })

  it('tool_result 无 images 时行为不变(content 仍是字符串)', () => {
    const plain: AgentMessage[] = [{ role: 'tool_result', toolUseId: 'tu_1', content: '结果A' }]
    expect(toAnthropicMessages(plain)[0]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '结果A' }] })
    expect(toOpenAiMessages('s', plain)[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '结果A' })
  })
})
```

Add to `src/main/agent/agentLoopTools.test.ts` (verifies `agentLoop` threads `images` from the tool result into the message the *next* round's provider call sees):

```ts
it('工具返回 images 时,下一轮 provider 收到的 tool_result 消息携带 images', async () => {
  const imgTool: ToolSpec = {
    name: 'shot',
    description: '截图',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => ({ content: '已截屏', images: [{ mimeType: 'image/jpeg', dataBase64: 'AAA' }] })
  }
  const seen: unknown[] = []
  const provider = {
    async *streamChat(req: { messages: unknown[] }) {
      seen.push(req.messages)
      if (seen.length === 1) { yield { type: 'tool_use' as const, toolUse: { id: 't1', name: 'shot', input: {} } }; yield { type: 'done' as const } }
      else { yield { type: 'text' as const, text: '看到了' }; yield { type: 'done' as const } }
    }
  }
  await runAgent({
    provider,
    registry: createToolRegistry([imgTool]),
    system: 'sys',
    messages: [{ role: 'user', content: '截个屏' }],
    maxOutputTokens: 100,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    onText: () => {}
  })
  const secondCallMessages = seen[1] as Array<{ role: string; images?: unknown }>
  const toolResultMsg = secondCallMessages.find((m) => m.role === 'tool_result')
  expect(toolResultMsg?.images).toEqual([{ mimeType: 'image/jpeg', dataBase64: 'AAA' }])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/tools/toolRegistry.test.ts src/main/providers/messageMapping.test.ts src/main/agent/agentLoopTools.test.ts`
Expected: FAIL — `images` not in type/output yet.

- [ ] **Step 3: Implement**

In `src/main/tools/toolSpec.ts`:

```ts
import type { ToolDef, ImagePart } from '@shared/llm'

export interface ToolContext {
  signal: AbortSignal
  /** 工具自行播报进行中的状态(如「正在搜索:xxx」);安静工具不调 */
  onStatus?: (text: string) => void
}

export interface ToolRunOutput { content: string; images?: ImagePart[] }

export interface ToolSpec extends ToolDef {
  run(input: unknown, ctx: ToolContext): Promise<string | ToolRunOutput>
}
```

In `src/main/tools/toolRegistry.ts`, widen `ToolRunResult` and normalize the union in `run()`:

```ts
import type { ToolDef, ImagePart } from '@shared/llm'
import type { ToolSpec, ToolContext } from './toolSpec'

export interface ToolRunResult { content: string; isError?: boolean; images?: ImagePart[] }
```

```ts
      try {
        const r = await tool.run(input, ctx)
        return typeof r === 'string' ? { content: r } : { content: r.content, images: r.images }
      } catch (e) {
        return { isError: true, content: `工具执行失败:${String((e as Error)?.message ?? e)}` }
      }
```

In `src/shared/llm.ts`, widen the `tool_result` branch of `AgentMessage`:

```ts
export type AgentMessage =
  | ChatTurn
  | { role: 'assistant_tool_use'; text?: string; toolUse: ToolUse }
  | { role: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: ImagePart[] }
```

In `src/main/agent/agentLoop.ts`, thread `r.images` through when pushing the tool_result message:

```ts
      const r = await opts.registry.run(tu.name, tu.input, { signal: opts.signal, onStatus: opts.onStatus })
      if (opts.signal.aborted) return { text, canceled: true }
      messages.push({ role: 'tool_result', toolUseId: tu.id, content: r.content, isError: r.isError, images: r.images })
```

In `src/main/providers/messageMapping.ts`, extend the `tool_result` branch of `toAnthropicMessages`:

```ts
    } else if (m.role === 'tool_result') {
      const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: m.content }]
      if (m.images && m.images.length > 0) {
        for (const img of m.images) contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 } })
      }
      const block: Record<string, unknown> = m.images && m.images.length > 0
        ? { type: 'tool_result', tool_use_id: m.toolUseId, content: contentBlocks }
        : { type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }
      if (m.isError) block.is_error = true
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
```

and extend the `tool_result` branch of `toOpenAiMessages` to push a synthetic follow-up `user` image message when images are present:

```ts
    } else if (m.role === 'tool_result') {
      // openai 无 is_error 概念:错误信息就在 content 文本里,模型可读
      out.push({ role: 'tool', tool_call_id: m.toolUseId, content: m.content })
      if (m.images && m.images.length > 0) {
        out.push({
          role: 'user',
          content: m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } }))
        })
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/tools/toolRegistry.test.ts src/main/providers/messageMapping.test.ts src/main/agent/agentLoopTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Full regression + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all existing tools (which still return plain `string`) keep passing unchanged — this is the point of the union return type.

- [ ] **Step 6: Commit**

```bash
git add src/main/tools/toolSpec.ts src/main/tools/toolRegistry.ts src/main/tools/toolRegistry.test.ts src/shared/llm.ts src/main/agent/agentLoop.ts src/main/agent/agentLoopTools.test.ts src/main/providers/messageMapping.ts src/main/providers/messageMapping.test.ts
git commit -m "feat(agent): 工具结果协议支持可选 images,跨两家 Provider 序列化"
```

---

## Task 3: `keyAllowlist.ts` — press_key allowlist

**Files:**
- Create: `src/main/automation/keyAllowlist.ts`
- Create (test): `src/main/automation/keyAllowlist.test.ts`

**Interfaces:**
- Produces: `ALLOWED_KEY_NAMES: string[]`, `resolveKey(key: string): number[] | null` (returns the ordered Win32 virtual-key codes to press, e.g. `['Ctrl+A']` → `[0x11, 0x41]`; unknown key → `null`).
- Consumes (Task 6): `automationControl.ts` calls `resolveKey` before building a press-key script.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/automation/keyAllowlist.test.ts
import { describe, it, expect } from 'vitest'
import { resolveKey, ALLOWED_KEY_NAMES } from './keyAllowlist'

describe('resolveKey', () => {
  it('单键:Enter/Tab/Escape/Backspace/Delete/方向键解析出对应单个 vk code', () => {
    expect(resolveKey('Enter')).toEqual([0x0d])
    expect(resolveKey('Tab')).toEqual([0x09])
    expect(resolveKey('Escape')).toEqual([0x1b])
    expect(resolveKey('Backspace')).toEqual([0x08])
    expect(resolveKey('Delete')).toEqual([0x2e])
    expect(resolveKey('ArrowUp')).toEqual([0x26])
    expect(resolveKey('ArrowDown')).toEqual([0x28])
    expect(resolveKey('ArrowLeft')).toEqual([0x25])
    expect(resolveKey('ArrowRight')).toEqual([0x27])
  })

  it('组合键:Ctrl+X 系列解析出 [Ctrl, X] 两个 vk code(按下顺序)', () => {
    expect(resolveKey('Ctrl+A')).toEqual([0x11, 0x41])
    expect(resolveKey('Ctrl+C')).toEqual([0x11, 0x43])
    expect(resolveKey('Ctrl+V')).toEqual([0x11, 0x56])
    expect(resolveKey('Ctrl+X')).toEqual([0x11, 0x58])
    expect(resolveKey('Ctrl+Z')).toEqual([0x11, 0x5a])
  })

  it('白名单外的键(含破坏性组合)一律返回 null', () => {
    expect(resolveKey('Alt+F4')).toBeNull()
    expect(resolveKey('Ctrl+Alt+Delete')).toBeNull()
    expect(resolveKey('Meta')).toBeNull()
    expect(resolveKey('F1')).toBeNull()
    expect(resolveKey('')).toBeNull()
  })

  it('ALLOWED_KEY_NAMES 与可解析的键名集合一致', () => {
    for (const name of ALLOWED_KEY_NAMES) expect(resolveKey(name)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/automation/keyAllowlist.test.ts`
Expected: FAIL with "Cannot find module './keyAllowlist'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/keyAllowlist.ts

/**
 * press_key 的白名单:只接受这里列出的键名,拒绝一切组合键/系统级快捷键
 * (Alt+F4、Win 键组合、Ctrl+Alt+Delete 等),把一次模型误判的破坏范围锁死。
 * vk code 参考:https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
 */
const VK_CONTROL = 0x11

const ALLOWLIST: Record<string, number[]> = {
  Enter: [0x0d],
  Tab: [0x09],
  Escape: [0x1b],
  Backspace: [0x08],
  Delete: [0x2e],
  ArrowUp: [0x26],
  ArrowDown: [0x28],
  ArrowLeft: [0x25],
  ArrowRight: [0x27],
  'Ctrl+A': [VK_CONTROL, 0x41],
  'Ctrl+C': [VK_CONTROL, 0x43],
  'Ctrl+V': [VK_CONTROL, 0x56],
  'Ctrl+X': [VK_CONTROL, 0x58],
  'Ctrl+Z': [VK_CONTROL, 0x5a]
}

export const ALLOWED_KEY_NAMES: string[] = Object.keys(ALLOWLIST)

export function resolveKey(key: string): number[] | null {
  return ALLOWLIST[key] ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/automation/keyAllowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/keyAllowlist.ts src/main/automation/keyAllowlist.test.ts
git commit -m "feat(automation): press_key 键名白名单(resolveKey)"
```

---

## Task 4: `screenshotState.ts` — coordinate mapping

**Files:**
- Create: `src/main/automation/screenshotState.ts`
- Create (test): `src/main/automation/screenshotState.test.ts`

**Interfaces:**
- Produces: `ScreenshotRecord { displayId: string; originX: number; originY: number; physicalWidth: number; physicalHeight: number; imageWidth: number; imageHeight: number }`, `ScreenshotState { record(r): void; current(): ScreenshotRecord | null; reset(): void; toPhysicalPoint(x, y): { x: number; y: number } | null }`, `createScreenshotState(): ScreenshotState`.
- Consumes (Task 8): `desktopTools.ts`'s `take_screenshot` tool calls `record()` after a successful capture; `click_at` calls `toPhysicalPoint()` and errors if it returns `null` (meaning no prior screenshot).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/automation/screenshotState.test.ts
import { describe, it, expect } from 'vitest'
import { createScreenshotState } from './screenshotState'

const rec = {
  displayId: '1', originX: 0, originY: 0,
  physicalWidth: 1920, physicalHeight: 1080,
  imageWidth: 960, imageHeight: 540 // 降采样到一半
}

describe('createScreenshotState', () => {
  it('未 record 时 current() 为 null,toPhysicalPoint 返回 null', () => {
    const s = createScreenshotState()
    expect(s.current()).toBeNull()
    expect(s.toPhysicalPoint(10, 10)).toBeNull()
  })

  it('record 后按缩放比换算图像坐标 → 物理屏幕坐标', () => {
    const s = createScreenshotState()
    s.record(rec)
    expect(s.toPhysicalPoint(100, 50)).toEqual({ x: 200, y: 100 }) // ×2 缩放
  })

  it('换算叠加显示器物理原点偏移', () => {
    const s = createScreenshotState()
    s.record({ ...rec, originX: 1920, originY: 0 }) // 第二个显示器,原点在右侧
    expect(s.toPhysicalPoint(0, 0)).toEqual({ x: 1920, y: 0 })
  })

  it('越界坐标被夹回显示器物理范围内', () => {
    const s = createScreenshotState()
    s.record(rec)
    expect(s.toPhysicalPoint(-50, -50)).toEqual({ x: 0, y: 0 })
    expect(s.toPhysicalPoint(99999, 99999)).toEqual({ x: 1919, y: 1079 })
  })

  it('reset 后回到未截屏状态', () => {
    const s = createScreenshotState()
    s.record(rec)
    s.reset()
    expect(s.current()).toBeNull()
    expect(s.toPhysicalPoint(1, 1)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/automation/screenshotState.test.ts`
Expected: FAIL with "Cannot find module './screenshotState'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/screenshotState.ts

export interface ScreenshotRecord {
  displayId: string
  /** 该显示器左上角在"物理像素"坐标系里的原点(已乘 scaleFactor) */
  originX: number
  originY: number
  /** 该显示器的物理分辨率(已乘 scaleFactor) */
  physicalWidth: number
  physicalHeight: number
  /** 发给模型的降采样后图像分辨率 —— click_at 的 x,y 以此为基准 */
  imageWidth: number
  imageHeight: number
}

export interface ScreenshotState {
  record(r: ScreenshotRecord): void
  current(): ScreenshotRecord | null
  reset(): void
  /** 把"最近一次截屏图像"坐标系里的 (x,y) 换算成物理屏幕坐标;未截屏过返回 null */
  toPhysicalPoint(x: number, y: number): { x: number; y: number } | null
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

export function createScreenshotState(): ScreenshotState {
  let rec: ScreenshotRecord | null = null
  return {
    record(r) { rec = r },
    current: () => rec,
    reset() { rec = null },
    toPhysicalPoint(x, y) {
      if (!rec) return null
      const scaleX = rec.physicalWidth / rec.imageWidth
      const scaleY = rec.physicalHeight / rec.imageHeight
      const px = Math.round(rec.originX + x * scaleX)
      const py = Math.round(rec.originY + y * scaleY)
      return {
        x: clamp(px, rec.originX, rec.originX + rec.physicalWidth - 1),
        y: clamp(py, rec.originY, rec.originY + rec.physicalHeight - 1)
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/automation/screenshotState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/screenshotState.ts src/main/automation/screenshotState.test.ts
git commit -m "feat(automation): screenshotState 记录截屏换算信息 + 坐标映射"
```

---

## Task 5: `win32Bridge.ts` — pure PowerShell script builders + stdout parsers

**Files:**
- Create: `src/main/automation/win32Bridge.ts`
- Create (test): `src/main/automation/win32Bridge.test.ts`

**Interfaces:**
- Produces: `buildClickScript(x, y, button, double)`, `buildTypeTextScript(text)`, `buildPressKeyScript(vkCodes: number[])`, `buildListWindowsScript()`, `parseListWindowsOutput(stdout): string[]`, `buildFocusWindowScript(titleContains)`, `parseFocusWindowOutput(stdout): { found: true; title: string } | { found: false }` — all pure string-in/string-out functions.
- Consumes (Task 6): `automationControl.ts` calls these builders and feeds the real PowerShell stdout into the parsers.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/automation/win32Bridge.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildClickScript, buildTypeTextScript, buildPressKeyScript,
  buildListWindowsScript, parseListWindowsOutput,
  buildFocusWindowScript, parseFocusWindowOutput
} from './win32Bridge'

describe('buildClickScript', () => {
  it('左键单击:含 SetCursorPos 与一次 down/up(0x0002/0x0004)', () => {
    const s = buildClickScript(100, 200, 'left', false)
    expect(s).toContain('SetCursorPos(100, 200)')
    expect(s).toContain('0x0002')
    expect(s).toContain('0x0004')
    expect((s.match(/mouse_event/g) ?? []).length).toBe(2)
  })

  it('右键单击:用 0x0008/0x0010', () => {
    const s = buildClickScript(1, 1, 'right', false)
    expect(s).toContain('0x0008')
    expect(s).toContain('0x0010')
  })

  it('双击:mouse_event 调用次数翻倍', () => {
    const s = buildClickScript(1, 1, 'left', true)
    expect((s.match(/mouse_event/g) ?? []).length).toBe(4)
  })

  it('坐标非有限数字时抛错(拒绝拼进脚本)', () => {
    expect(() => buildClickScript(Number.NaN, 1, 'left', false)).toThrow()
    expect(() => buildClickScript(1, Number.POSITIVE_INFINITY, 'left', false)).toThrow()
  })
})

describe('buildTypeTextScript', () => {
  it('把文本 base64 编码嵌入脚本,不做裸字符串插值', () => {
    const s = buildTypeTextScript("it's a test")
    expect(s).not.toContain("it's a test")
    const b64 = Buffer.from("it's a test", 'utf16le').toString('base64')
    expect(s).toContain(b64)
  })

  it('中文文本同样走 base64(验证 Unicode 往返)', () => {
    const s = buildTypeTextScript('你好')
    const b64 = Buffer.from('你好', 'utf16le').toString('base64')
    expect(s).toContain(b64)
  })
})

describe('buildPressKeyScript', () => {
  it('组合键按下顺序 down、松开顺序相反', () => {
    const s = buildPressKeyScript([0x11, 0x41]) // Ctrl+A
    const downIdx = s.indexOf('17') // 0x11 = 17
    expect(downIdx).toBeGreaterThan(-1)
  })
})

describe('list_windows 脚本与解析', () => {
  it('buildListWindowsScript 包含 EnumWindows 调用', () => {
    expect(buildListWindowsScript()).toContain('EnumWindows')
  })

  it('parseListWindowsOutput 按行拆分并过滤空行', () => {
    expect(parseListWindowsOutput('记事本\r\n\r\n设置\n')).toEqual(['记事本', '设置'])
  })

  it('parseListWindowsOutput 空输出返回空数组', () => {
    expect(parseListWindowsOutput('')).toEqual([])
  })
})

describe('focus_window 脚本与解析', () => {
  it('buildFocusWindowScript 把 titleContains base64 嵌入,不做裸插值', () => {
    const s = buildFocusWindowScript("Notepad's window")
    expect(s).not.toContain("Notepad's window")
    expect(s).toContain(Buffer.from("Notepad's window", 'utf16le').toString('base64'))
  })

  it('parseFocusWindowOutput 解析 FOUND:<title>', () => {
    expect(parseFocusWindowOutput('FOUND:记事本')).toEqual({ found: true, title: '记事本' })
  })

  it('parseFocusWindowOutput 解析 NOTFOUND', () => {
    expect(parseFocusWindowOutput('NOTFOUND')).toEqual({ found: false })
  })

  it('parseFocusWindowOutput 对意外输出也返回 found:false(不崩)', () => {
    expect(parseFocusWindowOutput('乱七八糟')).toEqual({ found: false })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/automation/win32Bridge.test.ts`
Expected: FAIL with "Cannot find module './win32Bridge'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/win32Bridge.ts

/**
 * 纯函数:构造 PowerShell + C#(Add-Type P/Invoke user32.dll)脚本文本,
 * 以及解析对应脚本的 stdout。不 import child_process/electron,可单测。
 * 真正执行脚本在 desktopControl.ts(自然层,靠真机验收)。
 *
 * 安全:任何模型可控的自由文本(打字内容、窗口标题查询词)一律 base64 编码后
 * 嵌入脚本、脚本内部再解码 —— 避免把不可信文本裸插值进 shell 命令引发注入。
 */

const NATIVE_HEADER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PetAgentAutomation
{
    public class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion U; }

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_KEYUP = 0x0002;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    }
}
"@
[PetAgentAutomation.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
`.trim()

function assertFiniteInt(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new Error(`${label} 必须是有限数字`)
  return Math.round(n)
}

function toBase64Utf16(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64')
}

export function buildClickScript(x: number, y: number, button: 'left' | 'right', double: boolean): string {
  const px = assertFiniteInt(x, 'x')
  const py = assertFiniteInt(y, 'y')
  const down = button === 'right' ? '0x0008' : '0x0002'
  const up = button === 'right' ? '0x0010' : '0x0004'
  const clickOnce = `[PetAgentAutomation.Native]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)\n[PetAgentAutomation.Native]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`
  const second = double ? `\nStart-Sleep -Milliseconds 60\n${clickOnce}` : ''
  return `${NATIVE_HEADER}\n[PetAgentAutomation.Native]::SetCursorPos(${px}, ${py}) | Out-Null\nStart-Sleep -Milliseconds 30\n${clickOnce}${second}\nWrite-Output "OK"`
}

export function buildTypeTextScript(text: string): string {
  const b64 = toBase64Utf16(text)
  return `${NATIVE_HEADER}
$bytes = [Convert]::FromBase64String("${b64}")
$text = [System.Text.Encoding]::Unicode.GetString($bytes)
foreach ($ch in $text.ToCharArray()) {
  $code = [uint16][char]$ch
  $down = New-Object PetAgentAutomation.Native+INPUT
  $down.type = [PetAgentAutomation.Native]::INPUT_KEYBOARD
  $down.U.ki.wScan = $code
  $down.U.ki.dwFlags = [PetAgentAutomation.Native]::KEYEVENTF_UNICODE
  $up = New-Object PetAgentAutomation.Native+INPUT
  $up.type = [PetAgentAutomation.Native]::INPUT_KEYBOARD
  $up.U.ki.wScan = $code
  $up.U.ki.dwFlags = [PetAgentAutomation.Native]::KEYEVENTF_UNICODE -bor [PetAgentAutomation.Native]::KEYEVENTF_KEYUP
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type]"PetAgentAutomation.Native+INPUT")
  [PetAgentAutomation.Native]::SendInput(1, [PetAgentAutomation.Native+INPUT[]]@($down), $sz) | Out-Null
  [PetAgentAutomation.Native]::SendInput(1, [PetAgentAutomation.Native+INPUT[]]@($up), $sz) | Out-Null
  Start-Sleep -Milliseconds 8
}
Write-Output "OK"`
}

export function buildPressKeyScript(vkCodes: number[]): string {
  const list = vkCodes.map((v) => assertFiniteInt(v, 'vkCode')).join(',')
  return `${NATIVE_HEADER}
$vks = @(${list})
foreach ($vk in $vks) { [PetAgentAutomation.Native]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
Start-Sleep -Milliseconds 20
for ($i = $vks.Length - 1; $i -ge 0; $i--) { [PetAgentAutomation.Native]::keybd_event([byte]$vks[$i], 0, 0x0002, [UIntPtr]::Zero) }
Write-Output "OK"`
}

const ENUM_TITLES_SNIPPET = `
$titles = New-Object System.Collections.Generic.List[string]
$callback = {
  param($hWnd, $lParam)
  if ([PetAgentAutomation.Native]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PetAgentAutomation.Native]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $t = $sb.ToString()
    if ($t.Trim().Length -gt 0) { $titles.Add($t) }
  }
  return $true
}
[PetAgentAutomation.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null`

export function buildListWindowsScript(): string {
  return `${NATIVE_HEADER}${ENUM_TITLES_SNIPPET}\n$titles | ForEach-Object { Write-Output $_ }`
}

export function parseListWindowsOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
}

export function buildFocusWindowScript(titleContains: string): string {
  const b64 = toBase64Utf16(titleContains)
  return `${NATIVE_HEADER}
$bytes = [Convert]::FromBase64String("${b64}")
$needle = [System.Text.Encoding]::Unicode.GetString($bytes).ToLowerInvariant()
$script:found = $null
$callback = {
  param($hWnd, $lParam)
  if ([PetAgentAutomation.Native]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PetAgentAutomation.Native]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $t = $sb.ToString()
    if ($script:found -eq $null -and $t.ToLowerInvariant().Contains($needle)) {
      $script:found = @{ Handle = $hWnd; Title = $t }
    }
  }
  return $true
}
[PetAgentAutomation.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($script:found) {
  [PetAgentAutomation.Native]::SetForegroundWindow($script:found.Handle) | Out-Null
  Write-Output "FOUND:$($script:found.Title)"
} else {
  Write-Output "NOTFOUND"
}`
}

export function parseFocusWindowOutput(stdout: string): { found: true; title: string } | { found: false } {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  if (line.startsWith('FOUND:')) return { found: true, title: line.slice('FOUND:'.length) }
  return { found: false }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/automation/win32Bridge.test.ts`
Expected: PASS.

> Note for the implementer: this P/Invoke script is written to the best of available documentation (Win32 `INPUT`/`KEYBDINPUT` union layout, `SetProcessDpiAwarenessContext(-4)` = per-monitor-v2, `mouse_event` flag values). Its correctness beyond what these string-level tests check can only be confirmed by actually running `powershell.exe` on a real Windows machine (Task 6/14's manual verification) — if `SendInput`/`keybd_event` misbehave in practice, fix the script here and re-run this task's tests plus a real manual click/type/press check; don't treat this task as "done" until that manual check has actually passed once during Task 14's wiring.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/win32Bridge.ts src/main/automation/win32Bridge.test.ts
git commit -m "feat(automation): win32Bridge 纯脚本构造器(点击/打字/按键/枚举窗口/前台切换)"
```

---

## Task 6: `automationControl.ts` — injectable execFile wrapper

**Files:**
- Create: `src/main/automation/automationControl.ts`
- Create (test): `src/main/automation/automationControl.test.ts`

**Interfaces:**
- Consumes: `resolveKey` (Task 3), `buildClickScript`/`buildTypeTextScript`/`buildPressKeyScript`/`buildListWindowsScript`/`parseListWindowsOutput`/`buildFocusWindowScript`/`parseFocusWindowOutput` (Task 5).
- Produces: `AutomationControl { click(input): Promise<{ok:boolean; error?:string}>; typeText(text): Promise<{ok:boolean; error?:string}>; pressKey(key): Promise<{ok:boolean; error?:string}>; listWindows(): Promise<{ok:boolean; titles?:string[]; error?:string}>; focusWindow(titleContains): Promise<{ok:boolean; title?:string; error?:string}> }`, `createAutomationControl(opts: { execFile: (script: string) => Promise<{ stdout: string; stderr: string }> }): AutomationControl`.
- Consumes (Task 8): `desktopTools.ts` builds one real `AutomationControl` per app run and calls these methods from the tool `run()` bodies.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/automation/automationControl.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAutomationControl } from './automationControl'

function fakeExecFile(stdout: string, stderr = ''): (s: string) => Promise<{ stdout: string; stderr: string }> {
  return vi.fn(async () => ({ stdout, stderr }))
}

describe('createAutomationControl', () => {
  it('click 成功:execFile 收到脚本、返回 ok', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.click({ x: 10, y: 20, button: 'left', double: false })
    expect(r).toEqual({ ok: true })
    expect(execFile).toHaveBeenCalledTimes(1)
    expect((execFile as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('SetCursorPos(10, 20)')
  })

  it('click 失败:execFile 拒绝 → ok:false 带 error', async () => {
    const execFile = vi.fn(async () => { throw new Error('powershell 不存在') })
    const ac = createAutomationControl({ execFile })
    const r = await ac.click({ x: 1, y: 1, button: 'left', double: false })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('powershell 不存在')
  })

  it('typeText 超过 2000 字符直接拒绝,不调用 execFile', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.typeText('a'.repeat(2001))
    expect(r.ok).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('typeText 2000 字符以内正常执行', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.typeText('a'.repeat(2000))
    expect(r.ok).toBe(true)
  })

  it('pressKey 白名单外的键 → 拒绝,不调用 execFile', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.pressKey('Alt+F4')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Alt+F4')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('pressKey 白名单内正常执行', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.pressKey('Enter')
    expect(r.ok).toBe(true)
  })

  it('listWindows 解析多行标题', async () => {
    const execFile = fakeExecFile('记事本\r\n设置\r\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.listWindows()
    expect(r).toEqual({ ok: true, titles: ['记事本', '设置'] })
  })

  it('focusWindow 找到 → ok:true 带 title;找不到 → ok:false', async () => {
    const found = createAutomationControl({ execFile: fakeExecFile('FOUND:记事本\n') })
    expect(await found.focusWindow('记事')).toEqual({ ok: true, title: '记事本' })
    const notFound = createAutomationControl({ execFile: fakeExecFile('NOTFOUND\n') })
    const r = await notFound.focusWindow('不存在的窗口')
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/automation/automationControl.test.ts`
Expected: FAIL with "Cannot find module './automationControl'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/automationControl.ts
import { resolveKey, ALLOWED_KEY_NAMES } from './keyAllowlist'
import {
  buildClickScript, buildTypeTextScript, buildPressKeyScript,
  buildListWindowsScript, parseListWindowsOutput,
  buildFocusWindowScript, parseFocusWindowOutput
} from './win32Bridge'

export const MAX_TYPE_TEXT_LEN = 2000

export interface AutomationControl {
  click(input: { x: number; y: number; button: 'left' | 'right'; double: boolean }): Promise<{ ok: boolean; error?: string }>
  typeText(text: string): Promise<{ ok: boolean; error?: string }>
  pressKey(key: string): Promise<{ ok: boolean; error?: string }>
  listWindows(): Promise<{ ok: boolean; titles?: string[]; error?: string }>
  focusWindow(titleContains: string): Promise<{ ok: boolean; title?: string; error?: string }>
}

export function createAutomationControl(opts: {
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
}): AutomationControl {
  async function run(script: string): Promise<{ ok: boolean; stdout?: string; error?: string }> {
    try {
      const { stdout } = await opts.execFile(script)
      return { ok: true, stdout }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }

  return {
    async click(input) {
      const r = await run(buildClickScript(input.x, input.y, input.button, input.double))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async typeText(text) {
      if (text.length > MAX_TYPE_TEXT_LEN) return { ok: false, error: `打字内容过长(超过 ${MAX_TYPE_TEXT_LEN} 字符),请分批输入` }
      const r = await run(buildTypeTextScript(text))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async pressKey(key) {
      const vkCodes = resolveKey(key)
      if (!vkCodes) return { ok: false, error: `不支持的按键:${key}。可用:${ALLOWED_KEY_NAMES.join('、')}` }
      const r = await run(buildPressKeyScript(vkCodes))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async listWindows() {
      const r = await run(buildListWindowsScript())
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, titles: parseListWindowsOutput(r.stdout ?? '') }
    },
    async focusWindow(titleContains) {
      const r = await run(buildFocusWindowScript(titleContains))
      if (!r.ok) return { ok: false, error: r.error }
      const parsed = parseFocusWindowOutput(r.stdout ?? '')
      return parsed.found ? { ok: true, title: parsed.title } : { ok: false, error: `没找到标题包含"${titleContains}"的窗口` }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/automation/automationControl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/automationControl.ts src/main/automation/automationControl.test.ts
git commit -m "feat(automation): automationControl 可注入 execFile 的控制层(白名单+长度上限内建)"
```

---

## Task 7: `fullScreenCapture.ts` — screenshot capture (native)

**Files:**
- Create: `src/main/media/fullScreenCapture.ts`

**Interfaces:**
- Consumes: `prepareImage`/`MAX_EDGE` (`src/main/media/imagePrep.ts`, existing), `targetSize` (`src/main/media/imageResize.ts`, existing).
- Produces: `FullScreenShot { image: ImagePart; displayId: string; originX: number; originY: number; physicalWidth: number; physicalHeight: number; imageWidth: number; imageHeight: number }`, `captureFullScreen(display: Electron.Display): Promise<FullScreenShot>`.
- Consumes (Task 8): `desktopTools.ts`'s `take_screenshot` tool calls this, then feeds the returned metadata into `screenshotState.record()`.

This file `import`s `electron`, matching the existing `screenCapture.ts`/`imagePrep.ts` precedent — no Vitest coverage, verified by hand in Task 14/15.

- [ ] **Step 1: Implement**

```ts
// src/main/media/fullScreenCapture.ts
import { desktopCapturer, type Display } from 'electron'
import { prepareImage, MAX_EDGE } from './imagePrep'
import { targetSize } from './imageResize'
import type { ImagePart } from '@shared/llm'

export interface FullScreenShot {
  image: ImagePart
  displayId: string
  originX: number
  originY: number
  physicalWidth: number
  physicalHeight: number
  imageWidth: number
  imageHeight: number
}

/**
 * 截取指定显示器整屏(不弹覆盖层),复用 MVP-07 的 prepareImage 降采样管线。
 * 同时算出「物理分辨率 ↔ 降采样后分辨率 ↔ 显示器物理原点」三组数据,
 * 交给 screenshotState 供后续 click_at 坐标换算 —— 三个数字必须与
 * prepareImage 实际产出的图像分辨率一致,因此用同一个 targetSize() 算,
 * 不在这里重新发明一套缩放逻辑。
 */
export async function captureFullScreen(display: Display): Promise<FullScreenShot> {
  const scale = display.scaleFactor
  const physicalWidth = Math.round(display.size.width * scale)
  const physicalHeight = Math.round(display.size.height * scale)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physicalWidth, height: physicalHeight } })
  const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!src) throw new Error('截屏失败:未取到屏幕画面')
  const dims = targetSize(physicalWidth, physicalHeight, MAX_EDGE)
  const image = prepareImage({ mimeType: 'image/jpeg', dataBase64: src.thumbnail.toJPEG(85).toString('base64') })
  return {
    image,
    displayId: String(src.display_id),
    originX: Math.round(display.bounds.x * scale),
    originY: Math.round(display.bounds.y * scale),
    physicalWidth,
    physicalHeight,
    imageWidth: dims.width,
    imageHeight: dims.height
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (this file has no test; typecheck is the only automated signal until Task 14/15's manual verification).

- [ ] **Step 3: Commit**

```bash
git add src/main/media/fullScreenCapture.ts
git commit -m "feat(media): captureFullScreen 复用 imagePrep 管线截全屏(无覆盖层)"
```

---

## Task 8: `desktopTools.ts` — the six ToolSpecs

**Files:**
- Create: `src/main/tools/desktopTools.ts`
- Create (test): `src/main/tools/desktopTools.test.ts`

**Interfaces:**
- Consumes: `AutomationControl` (Task 6), `ScreenshotState` (Task 4), `FullScreenShot`/`captureFullScreen` (Task 7), `ToolSpec`/`ToolRunOutput` (Task 2).
- Produces: `createDesktopTools(opts: { platform: NodeJS.Platform; automation: AutomationControl; screenshotState: ScreenshotState; captureScreen: () => Promise<import('../media/fullScreenCapture').FullScreenShot> }): ToolSpec[]` — returns the six tools in a fixed order: `take_screenshot, list_windows, focus_window, click_at, type_text, press_key`.
- Consumes (Task 12): `chat.ts`'s `buildDesktopTools` closure calls `createDesktopTools` with real dependencies assembled in Task 14.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/tools/desktopTools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createDesktopTools } from './desktopTools'
import { createScreenshotState } from '../automation/screenshotState'
import type { AutomationControl } from '../automation/automationControl'

const ctx = { signal: new AbortController().signal }

function fakeAutomation(overrides: Partial<AutomationControl> = {}): AutomationControl {
  return {
    click: vi.fn(async () => ({ ok: true })),
    typeText: vi.fn(async () => ({ ok: true })),
    pressKey: vi.fn(async () => ({ ok: true })),
    listWindows: vi.fn(async () => ({ ok: true, titles: ['记事本'] })),
    focusWindow: vi.fn(async () => ({ ok: true, title: '记事本' })),
    ...overrides
  }
}

const fakeShot = {
  image: { mimeType: 'image/jpeg', dataBase64: 'AAA' },
  displayId: '1', originX: 0, originY: 0,
  physicalWidth: 1920, physicalHeight: 1080,
  imageWidth: 960, imageHeight: 540
}

function tools(overrides: Parameters<typeof createDesktopTools>[0] extends infer T ? Partial<T> : never = {}) {
  const screenshotState = createScreenshotState()
  const automation = fakeAutomation()
  const captureScreen = vi.fn(async () => fakeShot)
  const all = createDesktopTools({ platform: 'win32', automation, screenshotState, captureScreen, ...overrides })
  return { all, screenshotState, automation, captureScreen }
}

describe('createDesktopTools', () => {
  it('返回六个工具,名字固定', () => {
    const { all } = tools()
    expect(all.map((t) => t.name)).toEqual(['take_screenshot', 'list_windows', 'focus_window', 'click_at', 'type_text', 'press_key'])
  })

  it('非 Windows 平台:所有工具直接报错,不调用底层依赖', async () => {
    const automation = fakeAutomation()
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'darwin', automation, screenshotState: createScreenshotState(), captureScreen })
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    const r = await shotTool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('仅支持 Windows')
    expect(captureScreen).not.toHaveBeenCalled()
  })

  it('take_screenshot:返回 content+images,并记录 screenshotState', async () => {
    const { all, screenshotState } = tools()
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    const r = await shotTool.run({}, ctx)
    expect(typeof r).not.toBe('string')
    const out = r as { content: string; images?: unknown[] }
    expect(out.images).toEqual([fakeShot.image])
    expect(screenshotState.current()).not.toBeNull()
  })

  it('click_at:未先截屏时报错要求先截屏,不调用 automation.click', async () => {
    const { all, automation } = tools()
    const clickTool = all.find((t) => t.name === 'click_at')!
    const r = await clickTool.run({ x: 1, y: 1 }, ctx)
    const content = typeof r === 'string' ? r : r.content
    expect(content).toContain('先')
    expect(content).toContain('截屏')
    expect(automation.click).not.toHaveBeenCalled()
  })

  it('click_at:已截屏后按 screenshotState 换算坐标再点击', async () => {
    const { all, automation } = tools()
    const shotTool = all.find((t) => t.name === 'take_screenshot')!
    await shotTool.run({}, ctx)
    const clickTool = all.find((t) => t.name === 'click_at')!
    await clickTool.run({ x: 100, y: 50 }, ctx)
    expect(automation.click).toHaveBeenCalledWith({ x: 200, y: 100, button: 'left', double: false })
  })

  it('type_text:超过 2000 字符直接拒绝,不调用 automation.typeText', async () => {
    const { all, automation } = tools()
    const typeTool = all.find((t) => t.name === 'type_text')!
    const r = await typeTool.run({ text: 'a'.repeat(2001) }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('过长')
    expect(automation.typeText).not.toHaveBeenCalled()
  })

  it('press_key:automation 拒绝白名单外键时把错误原样回灌', async () => {
    const automation = fakeAutomation({ pressKey: vi.fn(async () => ({ ok: false, error: '不支持的按键:Alt+F4。可用:Enter、Tab' })) })
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'win32', automation, screenshotState: createScreenshotState(), captureScreen })
    const pressTool = all.find((t) => t.name === 'press_key')!
    const r = await pressTool.run({ key: 'Alt+F4' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('不支持的按键')
  })

  it('list_windows:把标题列表格式化为文本', async () => {
    const { all } = tools()
    const listTool = all.find((t) => t.name === 'list_windows')!
    const r = await listTool.run({}, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('记事本')
  })

  it('focus_window:找不到窗口时报错', async () => {
    const automation = fakeAutomation({ focusWindow: vi.fn(async () => ({ ok: false, error: '没找到标题包含"不存在"的窗口' })) })
    const captureScreen = vi.fn(async () => fakeShot)
    const all = createDesktopTools({ platform: 'win32', automation, screenshotState: createScreenshotState(), captureScreen })
    const focusTool = all.find((t) => t.name === 'focus_window')!
    const r = await focusTool.run({ titleContains: '不存在' }, ctx)
    expect(typeof r === 'string' ? r : r.content).toContain('没找到')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/tools/desktopTools.test.ts`
Expected: FAIL with "Cannot find module './desktopTools'".

- [ ] **Step 3: Implement**

```ts
// src/main/tools/desktopTools.ts
import type { ToolSpec } from './toolSpec'
import type { AutomationControl } from '../automation/automationControl'
import type { ScreenshotState } from '../automation/screenshotState'
import type { FullScreenShot } from '../media/fullScreenCapture'
import { ALLOWED_KEY_NAMES } from '../automation/keyAllowlist'

export const MAX_TYPE_TEXT_LEN = 2000
const NOT_WINDOWS_ERROR = '此功能仅支持 Windows'

export function createDesktopTools(opts: {
  platform: NodeJS.Platform
  automation: AutomationControl
  screenshotState: ScreenshotState
  captureScreen: () => Promise<FullScreenShot>
}): ToolSpec[] {
  const isWindows = opts.platform === 'win32'

  const takeScreenshot: ToolSpec = {
    name: 'take_screenshot',
    description: '截取当前屏幕(光标所在显示器)的画面,用于查看屏幕上的内容。点击/操作前必须先调用这个工具看清当前画面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const shot = await opts.captureScreen()
      opts.screenshotState.record({
        displayId: shot.displayId, originX: shot.originX, originY: shot.originY,
        physicalWidth: shot.physicalWidth, physicalHeight: shot.physicalHeight,
        imageWidth: shot.imageWidth, imageHeight: shot.imageHeight
      })
      return { content: `已截屏,图像分辨率 ${shot.imageWidth}x${shot.imageHeight}(click_at 的坐标请以此图像为基准)`, images: [shot.image] }
    }
  }

  const listWindows: ToolSpec = {
    name: 'list_windows',
    description: '列出当前所有可见窗口的标题,用于查找要操作的目标应用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const r = await opts.automation.listWindows()
      if (!r.ok) return `列出窗口失败:${r.error}`
      if (!r.titles || r.titles.length === 0) return '当前没有可见窗口'
      return `当前可见窗口:\n${r.titles.map((t) => `- ${t}`).join('\n')}`
    }
  }

  const focusWindow: ToolSpec = {
    name: 'focus_window',
    description: '把标题包含指定文字的窗口切换到前台,便于接下来对它截屏/点击/输入。',
    inputSchema: { type: 'object', properties: { titleContains: { type: 'string' } }, required: ['titleContains'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { titleContains } = input as { titleContains: string }
      const r = await opts.automation.focusWindow(titleContains)
      return r.ok ? `已切换到窗口:${r.title}` : `切换窗口失败:${r.error}`
    }
  }

  const clickAt: ToolSpec = {
    name: 'click_at',
    description: '在最近一次 take_screenshot 返回的图像坐标系里点击指定位置。调用前必须已经调用过 take_screenshot,否则会报错。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string' }, double: { type: 'boolean' }
      },
      required: ['x', 'y']
    },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { x, y, button, double } = input as { x: number; y: number; button?: 'left' | 'right'; double?: boolean }
      const point = opts.screenshotState.toPhysicalPoint(x, y)
      if (!point) return '还没有截屏记录,请先调用 take_screenshot 再点击'
      const r = await opts.automation.click({ x: point.x, y: point.y, button: button ?? 'left', double: double ?? false })
      return r.ok ? `已点击(${button === 'right' ? '右键' : '左键'}${double ? '双击' : ''})` : `点击失败:${r.error}`
    }
  }

  const typeText: ToolSpec = {
    name: 'type_text',
    description: `向当前焦点控件输入文字(最多 ${MAX_TYPE_TEXT_LEN} 字符),输入前请确保通过 click_at 已经点中目标输入框。`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { text } = input as { text: string }
      if (text.length > MAX_TYPE_TEXT_LEN) return `打字内容过长(超过 ${MAX_TYPE_TEXT_LEN} 字符),请分批输入`
      const r = await opts.automation.typeText(text)
      return r.ok ? '已输入文字' : `输入失败:${r.error}`
    }
  }

  const pressKey: ToolSpec = {
    name: 'press_key',
    description: `按下一个键或组合键,仅支持:${ALLOWED_KEY_NAMES.join('、')}。`,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async (input) => {
      if (!isWindows) return NOT_WINDOWS_ERROR
      const { key } = input as { key: string }
      const r = await opts.automation.pressKey(key)
      return r.ok ? `已按下:${key}` : `按键失败:${r.error}`
    }
  }

  return [takeScreenshot, listWindows, focusWindow, clickAt, typeText, pressKey]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/tools/desktopTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/desktopTools.ts src/main/tools/desktopTools.test.ts
git commit -m "feat(tools): 六个桌面控制 ToolSpec(截屏/枚举窗口/前台切换/点击/打字/按键)"
```

---

## Task 9: `toolIndicatorGate.ts` — indicator show/hide gating

**Files:**
- Create: `src/main/automation/toolIndicatorGate.ts`
- Create (test): `src/main/automation/toolIndicatorGate.test.ts`

**Interfaces:**
- Produces: `IndicatorGate { onToolStart(): void; onToolEnd(): void }`, `createIndicatorGate(show: () => void, hide: () => void): IndicatorGate`, `wrapToolsWithGate(tools: ToolSpec[], gate: IndicatorGate): ToolSpec[]`.
- Consumes (Task 12/14): `chat.ts`'s `wrapDesktopTools` closure (built in Task 14 with the real indicator) is `(tools) => wrapToolsWithGate(tools, createIndicatorGate(indicator.show, indicator.hide))`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/automation/toolIndicatorGate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createIndicatorGate, wrapToolsWithGate } from './toolIndicatorGate'
import type { ToolSpec } from '../tools/toolSpec'

describe('createIndicatorGate', () => {
  it('第一次 onToolStart 才调用 show,之后嵌套的 start 不重复调用', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolStart()
    gate.onToolStart()
    expect(show).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
  })

  it('计数归零才调用 hide', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolStart()
    gate.onToolStart()
    gate.onToolEnd()
    expect(hide).not.toHaveBeenCalled()
    gate.onToolEnd()
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('onToolEnd 多于 onToolStart 不会计数为负 / 不重复 hide', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolEnd()
    gate.onToolEnd()
    expect(hide).not.toHaveBeenCalled() // 从未 start 过,不该 hide
  })
})

describe('wrapToolsWithGate', () => {
  const ctx = { signal: new AbortController().signal }
  function makeTool(name: string, impl: () => Promise<string>): ToolSpec {
    return { name, description: 'd', inputSchema: { type: 'object', properties: {}, required: [] }, run: impl }
  }

  it('run 成功:start 在调用前、end 在调用后', async () => {
    const calls: string[] = []
    const show = vi.fn(() => calls.push('show')); const hide = vi.fn(() => calls.push('hide'))
    const gate = createIndicatorGate(show, hide)
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { calls.push('run'); return 'ok' })], gate)
    await wrapped.run({}, ctx)
    expect(calls).toEqual(['show', 'run', 'hide'])
  })

  it('run 抛错:end(hide)在 finally 里仍然执行', async () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { throw new Error('boom') })], gate)
    await expect(wrapped.run({}, ctx)).rejects.toThrow('boom')
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('两个包裹后的工具共享同一个 gate:并发执行时中途不会提前 hide', async () => {
    const calls: string[] = []
    const show = vi.fn(() => calls.push('show')); const hide = vi.fn(() => calls.push('hide'))
    const gate = createIndicatorGate(show, hide)
    let resolveA: () => void = () => {}
    const a = makeTool('a', () => new Promise((r) => { resolveA = () => r('a-done') }))
    const b = makeTool('b', async () => 'b-done')
    const [wrappedA, wrappedB] = wrapToolsWithGate([a, b], gate)
    const pA = wrappedA.run({}, ctx)
    await wrappedB.run({}, ctx) // b 先完成,但 a 还在跑
    expect(hide).not.toHaveBeenCalled()
    resolveA()
    await pA
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/automation/toolIndicatorGate.test.ts`
Expected: FAIL with "Cannot find module './toolIndicatorGate'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/toolIndicatorGate.ts
import type { ToolSpec } from '../tools/toolSpec'

export interface IndicatorGate { onToolStart(): void; onToolEnd(): void }

/** 引用计数:多个桌面控制工具在同一轮里前后/交替执行时,只在"从 0 到 1"显示、"回到 0"才隐藏,避免闪烁。 */
export function createIndicatorGate(show: () => void, hide: () => void): IndicatorGate {
  let active = 0
  return {
    onToolStart() {
      active++
      if (active === 1) show()
    },
    onToolEnd() {
      if (active === 0) return
      active--
      if (active === 0) hide()
    }
  }
}

export function wrapToolsWithGate(tools: ToolSpec[], gate: IndicatorGate): ToolSpec[] {
  return tools.map((t) => ({
    ...t,
    run: async (input, ctx) => {
      gate.onToolStart()
      try {
        return await t.run(input, ctx)
      } finally {
        gate.onToolEnd()
      }
    }
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/automation/toolIndicatorGate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/toolIndicatorGate.ts src/main/automation/toolIndicatorGate.test.ts
git commit -m "feat(automation): toolIndicatorGate 引用计数式指示器显隐门控"
```

---

## Task 10: `controlIndicator.ts` — the "宠物名 正在控制鼠标" overlay

**Files:**
- Create: `src/main/shell/controlIndicator.ts`
- Create (test): `src/main/shell/controlIndicator.test.ts`

**Interfaces:**
- Produces: `escapeHtml(s: string): string`, `buildIndicatorHtml(petDisplayName: string): string` (pure, tested), `ControlIndicator { show(): void; hide(): void }`, `createControlIndicator(petDisplayName: string): ControlIndicator` (native, not tested — verified by hand).
- Consumes (Task 14): `shell/index.ts` calls `createControlIndicator(petDisplayName)` once at startup with the `displayName` loaded via `loadPet(petDir)`, then wires `.show`/`.hide` into the `IndicatorGate` from Task 9.

- [ ] **Step 1: Write the failing test (for the pure part only)**

```ts
// src/main/shell/controlIndicator.test.ts
import { describe, it, expect } from 'vitest'
import { buildIndicatorHtml, escapeHtml } from './controlIndicator'

describe('escapeHtml', () => {
  it('转义 < > & "', () => {
    expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;')
  })
})

describe('buildIndicatorHtml', () => {
  it('包含宠物名 + 固定文案,不是 "AI"', () => {
    const html = buildIndicatorHtml('露露卡')
    expect(html).toContain('露露卡 正在控制鼠标')
    expect(html).not.toContain('AI 正在控制鼠标')
  })

  it('宠物 displayName 里的 HTML 特殊字符被转义(防止恶意宠物包注入)', () => {
    const html = buildIndicatorHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/shell/controlIndicator.test.ts`
Expected: FAIL with "Cannot find module './controlIndicator'".

- [ ] **Step 3: Implement**

```ts
// src/main/shell/controlIndicator.ts
import { BrowserWindow, screen } from 'electron'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildIndicatorHtml(petDisplayName: string): string {
  const safe = escapeHtml(petDisplayName)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:system-ui,sans-serif}
#badge{display:flex;align-items:center;justify-content:center;gap:8px;height:100%;box-sizing:border-box;
  background:rgba(120,60,200,0.92);color:#fff;font-size:13px;border-radius:10px;
  box-shadow:0 2px 10px rgba(0,0,0,0.25)}
</style></head><body><div id="badge">🖱️ ${safe} 正在控制鼠标</div></body></html>`
}

export interface ControlIndicator { show(): void; hide(): void }

const WIDTH = 260
const HEIGHT = 34

/**
 * 置顶、鼠标穿透的静态提示条:执行期间告知用户"宠物在控制鼠标",而非笼统的"AI"。
 * 文案在创建时一次性烘焙进 data: URL(应用生命周期内宠物名不会变),无需 preload/IPC。
 * import electron,不可单测,靠 Task 14/15 真机验收。
 */
export function createControlIndicator(petDisplayName: string): ControlIndicator {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, x: 0, y: 0,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildIndicatorHtml(petDisplayName))}`)

  return {
    show(): void {
      const d = screen.getPrimaryDisplay()
      win.setBounds({
        x: Math.round(d.bounds.x + d.bounds.width / 2 - WIDTH / 2),
        y: d.bounds.y + 8,
        width: WIDTH, height: HEIGHT
      })
      win.showInactive()
    },
    hide(): void { win.hide() }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/shell/controlIndicator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/controlIndicator.ts src/main/shell/controlIndicator.test.ts
git commit -m "feat(shell): controlIndicator 悬浮提示条(宠物名+正在控制鼠标)"
```

---

## Task 11: `manualOverrideWatch.ts` — human-grabs-the-mouse safety net

**Files:**
- Create: `src/main/automation/manualOverrideWatch.ts`
- Create (test): `src/main/automation/manualOverrideWatch.test.ts`

**Interfaces:**
- Produces: `hasManualOverride(aiPos, currentPos, thresholdPx): boolean` (pure), `createLastAiPosTracker(): { set(p): void; get(): {x,y}|null }` (pure), `ManualOverrideWatch { stop(): void }`, `startManualOverrideWatch(opts: { getCursorPos: () => {x,y}; getLastAiPos: () => {x,y}|null; thresholdPx?: number; intervalMs?: number; onOverride: () => void; setTimer?: (fn, ms) => unknown; clearTimer?: (h) => void }): ManualOverrideWatch`.
- Consumes (Task 14): `shell/index.ts` calls `createLastAiPosTracker()` once, wraps `automationControl.click` so it calls `.set(point)` right before delegating (see Task 14 Step 3), and calls `startManualOverrideWatch` with real `screen.getCursorScreenPoint` + `cancel()` as `onOverride`, started/stopped alongside the indicator gate.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/automation/manualOverrideWatch.test.ts
import { describe, it, expect, vi } from 'vitest'
import { hasManualOverride, createLastAiPosTracker, startManualOverrideWatch } from './manualOverrideWatch'

describe('hasManualOverride', () => {
  it('距离在阈值内 → false', () => {
    expect(hasManualOverride({ x: 100, y: 100 }, { x: 110, y: 100 }, 40)).toBe(false)
  })
  it('距离超过阈值 → true', () => {
    expect(hasManualOverride({ x: 100, y: 100 }, { x: 200, y: 100 }, 40)).toBe(true)
  })
  it('对角线距离用欧氏距离,不是曼哈顿距离', () => {
    // dx=30, dy=30 → 欧氏距离≈42.4 > 40阈值,但曼哈顿距离60也>40,换一组能区分的:
    expect(hasManualOverride({ x: 0, y: 0 }, { x: 28, y: 28 }, 40)).toBe(false) // 欧氏≈39.6 < 40
  })
})

describe('createLastAiPosTracker', () => {
  it('未 set 时 get() 为 null;set 后能读回', () => {
    const t = createLastAiPosTracker()
    expect(t.get()).toBeNull()
    t.set({ x: 5, y: 6 })
    expect(t.get()).toEqual({ x: 5, y: 6 })
  })
})

describe('startManualOverrideWatch', () => {
  function fakeTimer() {
    let cb: (() => void) | null = null
    return {
      setTimer: (fn: () => void) => { cb = fn; return 'handle' },
      clearTimer: () => { cb = null },
      fire: () => cb?.()
    }
  }

  it('光标偏离超过阈值 → 触发 onOverride 且只触发一次', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    let cursor = { x: 100, y: 100 }
    startManualOverrideWatch({
      getCursorPos: () => cursor,
      getLastAiPos: () => ({ x: 100, y: 100 }),
      thresholdPx: 40,
      onOverride,
      setTimer, clearTimer
    })
    fire() // 未偏离
    expect(onOverride).not.toHaveBeenCalled()
    cursor = { x: 300, y: 100 }
    fire() // 偏离
    expect(onOverride).toHaveBeenCalledTimes(1)
    fire() // 已停止,不再重复触发
    expect(onOverride).toHaveBeenCalledTimes(1)
  })

  it('尚未有 lastAiPos(AI 还没点过)时不触发', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    startManualOverrideWatch({
      getCursorPos: () => ({ x: 999, y: 999 }),
      getLastAiPos: () => null,
      onOverride,
      setTimer, clearTimer
    })
    fire()
    expect(onOverride).not.toHaveBeenCalled()
  })

  it('stop() 后不再触发', () => {
    const { setTimer, clearTimer, fire } = fakeTimer()
    const onOverride = vi.fn()
    const watch = startManualOverrideWatch({
      getCursorPos: () => ({ x: 500, y: 500 }),
      getLastAiPos: () => ({ x: 0, y: 0 }),
      onOverride,
      setTimer, clearTimer
    })
    watch.stop()
    fire()
    expect(onOverride).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/automation/manualOverrideWatch.test.ts`
Expected: FAIL with "Cannot find module './manualOverrideWatch'".

- [ ] **Step 3: Implement**

```ts
// src/main/automation/manualOverrideWatch.ts

export function hasManualOverride(
  aiPos: { x: number; y: number },
  currentPos: { x: number; y: number },
  thresholdPx: number
): boolean {
  const dx = currentPos.x - aiPos.x
  const dy = currentPos.y - aiPos.y
  return Math.sqrt(dx * dx + dy * dy) > thresholdPx
}

export interface LastAiPosTracker { set(p: { x: number; y: number }): void; get(): { x: number; y: number } | null }

export function createLastAiPosTracker(): LastAiPosTracker {
  let pos: { x: number; y: number } | null = null
  return { set: (p) => { pos = p }, get: () => pos }
}

export interface ManualOverrideWatch { stop(): void }

/**
 * 轮询真实光标位置;若与"AI 最近一次设置的光标位置"偏差超过阈值(意味着人已经
 * 用手抓住了鼠标),立即触发 onOverride(调用方接 cancel())。定时器可注入以便单测。
 */
export function startManualOverrideWatch(opts: {
  getCursorPos: () => { x: number; y: number }
  getLastAiPos: () => { x: number; y: number } | null
  thresholdPx?: number
  intervalMs?: number
  onOverride: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}): ManualOverrideWatch {
  const threshold = opts.thresholdPx ?? 40
  const interval = opts.intervalMs ?? 250
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout))
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    const last = opts.getLastAiPos()
    if (!last) return
    const cur = opts.getCursorPos()
    if (hasManualOverride(last, cur, threshold)) {
      stopped = true
      clearTimer(handle)
      opts.onOverride()
    }
  }
  const handle = setTimer(tick, interval)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearTimer(handle)
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/automation/manualOverrideWatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/automation/manualOverrideWatch.ts src/main/automation/manualOverrideWatch.test.ts
git commit -m "feat(automation): 人工接管鼠标即中断的安全网(可注入轮询)"
```

---

## Task 12: Wire tools into `chat.ts`

**Files:**
- Modify: `src/main/shell/chat.ts`
- Modify (test): `src/main/shell/chat.test.ts`

**Interfaces:**
- Consumes: `ToolSpec` (Task 2/8).
- Produces: `createChatStore` gains two new optional injected options: `buildDesktopTools?: () => ToolSpec[]`, `wrapDesktopTools?: (tools: ToolSpec[]) => ToolSpec[]`.
- Consumes (Task 14): `shell/index.ts` passes real closures for both; when omitted (as in most existing/unit tests), desktop-control tools are simply never added, regardless of `settings.desktopControl.enabled`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/shell/chat.test.ts`. First extend the `makeStore` helper's options (near its existing `getFirecrawlKey` etc.) to accept and forward the two new optional params:

```ts
function makeStore(
  provider: LlmProvider,
  seen: StreamChatRequest[],
  clip?: { readText?: () => string; writeText?: (t: string) => void },
  desktop?: { buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]; wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[] }
) {
  // ...unchanged body...
  const store = createChatStore({
    // ...unchanged fields...
    buildDesktopTools: desktop?.buildDesktopTools,
    wrapDesktopTools: desktop?.wrapDesktopTools,
    // ...
  })
  return { store, memory, finished, written }
}
```

Then add a new describe block:

```ts
describe('desktopControl 工具挂载与轮数上限', () => {
  function fakeDesktopTool(name: string): import('../tools/toolSpec').ToolSpec {
    return { name, description: 'd', inputSchema: { type: 'object', properties: {}, required: [] }, run: async () => 'ok' }
  }

  it('desktopControl 关闭时不挂载,即便注入了 buildDesktopTools', async () => {
    settings.desktopControl = { enabled: false }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).not.toContain('take_screenshot')
  })

  it('desktopControl 开启时挂载 buildDesktopTools 返回的工具,并经过 wrapDesktopTools', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    let wrapped = false
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')],
      wrapDesktopTools: (tools) => { wrapped = true; return tools }
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).toContain('take_screenshot')
    expect(wrapped).toBe(true)
    settings.desktopControl = { enabled: false } // 复位
  })

  it('desktopControl 开启时轮数上限提升到 20,超过 6 轮的工具循环仍能继续', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    const script = Array.from({ length: 10 }, (_, i) => [
      { type: 'tool_use' as const, toolUse: { id: `t${i}`, name: 'take_screenshot', input: {} } }
    ])
    script.push([{ type: 'text' as const, text: '看完了' }, { type: 'done' as const }])
    const { store, finished } = makeStore(createFakeProvider({ script }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: '帮我看看屏幕' })
    await finished
    const petMsgs = store.messages().filter((m) => m.role === 'pet')
    expect(petMsgs[petMsgs.length - 1]?.text).toBe('看完了') // 未被"轮数上限"错误打断
    settings.desktopControl = { enabled: false } // 复位
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: FAIL — `buildDesktopTools`/`wrapDesktopTools` not recognized options, tools not mounted, round cap still 6.

- [ ] **Step 3: Implement**

In `src/main/shell/chat.ts`, extend `createChatStore`'s options type:

```ts
export function createChatStore(opts: {
  petDir: string
  skills: SkillIndex
  memory: MemoryManager
  todoStore: TodoStore
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  getFirecrawlKey: () => string | null
  /** 桌面控制六个工具的真实构造器;未注入(如多数既有测试)则该能力永不出现,与 settings 开关无关 */
  buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]
  /** 给桌面控制工具套上指示器显隐等生命周期钩子;省略则原样返回 */
  wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[]
  makeProvider?: (provider: ProviderSettings, key: string) => LlmProvider
  prepareImages: (attachments: ChatSendAttachment[]) => ImagePart[]
  clipboard: { readText: () => string; writeText: (t: string) => void }
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushStatus: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
}): ChatStore {
```

In `handleSend`, right after the existing firecrawl conditional push (before `const registry = createToolRegistry(tools)`):

```ts
      if (settings.desktopControl.enabled && opts.buildDesktopTools) {
        const wrap = opts.wrapDesktopTools ?? ((t: typeof tools) => t)
        tools.push(...wrap(opts.buildDesktopTools()))
      }
      const registry = createToolRegistry(tools)
```

And change the `runAgent` call to pass a higher round cap when desktop control is on:

```ts
        const res = await runAgent({
          provider,
          system,
          messages,
          registry,
          maxToolRounds: settings.desktopControl.enabled ? 20 : undefined,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          signal: ctrl.signal,
          onText: (t) => { acc += t; opts.pushStream(t) },
          onStatus: (t) => opts.pushStatus(t)
        })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Full regression**

Run: `pnpm test && pnpm typecheck`
Expected: all green — existing callers of `createChatStore` (shell/index.ts, at this point in the plan) don't pass the two new options yet, which is fine since they're optional.

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/chat.test.ts
git commit -m "feat(chat): 按 desktopControl 开关条件挂载桌面控制工具 + 轮数上限提升到 20"
```

---

## Task 13: Settings IPC + confirm dialog + UI

> Ordered before Task 14 on purpose: Task 14 (shell/index.ts wiring) uses `IPC.CONFIRM_DESKTOP_CONTROL`, so the channel and its main-process handler must exist first.

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/shell/index.ts` (just the new IPC handler — the rest of that file's wiring is Task 14)
- Modify: `src/renderer/settings.ts`
- Modify: `src/renderer/settings.html`

**Interfaces:**
- Produces: `IPC.CONFIRM_DESKTOP_CONTROL = 'settings:confirm-desktop-control'`, `SettingsApi.confirmDesktopControl(): Promise<boolean>`, a working `ipcMain.handle(IPC.CONFIRM_DESKTOP_CONTROL, ...)` in `shell/index.ts`.
- Consumes: Task 1's `AppSettings.desktopControl`.
- Consumes (Task 14): the shell wiring task assumes this channel/handler already exists; it does not touch it again.

- [ ] **Step 1: Add the IPC channel + type**

In `src/shared/ipc.ts`, add to the `IPC` const (after `SET_FIRECRAWL_KEY`):

```ts
  CONFIRM_DESKTOP_CONTROL: 'settings:confirm-desktop-control',
```

Add to `SettingsApi`:

```ts
export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  setFirecrawlKey(key: string): Promise<boolean>
  confirmDesktopControl(): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
  listPets(): Promise<PetSummary[]>
  importPet(): Promise<ImportResult | null>
  relaunch(): void
}
```

- [ ] **Step 2: Wire the preload**

In `src/preload/index.ts`, add to `settingsApi`:

```ts
  setFirecrawlKey: (key: string) => ipcRenderer.invoke(IPC.SET_FIRECRAWL_KEY, key),
  confirmDesktopControl: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_DESKTOP_CONTROL),
```

(insert the new line right after the existing `setFirecrawlKey` line, keeping the rest of `settingsApi` unchanged.)

- [ ] **Step 3: Add the main-process confirm-dialog handler**

In `src/main/shell/index.ts`, add `BrowserWindow` to the top-level `electron` import (it's currently only referenced as `type Tray`'s sibling module, not imported as a value):

```ts
import { app, ipcMain, safeStorage, screen, shell as electronShell, dialog as electronDialog, clipboard, Notification, BrowserWindow, type Tray } from 'electron'
```

Then, near the other `ipcMain.handle(IPC.SET_*...)` handlers (right after the existing `SET_FIRECRAWL_KEY` handler), add:

```ts
  ipcMain.handle(IPC.CONFIRM_DESKTOP_CONTROL, async (): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await electronDialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['取消', '确认开启'],
      defaultId: 0,
      cancelId: 0,
      title: '开启桌面控制风险提示',
      message: '开启后,AI 可以在对话中自主截屏(屏幕内容会发送给你配置的模型服务商)、控制鼠标点击与键盘输入。',
      detail: '可能造成误操作或截取到敏感信息;开启后随时可在设置里再次关闭。'
    })
    return result.response === 1
  })
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Add the settings-window HTML section**

In `src/renderer/settings.html`, inside `<section class="page" data-page="tools">`, after the Firecrawl `firecrawlBaseRow` label, add a visually-separated block:

```html
            <div style="margin-top:14px;padding:10px;border:1px solid rgba(255,140,140,0.5);border-radius:8px;background:rgba(255,80,80,0.08)">
              <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
                <input id="desktopControlEnabled" type="checkbox" style="width:auto" />
                <span>允许宠物自主截屏与控制鼠标/键盘(高风险)</span>
              </label>
              <div class="hint" style="margin-top:6px">
                开启后 AI 可能在对话中截屏(屏幕内容会发给你配置的模型服务商)、控制鼠标点击与键盘输入,
                可能造成误操作或截取到敏感信息。默认关闭,开启前会再次弹窗确认。
              </div>
            </div>
```

- [ ] **Step 6: Wire the renderer script**

In `src/renderer/settings.ts`, add the element reference near the other checkboxes (after `firecrawlBaseRow`):

```ts
const desktopControlEnabled = $<HTMLInputElement>('desktopControlEnabled')
```

Add the confirm-on-enable behavior (after the existing `firecrawlEnabled.addEventListener('change', syncFirecrawlRows)` line):

```ts
desktopControlEnabled.addEventListener('change', () => {
  if (!desktopControlEnabled.checked) return
  void (async () => {
    const confirmed = await window.settingsApi.confirmDesktopControl()
    if (!confirmed) desktopControlEnabled.checked = false
  })()
})
```

Add `desktopControl` to the `save` handler's `setSettings` payload (inside the object passed to `window.settingsApi.setSettings`, right after `firecrawl: {...}`):

```ts
      firecrawl: {
        enabled: firecrawlEnabled.checked,
        baseURL: firecrawlBaseURL.value.trim() || undefined
      },
      desktopControl: { enabled: desktopControlEnabled.checked }
```

Add the init-time readback (in the closing `void (async () => {...})()` block, after `syncFirecrawlRows()`):

```ts
  desktopControlEnabled.checked = snap.settings.desktopControl.enabled
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run: `pnpm build && pnpm preview`. Open 设置 → 工具能力 → confirm: the new red-bordered box appears below Firecrawl; checking it pops the native confirm dialog; canceling leaves it unchecked; confirming + Save persists across a settings-window reopen (and across an app restart).

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts src/renderer/settings.ts src/renderer/settings.html
git commit -m "feat(settings-ui): 桌面控制开关 + 开启前风险确认弹窗(含主进程确认弹窗 handler)"
```

---

## Task 14: Assemble automation wiring in `shell/index.ts`

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–12 (`createAutomationControl`, `createScreenshotState`, `captureFullScreen`, `createDesktopTools`, `createControlIndicator`, `createIndicatorGate`/`wrapToolsWithGate`, `createLastAiPosTracker`/`startManualOverrideWatch`, `createChatStore`'s new options) plus Task 13's already-existing `IPC.CONFIRM_DESKTOP_CONTROL` handler (not touched again here).
- Produces: fully-wired production behavior; no new exported interfaces (this is the integration point).

This task is native/integration wiring — no new automated test (the pieces it wires were each tested in isolation in Tasks 3–12). Verify by hand per the checklist at the end of this task and in Task 15.

- [ ] **Step 1: Add the imports**

At the top of `src/main/shell/index.ts`, alongside the existing imports:

```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createAutomationControl } from '../automation/automationControl'
import { createScreenshotState } from '../automation/screenshotState'
import { captureFullScreen } from '../media/fullScreenCapture'
import { createDesktopTools } from '../tools/desktopTools'
import { createControlIndicator } from './controlIndicator'
import { createIndicatorGate, wrapToolsWithGate } from '../automation/toolIndicatorGate'
import { createLastAiPosTracker, startManualOverrideWatch } from '../automation/manualOverrideWatch'
```

`screen` is already destructured from the top-level `import { app, ipcMain, safeStorage, screen, ... } from 'electron'` in this file (and `BrowserWindow` was added to that same import in Task 13) — reuse both, don't add duplicate imports for either.

- [ ] **Step 2: Build the real `AutomationControl` + indicator + override watch**

Insert this block right before the existing `const chat = createChatStore({` line — declare `manualOverrideWatch` first since the indicator-gate callbacks below close over it:

```ts
  const execFileP = promisify(execFileCb)
  const automationControl = createAutomationControl({
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).then((r) => ({ stdout: r.stdout, stderr: r.stderr }))
  })

  let petDisplayName = '宠物'
  void loadPet(petDir).then((p) => { petDisplayName = p.manifest.displayName }).catch(() => {})
  const controlIndicator = createControlIndicator(petDisplayName)
  // 注意:petDisplayName 在上面异步赋值前,createControlIndicator 已经用初值 '宠物' 烘焙好了 HTML —— 这是可接受的
  // 时序缝隙(indicator 只在真正调用桌面控制工具时才 show(),而 loadPet 是应用启动时就发起的,
  // 实际到第一次 show() 时 loadPet 早已 resolve)。若真机验收发现极端早期调用露出了默认名,
  // 把 createControlIndicator 的调用挪到 loadPet(petDir).then(...) 回调里即可,是可选的加固。

  const lastAiPos = createLastAiPosTracker()
  let manualOverrideWatch: ReturnType<typeof startManualOverrideWatch> | null = null
  const indicatorGate = createIndicatorGate(
    () => {
      controlIndicator.show()
      manualOverrideWatch = startManualOverrideWatch({
        getCursorPos: () => {
          const p = screen.getCursorScreenPoint()
          const d = screen.getDisplayNearestPoint(p)
          return { x: Math.round(p.x * d.scaleFactor), y: Math.round(p.y * d.scaleFactor) }
        },
        getLastAiPos: () => lastAiPos.get(),
        onOverride: () => { chat.cancel() }
      })
    },
    () => {
      controlIndicator.hide()
      manualOverrideWatch?.stop()
      manualOverrideWatch = null
    }
  )
```

> The `getCursorPos` closure converts Electron's `screen.getCursorScreenPoint()` (logical/DIP coordinates) to physical pixels via the nearest display's `scaleFactor`, matching the physical-pixel coordinate space `screenshotState`/`automationControl.click` already work in (see Task 4/7). This is exactly the class of DPI mismatch this project has hit before (see `electron-isvisible-setresizable-drift` in the project's engineering memory) — don't skip the multiplication.

> `onOverride: () => { chat.cancel() }` references `chat`, which is declared a few lines below via `const chat = createChatStore(...)` (Step 3). This is valid: the callback isn't invoked until a real manual-override event fires, long after `chat` has been assigned — but it does mean this block must stay textually *before* the `const chat = ...` declaration, not after.

- [ ] **Step 3: Record `lastAiPos` on every click**

`click_at`'s tool body (Task 8) doesn't know about `lastAiPos` — it's a shell-layer concern, not a tool-layer one. Wrap `automationControl` with a thin decorator that records the click point before delegating, still before the `const chat = createChatStore({` line:

```ts
  const automationWithTracking = {
    ...automationControl,
    click: async (input: Parameters<typeof automationControl.click>[0]) => {
      lastAiPos.set({ x: input.x, y: input.y })
      return automationControl.click(input)
    }
  }
```

- [ ] **Step 4: Pass `buildDesktopTools`/`wrapDesktopTools` into `createChatStore`**

Add two fields to the existing `createChatStore({...})` call:

```ts
  const chat = createChatStore({
    petDir,
    skills,
    memory,
    todoStore,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    getSearchKey: () => searchSecrets.getKey(),
    getFirecrawlKey: () => firecrawlSecrets.getKey(),
    buildDesktopTools: () => createDesktopTools({
      platform: process.platform,
      automation: automationWithTracking,
      screenshotState: createScreenshotState(), // 每次 handleSend 都是全新一个 —— 每轮对话自然重置
      captureScreen: () => captureFullScreen(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    }),
    wrapDesktopTools: (tools) => wrapToolsWithGate(tools, indicatorGate),
    prepareImages: (atts) => atts.map((a) => prepareImage(a)),
    clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs),
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
    openSettings: () => openSettings()
  })
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification (native — no automated test covers this task)**

Run: `pnpm build && pnpm preview`. With `desktopControl.enabled` turned on via the Task 13 settings UI, open the chat and ask "帮我截个屏看看现在屏幕上是什么" — confirm:
- an image comes back and the pet describes it,
- asking it to click something shows the "`<宠物名>` 正在控制鼠标" badge at the top of the primary display while it's clicking, and it disappears right after,
- grabbing the mouse yourself mid-automation cancels the run.

- [ ] **Step 7: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 接线桌面控制真实依赖(execFile/截屏/指示器/人工接管安全网)"
```

---

## Task 15: Full regression + manual acceptance pass

**Files:** none (verification-only task).

- [ ] **Step 1: Full automated suite**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all green, three bundles build.

- [ ] **Step 2: Manual acceptance checklist (spec §6)**

With `pnpm build && pnpm preview` running, walk through every item — do not check this task done until each has actually been observed once:

- [ ] Default off: with a fresh settings file (or `desktopControl.enabled: false`), ask the pet to do something requiring screen control — it has no such tool available (no screenshot/click happens).
- [ ] Enable flow: check the box → confirm dialog appears → Cancel → box reverts to unchecked. Check again → Confirm → Save → reopen settings window → still checked. Restart the app → still checked.
- [ ] Chat-triggered screenshot: "帮我截个屏看看" → pet returns a description grounded in an actual screenshot.
- [ ] Chat-triggered click: "帮我点一下 xxx 按钮" → pet screenshots first, reports the click, the click actually lands in the right place on screen.
- [ ] Chat-triggered typing: "帮我在这个输入框打字:你好" → text actually appears in the focused control, including the Chinese characters.
- [ ] `list_windows`/`focus_window`: ask "现在有哪些窗口" then "切到记事本" (or another open app) → correct titles listed, correct window comes to front.
- [ ] Visual indicator: badge reading `"<宠物名> 正在控制鼠标"` appears during automation and disappears right after — confirm it is the pet's actual name, not "AI".
- [ ] Safety rails: `click_at` without a prior `take_screenshot` in the same turn is refused with a clear message; asking for an unsupported key (e.g. "帮我按 Alt+F4") is refused; asking to type an absurdly long string (>2000 chars) is refused.
- [ ] Manual override: mid-automation, grab the mouse yourself → the run cancels immediately and the indicator disappears.
- [ ] Disable flow: uncheck the setting → save → the six tools are no longer available to the model in the next message.

- [ ] **Step 3: Update project trackers**

Update `PROGRESS.md` and `ROADMAP.md` to reflect this feature moving from "未做" to done, following this repo's existing convention for how completed MVPs are recorded (see the MVP-11/12/13 entries in `PROGRESS.md` for the expected level of detail: what was built, what's a known Minor/limitation, what the manual acceptance checklist covered).

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md ROADMAP.md
git commit -m "docs(progress): 宠物自主截屏+鼠标键盘控制 全部任务通过、真机验收通过"
```
