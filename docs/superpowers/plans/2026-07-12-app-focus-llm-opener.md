# 应用焦点 · LLM 实时开场白 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 `app_focus` 规则命中时，可选地（默认关闭）让配置好的 LLM 现场生成一句贴合当前应用/窗口标题的开场白，失败时无缝退回现有的预写台词池。

**Architecture:** 新增纯模块 `contextualLineGenerator.ts` 封装"单次非流式 LLM 补全"；`appFocusWatcher.ts` 抽出可单测的 `runAppFocusTick`，在命中规则后、回退预写台词池前插入可选的生成分支，并保证冷却状态在发起该异步调用**之前**就已提交；`shell/index.ts` 用现有 provider/key/persona 组装出注入的 `generateOpener` 闭包；新增一个默认关闭的设置项 + 一个 checkbox。

**Tech Stack:** TypeScript (strict) · Electron 主进程/渲染进程 · Vitest · pnpm

## Global Constraints

- 新设置项 `appFocusLlmOpener.enabled` 默认 `false`；关闭时行为必须与今天完全一致（回归不可破坏）。
- 复用当前对话框聊天已配置的 provider/apiKey（`settings.provider` + `secrets.getKey()`），不新增任何 LLM key/设置。
- 任何失败路径（未开启/无 key/网络错误/超时/空结果）一律返回 `null`，不抛异常，调用方退回 `pickFromPool` 的预写台词池——不重试。
- 默认超时 5000ms（`contextualLineGenerator` 内部常量，可调）。
- 生成的文本只用于当次瞬时气泡展示，不写入 transcript/factStore/日志/settings。
- 不新增 IPC 通道——`AppSettings` 已整体通过既有 `setSettings(settings: AppSettings)` 传递。
- 包管理器用 **pnpm**；纯逻辑先写失败测试（TDD）；每个任务一次提交，提交信息用中文、conventional-commit 风格（如 `feat(context): ...`）。
- **不要**给 `package.json` 加 `"type":"module"`。

---

## Task 1: `contextualLineGenerator` — 单次 LLM 补全封装

**Files:**
- Create: `src/main/context/contextualLineGenerator.ts`
- Test: `src/main/context/contextualLineGenerator.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`/`StreamChatRequest`（`src/main/providers/llmProvider.ts`，已存在：`streamChat(req): AsyncIterable<StreamChunk>`）、`StreamChunk`（`src/shared/llm.ts`，已存在联合类型 `{type:'text',text}|{type:'tool_use',...}|{type:'done',...}|{type:'error',message}`）、`createFakeProvider`（`src/main/providers/fakeProvider.ts`，已存在，测试用）。
- Produces: `generateContextualLine(opts): Promise<string | null>`，供 Task 3 的 `appFocusWatcher.ts` 和 Task 4 的 `shell/index.ts` 调用。

- [ ] **Step 1: 写失败测试**

创建 `src/main/context/contextualLineGenerator.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { generateContextualLine } from './contextualLineGenerator'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { StreamChunk } from '@shared/llm'

describe('generateContextualLine', () => {
  it('正常返回单行文本(掐头去尾空白)', async () => {
    const provider = createFakeProvider({ reply: '  又在摸鱼啦～  ' })
    const result = await generateContextualLine({
      personaText: '你是一只毒舌猫娘',
      processName: 'chrome.exe',
      windowTitle: 'Bilibili',
      provider
    })
    expect(result).toBe('又在摸鱼啦～')
  })

  it('provider 返回 error chunk → null', async () => {
    const provider = createFakeProvider({ failWith: '网络错误' })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider
    })
    expect(result).toBeNull()
  })

  it('空结果(reply 为空字符串) → null', async () => {
    const provider = createFakeProvider({ reply: '' })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider
    })
    expect(result).toBeNull()
  })

  it('超时 → null', async () => {
    const provider = createFakeProvider({ reply: 'hi', chunkSize: 1, delayMs: 150 })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider, timeoutMs: 20
    })
    expect(result).toBeNull()
  })

  it('system prompt 包含 persona 文本与固定的"一句话"指令,user content 带上应用名/窗口标题', async () => {
    let captured: StreamChatRequest | null = null
    const provider: LlmProvider = {
      async *streamChat(req): AsyncIterable<StreamChunk> {
        captured = req
        yield { type: 'text', text: '好' }
        yield { type: 'done' }
      }
    }
    await generateContextualLine({
      personaText: '你是一只毒舌猫娘', processName: 'code.exe', windowTitle: 'main.ts', provider
    })
    expect(captured?.system).toContain('你是一只毒舌猫娘')
    expect(captured?.system).toContain('不要加引号')
    expect(captured?.messages[0]).toEqual({ role: 'user', content: '用户刚切换到：code.exe / main.ts' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/context/contextualLineGenerator.test.ts`
Expected: FAIL（`contextualLineGenerator` 模块不存在）

- [ ] **Step 3: 写最小实现**

创建 `src/main/context/contextualLineGenerator.ts`：

```ts
import type { LlmProvider } from '../providers/llmProvider'

export interface GenerateContextualLineOptions {
  personaText: string
  processName: string
  windowTitle: string
  provider: LlmProvider
  /** 默认 5000ms */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const OPENER_INSTRUCTION =
  '用一句话，以你的口吻自然地对用户此刻在做的事搭话或吐槽。不要加引号，不要解释，只输出这一句话。'

/**
 * 借用为多轮工具调用设计的 streamChat 做一次单轮、无 tools 的短补全。
 * 任何失败(无结果/error chunk/超时/抛异常)都返回 null,调用方负责回退到预写台词池——
 * 不在这里重试,避免和上层 app_focus 的冷却节奏叠加出不可预期的调用频率。
 */
export async function generateContextualLine(opts: GenerateContextualLineOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const system = `${opts.personaText}\n\n${OPENER_INSTRUCTION}`
    const stream = opts.provider.streamChat({
      system,
      messages: [{ role: 'user', content: `用户刚切换到：${opts.processName} / ${opts.windowTitle}` }],
      maxOutputTokens: 60,
      signal: controller.signal
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'error') return null
      else if (chunk.type === 'done') break
    }
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/context/contextualLineGenerator.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/context/contextualLineGenerator.ts src/main/context/contextualLineGenerator.test.ts
git commit -m "feat(context): 新增应用焦点 LLM 开场白单次补全封装"
```

---

## Task 2: 设置项 `appFocusLlmOpener`

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify: `src/main/config/settings.test.ts`
- Modify: `src/main/config/settingsMigration.test.ts`（8 处硬编码的 `schemaVersion` 断言）
- Modify: `src/main/providers/embedder.test.ts`（`AppSettings` 类型字面量缺字段会挂 typecheck）
- Modify: `src/main/shell/chat.test.ts`（同上）

**Interfaces:**
- Consumes: 无新依赖，沿用现有 `DesktopControlSettings`/`FirecrawlSettings` 同款形状约定。
- Produces: `AppSettings.appFocusLlmOpener: { enabled: boolean }`（默认 `{ enabled: false }`），`SETTINGS_SCHEMA_VERSION = 11`。Task 4（`shell/index.ts`）与 Task 5（渲染层设置窗）都会读写这个字段。

- [ ] **Step 1: 写失败测试**

在 `src/main/config/settings.test.ts` 里，把第 26 行的完整对象字面量加上新字段（保持其余不变）：

```ts
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, tts: DEFAULT_SETTINGS.tts }
```

再把第 66 行、94 行的 `expect(loadSettings(f).schemaVersion).toBe(10)` 都改成 `.toBe(11)`。

新增一个 describe 块（追加到文件末尾）：

```ts
describe('appFocusLlmOpener', () => {
  it('缺省 → 默认 enabled:false', () => {
    const f = tmpSettingsFile({ schemaVersion: 10, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: false })
  })
  it('保留合法的 enabled:true', () => {
    const f = tmpSettingsFile({ appFocusLlmOpener: { enabled: true } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: true })
  })
  it('非法值(非 true) → 回退 false', () => {
    const f = tmpSettingsFile({ appFocusLlmOpener: { enabled: 'yes' } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: false })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: FAIL（`appFocusLlmOpener` 字段不存在/`schemaVersion` 断言不匹配）

- [ ] **Step 3: 写最小实现**

在 `src/shared/llm.ts`：

1. 在 `DesktopControlSettings` 定义后新增（约第 43 行）：

```ts
export interface AppFocusLlmOpenerSettings { enabled: boolean }
```

2. 把第 99 行 `export const SETTINGS_SCHEMA_VERSION = 10` 改成：

```ts
export const SETTINGS_SCHEMA_VERSION = 11
```

3. 把第 101 行 `AppSettings` 接口加上新字段（`desktopControl` 后面）：

```ts
export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; tts: TtsSettings }
```

4. 把第 103-114 行 `DEFAULT_SETTINGS` 加上新字段（`browserControl` 后面）：

```ts
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
  tts: DEFAULT_TTS_SETTINGS
}
```

在 `src/main/config/settings.ts`：

5. 在 `normalizeSettings` 里，`desktopControl` 归一化之后（第 46-47 行之后）新增：

```ts
  const afo = (r.appFocusLlmOpener ?? {}) as Record<string, unknown>
  const appFocusLlmOpener = { enabled: afo.enabled === true }
```

6. 把第 74-85 行的返回对象加上该字段（`desktopControl` 后面）：

```ts
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl,
    browserControl,
    appFocusLlmOpener,
    tts
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 修补另外三个因新增必填字段而挂掉的文件**

`SETTINGS_SCHEMA_VERSION` 从 10 → 11 后，`src/main/config/settingsMigration.test.ts` 里 8 处硬编码断言全部要改（用编辑器的"全部替换"，确认这 8 处都是断言 schemaVersion，不要误改其他数字 10）：

```
expect(s.schemaVersion).toBe(10)     →  expect(s.schemaVersion).toBe(11)     （第 24、52、74 行）
expect(out.schemaVersion).toBe(10)   →  expect(out.schemaVersion).toBe(11)   （第 112、137、165、193、243 行）
```

`src/main/providers/embedder.test.ts` 第 56-67 行的 `base()` 返回值类型是 `AppSettings`，新增必填字段后会挂 typecheck，在 `desktopControl: { enabled: false },` 后面补一行：

```ts
    desktopControl: { enabled: false },
    browserControl: { enabled: false, mode: 'isolated' },
    appFocusLlmOpener: { enabled: false },
    tts: DEFAULT_TTS_SETTINGS
```

`src/main/shell/chat.test.ts` 第 13-24 行的 `const settings: AppSettings = {...}` 同样需要补，在 `desktopControl: { enabled: false },` 后面：

```ts
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  tts: DEFAULT_TTS_SETTINGS
```

- [ ] **Step 6: 运行全量类型检查 + 单测确认无回归**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过（这一步会暴露是否还有遗漏的 `AppSettings` 完整字面量或硬编码 `schemaVersion` 断言——如果 `pnpm typecheck` 报某处缺 `appFocusLlmOpener` 属性，按上面同样的方式补上该字段）

- [ ] **Step 7: 提交**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts
git commit -m "feat(config): 新增 appFocusLlmOpener 设置项(默认关闭),schemaVersion 10→11"
```

---

## Task 3: `appFocusWatcher` 接入可选 LLM 生成分支

**Files:**
- Modify: `src/main/context/appFocusWatcher.ts`
- Modify: `src/main/context/appFocusWatcher.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `generateContextualLine`（本任务不直接调用它，只是新增一个通用的 `generateOpener` 回调形状，由 Task 4 在 `shell/index.ts` 里用 `generateContextualLine` 组装）。
- Produces:
  - `runAppFocusTick(state, rules, cfg, execFile, lastFiredText, generateOpener, onStateUpdated): Promise<Line | null>`（新导出，供本任务测试直接调用，也是 `startAppFocusWatcher` 内部改用的核心步进函数）。
  - `startAppFocusWatcher(petDir, opts)` 的 `opts` 新增可选字段 `generateOpener?: (ctx: { processName: string; windowTitle: string }) => Promise<string | null>`。

**关键约束（对应 spec §7 的判别性测试）：** 冷却状态（`state`）必须在发起 `generateOpener` 调用**之前**就通过 `onStateUpdated` 提交，不能等 `generateOpener` resolve 之后才更新——否则一次生成耗时超过 `pollIntervalMs` 时，后续 tick 会拿着"没考虑这次触发"的旧状态重新判定，绕开冷却重复触发。

- [ ] **Step 1: 写失败测试**

在 `src/main/context/appFocusWatcher.test.ts` 顶部的 import 里加上 `runAppFocusTick`：

```ts
import { parseAppFocusRules, matchAppFocusRule, initAppFocusWatcher, stepAppFocusWatcher, runAppFocusTick, type AppFocusWatcherConfig } from './appFocusWatcher'
```

在文件末尾追加新的 describe 块：

```ts
describe('runAppFocusTick', () => {
  const cfg: AppFocusWatcherConfig = { pollIntervalMs: 1000, minGapMs: 3000, ruleCooldownMs: 5000 }
  const rules = [{ match: ['code.exe'], lines: [{ text: 'code预设台词' }] }]
  const execFile = async (): Promise<{ stdout: string; stderr: string }> =>
    ({ stdout: 'PROC:code.exe\nTITLE:a', stderr: '' })

  it('没有 generateOpener → 走 pickFromPool 预设台词', async () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const line = await runAppFocusTick(state, rules, cfg, execFile, undefined, undefined, () => {})
    expect(line).toEqual({ text: 'code预设台词' })
  })

  it('generateOpener 返回文本 → 优先使用该文本', async () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const line = await runAppFocusTick(state, rules, cfg, execFile, undefined, async () => '现场生成的话', () => {})
    expect(line).toEqual({ text: '现场生成的话' })
  })

  it('generateOpener 返回 null → 回退 pickFromPool 预设台词', async () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const line = await runAppFocusTick(state, rules, cfg, execFile, undefined, async () => null, () => {})
    expect(line).toEqual({ text: 'code预设台词' })
  })

  it('都不命中规则时不调用 generateOpener', async () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    let called = false
    const missExecFile = async (): Promise<{ stdout: string; stderr: string }> =>
      ({ stdout: 'PROC:notepad.exe\nTITLE:x', stderr: '' })
    const line = await runAppFocusTick(state, rules, cfg, missExecFile, undefined, async () => { called = true; return 'x' }, () => {})
    expect(line).toBeNull()
    expect(called).toBe(false)
  })

  it('冷却状态在发起 generateOpener 调用前就已落定,不会被并发的第二次判定绕过', async () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    let committedState = state
    let resolveGen: (v: string | null) => void = () => {}
    const pendingGen = new Promise<string | null>((res) => { resolveGen = res })

    const firstTick = runAppFocusTick(state, rules, cfg, execFile, undefined, () => pendingGen, (s) => { committedState = s })

    // 让 execFile 的微任务链跑完、onStateUpdated 已经被调用,但 generateOpener 仍未 resolve(模拟一次慢生成)
    await new Promise((r) => setTimeout(r, 0))

    // 用第一次 tick 已提交的冷却状态,立刻发起第二次判定(同一时刻切回同一应用)
    const secondLine = await runAppFocusTick(committedState, rules, cfg, execFile, undefined, undefined, () => {})
    expect(secondLine).toBeNull() // ruleCooldownMs 应已生效,压住第二次触发

    resolveGen(null)
    await firstTick
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: FAIL（`runAppFocusTick` 未导出）

- [ ] **Step 3: 写最小实现**

把 `src/main/context/appFocusWatcher.ts` 第 112-156 行（`import { readFileSync }` 到文件末尾）整体替换为：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppFocusWatcherHandle { stop: () => void }

/**
 * 单次 tick 的核心步骤,拆出来是为了可以在测试里直接调用、不依赖 setInterval/真实计时器。
 * 关键顺序:onStateUpdated 必须在 await generateOpener 之前调用,否则一次生成耗时超过
 * pollIntervalMs 时,下一 tick 会用"没考虑这次触发"的旧状态重新判定,绕开冷却重复触发。
 */
export async function runAppFocusTick(
  state: AppFocusWatcherState,
  rules: AppFocusRule[],
  cfg: AppFocusWatcherConfig,
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>,
  lastFiredText: string | undefined,
  generateOpener: ((ctx: { processName: string; windowTitle: string }) => Promise<string | null>) | undefined,
  onStateUpdated: (state: AppFocusWatcherState) => void
): Promise<Line | null> {
  const sample = await execFile(buildForegroundWindowScript())
    .then((r) => parseForegroundWindowOutput(r.stdout))
    .catch(() => null)

  const result = stepAppFocusWatcher(state, sample, rules, cfg)
  onStateUpdated(result.state)

  if (result.firedRuleIndex === null || !sample) return null

  const rule = rules[result.firedRuleIndex]
  let text: string | null = null
  if (generateOpener) text = await generateOpener({ processName: sample.processName, windowTitle: sample.windowTitle })
  return text ? { text } : pickFromPool(rule.lines, lastFiredText)
}

/**
 * 薄包装:读取宠物包 lines.json 的 app_focus 规则(没有规则/没有该文件 → 空数组);
 * 若规则为空,直接返回 no-op handle,不起轮询——不启动的检测就是零隐私/性能开销,
 * 而不是"启动了但恰好不触发"。
 */
export function startAppFocusWatcher(
  petDir: string,
  opts: {
    execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
    onMatch: (line: Line) => void
    config?: Partial<AppFocusWatcherConfig>
    /** 命中规则时的可选生成分支:开启时优先用它的结果,失败/返回 null/未注入时回退预写台词池 */
    generateOpener?: (ctx: { processName: string; windowTitle: string }) => Promise<string | null>
  }
): AppFocusWatcherHandle {
  let rules: AppFocusRule[]
  try { rules = parseAppFocusRules(readFileSync(join(petDir, 'lines.json'), 'utf-8')) }
  catch { rules = [] }

  if (rules.length === 0) return { stop: (): void => {} }

  const cfg = { ...DEFAULT_APP_FOCUS_WATCHER_CONFIG, ...opts.config }
  let state = initAppFocusWatcher(rules.length, cfg)
  let lastFiredText: string | undefined

  const handle = setInterval(() => {
    void runAppFocusTick(state, rules, cfg, opts.execFile, lastFiredText, opts.generateOpener, (s) => { state = s })
      .then((line) => {
        if (!line) return
        lastFiredText = line.text
        opts.onMatch(line)
      })
  }, cfg.pollIntervalMs)

  return { stop: (): void => clearInterval(handle) }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/context/appFocusWatcher.test.ts`
Expected: PASS（含新增的 5 个 `runAppFocusTick` 用例，原有 `parseAppFocusRules`/`matchAppFocusRule`/`stepAppFocusWatcher` 用例不受影响）

- [ ] **Step 5: 运行全量单测 + 类型检查确认无回归**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/main/context/appFocusWatcher.ts src/main/context/appFocusWatcher.test.ts
git commit -m "feat(context): appFocusWatcher 支持可选 LLM 生成分支,失败时回退预写台词池"
```

---

## Task 4: `shell/index.ts` 接线

**Files:**
- Modify: `src/main/shell/index.ts:41`（import 区）
- Modify: `src/main/shell/index.ts:298-305`（`startAppFocusWatcher` 调用处）

**Interfaces:**
- Consumes: Task 1 `generateContextualLine`、Task 3 `startAppFocusWatcher` 新增的 `generateOpener` 字段、既有 `loadSettings(settingsFile)`/`secrets.getKey()`/`createProvider`/`loadPersona`（均已在本文件或其依赖里存在，仅 `loadPersona` 需新增 import）。
- Produces: 无新导出——纯粹是主进程启动时的依赖组装，本任务不新增测试文件（`shell/index.ts` 目前没有单元测试，走既有的"改 UI/躯壳后用 `pnpm dev`/`pnpm preview` 真机验收"惯例）。

- [ ] **Step 1: 加新 import**

在 `src/main/shell/index.ts` 第 41 行 `import { startAppFocusWatcher } from '../context/appFocusWatcher'` 下面新增两行：

```ts
import { generateContextualLine } from '../context/contextualLineGenerator'
import { loadPersona } from '../persona/personaLoader'
```

- [ ] **Step 2: 扩展 `startAppFocusWatcher` 调用,注入 `generateOpener`**

把第 298-305 行：

```ts
  const appFocusWatcher = startAppFocusWatcher(petDir, {
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    onMatch: (line) => {
      if (dialog.isOpen()) return // 对话框开着不触发,与 showAmbientLine 的兜底一致
      pendingAppFocusText = line.text
      petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')
    }
  })
```

改成：

```ts
  const appFocusWatcher = startAppFocusWatcher(petDir, {
    execFile: (script) => execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    onMatch: (line) => {
      if (dialog.isOpen()) return // 对话框开着不触发,与 showAmbientLine 的兜底一致
      pendingAppFocusText = line.text
      petWin.webContents.send(IPC.CONTEXT_SIGNAL, 'app_focus')
    },
    generateOpener: async ({ processName, windowTitle }) => {
      const settings = loadSettings(settingsFile)
      if (!settings.appFocusLlmOpener.enabled) return null
      const key = secrets.getKey()
      if (!key) return null
      const persona = loadPersona(petDir)
      const provider = createProvider(settings.provider, key)
      return generateContextualLine({ personaText: persona.persona, processName, windowTitle, provider })
    }
  })
```

- [ ] **Step 3: 类型检查 + 全量测试 + 构建确认无回归**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部通过（三包构建成功）

- [ ] **Step 4: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 应用焦点命中时按设置尝试 LLM 生成开场白,失败退回预设台词"
```

---

## Task 5: 设置窗 UI 开关

**Files:**
- Modify: `src/renderer/settings.html:135`（在 `firecrawlBaseRow` 之后、`desktopControlEnabled` 危险区块之前插入）
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: Task 2 新增的 `AppSettings.appFocusLlmOpener`；既有 `window.settingsApi.getSettings()`/`setSettings()`（`src/shared/ipc.ts` 的 `SettingsApi`，已支持整个 `AppSettings` 对象读写，本任务不需要改 IPC/preload）。
- Produces: 无新导出——纯 UI 接线，无单元测试（渲染层设置窗历来靠 `pnpm build` + 真机肉眼验收，同 `autoCopyResult`/`firecrawlEnabled` 等既有开关的验证方式）。

> **本任务的前提有变化**：Task 2 的实现者在跑 `pnpm typecheck` 时发现 `src/renderer/settings.ts` 是第 7 处构造完整 `AppSettings` 字面量的地方（本计划最初没预料到），为了不让 Task 2 提交后到本任务落地前的这段时间里"保存设置"静默把 `appFocusLlmOpener` 冲回默认值，Task 2 已经在那里加了一个**占位**：模块级 `let appFocusLlmOpenerEnabled = false`（第 34-36 行，原样透传已加载的值，不接 UI）、存档时写 `appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled }`（第 335 行）、初始化时回填 `appFocusLlmOpenerEnabled = snap.settings.appFocusLlmOpener.enabled`（第 354 行）。本任务要做的是**把这个占位换成真正的 checkbox**——变量名故意保持一致，把它从"布尔占位变量"改造成"HTMLInputElement 引用"，而不是另起一个新名字（否则会撞名）。下面的 Step 2-4 已经按这个真实状态改写，不是最初写计划时的样子。

- [ ] **Step 1: HTML 新增 checkbox + 说明文字**

在 `src/renderer/settings.html` 第 135 行（`firecrawlBaseURL` 的 `</label>` 之后）、第 136 行（`desktopControlEnabled` 的危险区块 `<div>` 之前）插入：

```html
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="appFocusLlmOpenerEnabled" type="checkbox" style="width:auto" />
              <span>应用焦点开场白由 AI 现场生成(而非固定台词)</span>
            </label>
            <div class="hint" style="margin-top:2px">
              开启后,命中应用焦点规则时(如切到 VS Code/Chrome)会把当前应用名/窗口标题发送给你配置的 LLM 服务商,
              用来生成一句贴合当下情境的开场白;未开启或生成失败时,仍使用宠物预设的固定台词。默认关闭。
            </div>
```

- [ ] **Step 2: 删除 Task 2 留下的占位变量,换成真正的控件引用**

删掉 `src/renderer/settings.ts` 第 34-36 行这三行占位（注释 + 变量）：

```ts
// appFocusLlmOpener 尚无本页 UI(Task 5 才加控件)——保存时原样带回已加载的值,
// 避免每次保存都把它悄悄冲回默认 false。
let appFocusLlmOpenerEnabled = false
```

在第 21 行（`const firecrawlBaseRow = ...`）之后、第 22 行（`const desktopControlEnabled = ...`）之前插入同名的控件引用（变量名不变，类型从"布尔占位"变成"输入框元素"）：

```ts
const appFocusLlmOpenerEnabled = $<HTMLInputElement>('appFocusLlmOpenerEnabled')
```

- [ ] **Step 3: 保存时改用 `.checked`**

第 335 行 Task 2 已经写了：

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled },
```

把它改成：

```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
```

- [ ] **Step 4: 初始化回填改用 `.checked =`**

第 354 行 Task 2 已经写了：

```ts
  appFocusLlmOpenerEnabled = snap.settings.appFocusLlmOpener.enabled
```

把它改成：

```ts
  appFocusLlmOpenerEnabled.checked = snap.settings.appFocusLlmOpener.enabled
```

- [ ] **Step 5: 类型检查 + 构建确认无回归**

Run: `pnpm typecheck && pnpm build`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(settings): 设置窗新增应用焦点 LLM 开场白开关(默认关闭)"
```

---

## Task 6: 更新隐私文档

**Files:**
- Modify: `docs/making-a-pet.md:146`

**Interfaces:**
- Consumes: 无。
- Produces: 无——纯文档修订。

> 注:`docs/*` 被 `.gitignore` 忽略，本任务的改动不会被 git 跟踪，但仍需要修改磁盘上的文件，保持文档与实现一致（与本仓库其余 `docs/*` 文档一贯的处理方式相同）。

- [ ] **Step 1: 更新隐私声明**

把 `docs/making-a-pet.md` 第 146 行：

```
- 窗口标题只在内存里用于匹配，用完即弃，不会被记录、发送或喂给 LLM。
```

改成：

```
- 窗口标题只在内存里用于匹配，用完即弃，不会被记录、发送或喂给 LLM。
- **例外**：设置里的"应用焦点开场白由 AI 现场生成"开关（默认关闭）打开后，命中规则时会把当前应用名/窗口标题发送给你配置的 LLM 服务商，用来生成开场白；关闭时（默认状态）上面这条边界依然成立。
```

- [ ] **Step 2: 确认改动**

Run: `git diff --no-index /dev/null docs/making-a-pet.md 2>/dev/null | tail -5 || true`

（该文件不被 git 跟踪，这一步只是人工确认磁盘内容已更新，不需要提交）

---

## Task 7: 全量回归

**Files:** 无新增/修改（纯验证）

- [ ] **Step 1: 全量类型检查 + 单测 + 构建**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部通过，三包（main/preload/renderer）构建成功

- [ ] **Step 2: 冒烟启动确认无崩溃**

Run: `pnpm preview`
Expected: 窗口正常显示宠物，托盘可用；关闭进程结束验证

---

## 真机验收清单（本仓库无 Electron GUI 自动化驱动，需人工在真实 Windows 环境完成）

- 关闭状态（默认）下，`app_focus` 表现与本次改动前完全一致——回归确认。
- 设置窗新增的开关默认未勾选；勾选后保存、重启应用，切到白名单应用（如真实打开 VS Code）→ 气泡显示的是**现场生成**的句子（非 `lines.json` 里的固定预写句）。
- 开关开启但未配置 provider/key，或断网 → 切到白名单应用 → 依然正常显示预写台词兜底，不报错、不卡顿、不闪退。
- 生成内容的主观质量（是否贴切/好玩/符合人设）——留给真机使用后判断，不强求自动化验证。
- 任务管理器确认：开启该开关不会让 `powershell.exe`/网络请求频率明显高于关闭时（冷却机制不变，只是命中后多了一次网络调用）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-app-focus-llm-opener.md`. Two execution options:

1. **Subagent-Driven (recommended)** - 我为每个任务派发一个全新子代理，任务间做审查，迭代更快
2. **Inline Execution** - 在本会话里用 executing-plans 批量执行，设检查点复核

Which approach?
