# 语音功能(minimal_tts 集成)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把外部 `minimal_tts`(GPT-SoVITS 推理最小包)接成桌宠的 `tts` VoiceProvider,语音跟随宠物包(专属音色/共享默认音色回退),中/日/英朗读语言可选。

**Architecture:** 主进程新增 `src/main/providers/tts/`(sidecar 客户端 + 句子缓冲 + 音色切换纯函数 + orchestrator),`chat.ts` 按语言分两条路径接线(zh 走流式 token、ja/en 走"整句翻译后一次性合成"),`lines.json` 扩展多语言字段免翻译播放,新增 IPC 把 PCM 音频推给渲染层播放,设置面板新增语音页。

**Tech Stack:** Electron 31(CJS 主进程)+ TypeScript strict + Vitest;新增运行时依赖 `ws`(main 进程需要一个 WebSocket 客户端连 `minimal_tts` 的 loopback 服务——Electron 31 打的 Node 20 在主进程/Node 上下文里没有全局 `WebSocket`,这是本次除 `minimal_tts` 本身之外唯一的新增 npm 依赖)。

## Global Constraints

- 不加 `"type": "module"`(CLAUDE.md 铁律)。
- pnpm 是包管理器,不用 npm/yarn。
- 每个任务改完跑 `pnpm typecheck` 和相关 `pnpm vitest run <path>`,全部通过再提交。
- 提交信息用 conventional commits + 中文描述(如 `feat(tts): ...`)。
- 涉及 Electron 主进程副作用的代码走依赖注入(仿 `automation/automationControl.ts`/`browserAutomation/browserControl.ts` 先例),纯逻辑单测,真实 spawn/WebSocket/fs 只在 `shell/index.ts` 里接线、不单测(与项目现有 automation/browserAutomation 模块的分层一致)。
- 设计文档:`docs/superpowers/specs/2026-07-09-tts-voice-minimal-tts-design.md`(所有决策的依据,任务间有疑问回查它)。

---

## Task 1: TTS 设置 schema(`AppSettings.tts` + schemaVersion 8→9)

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify: `src/main/config/settings.test.ts`
- Modify: `src/main/config/settingsMigration.test.ts`
- Modify: `src/main/providers/embedder.test.ts`
- Modify: `src/main/shell/chat.test.ts`

**Interfaces:**
- Produces: `export type TtsLanguage = 'zh' | 'ja' | 'en'`,`export interface TtsSettings { enabled: boolean; language: TtsLanguage; packagePath?: string }`,`AppSettings.tts: TtsSettings`,`DEFAULT_SETTINGS.tts = { enabled: false, language: 'zh' }`,`SETTINGS_SCHEMA_VERSION = 9`。后续所有任务里构造 `AppSettings` 字面量的地方都要带上 `tts` 字段。

- [ ] **Step 1: 在 `settings.test.ts` 追加失败的新用例**

在 `src/main/config/settings.test.ts` 文件末尾追加:

```ts
describe('tts', () => {
  it('缺省 tts → 默认 enabled:false, language:zh', () => {
    const f = tmpSettingsFile({ schemaVersion: 8, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).tts).toEqual({ enabled: false, language: 'zh' })
  })
  it('language 非法值 → 回退 zh', () => {
    const f = tmpSettingsFile({ tts: { enabled: true, language: 'fr' } })
    expect(loadSettings(f).tts).toEqual({ enabled: true, language: 'zh' })
  })
  it('保留合法的 ja/en', () => {
    expect(loadSettings(tmpSettingsFile({ tts: { enabled: true, language: 'ja' } })).tts.language).toBe('ja')
    expect(loadSettings(tmpSettingsFile({ tts: { enabled: true, language: 'en' } })).tts.language).toBe('en')
  })
  it('packagePath 非空字符串 → 去除首尾空白后保留;空/非字符串 → undefined', () => {
    expect(loadSettings(tmpSettingsFile({ tts: { packagePath: '  D:\\tts  ' } })).tts.packagePath).toBe('D:\\tts')
    expect(loadSettings(tmpSettingsFile({ tts: { packagePath: '   ' } })).tts.packagePath).toBeUndefined()
    expect(loadSettings(tmpSettingsFile({ tts: { packagePath: 5 } })).tts.packagePath).toBeUndefined()
  })
  it('归一化后 schemaVersion 升为 9', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(9)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: FAIL(`tts` 相关用例报 `Cannot read properties of undefined` 或 `toEqual` 不匹配;已有用例因 `SETTINGS_SCHEMA_VERSION` 变化尚未联动而可能也报错,属预期)

- [ ] **Step 3: `src/shared/llm.ts` 加类型 + 默认值 + 升版**

在 `export interface BrowserControlSettings { ... }` 之后(第 49 行后)插入:

```ts
export type TtsLanguage = 'zh' | 'ja' | 'en'
/** packagePath 留空时用约定默认路径(开发态 <repo>/minimal_tts,打包态 process.resourcesPath/minimal_tts) */
export interface TtsSettings { enabled: boolean; language: TtsLanguage; packagePath?: string }
```

把 `export const SETTINGS_SCHEMA_VERSION = 8` 改成:

```ts
export const SETTINGS_SCHEMA_VERSION = 9
```

`AppSettings` 接口末尾加 `tts: TtsSettings`:

```ts
export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; tts: TtsSettings }
```

`DEFAULT_SETTINGS` 末尾加:

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
  tts: { enabled: false, language: 'zh' }
}
```

- [ ] **Step 4: `src/main/config/settings.ts` 加解析逻辑**

在文件顶部 import 里加 `TtsLanguage, type TtsSettings`:

```ts
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings, type TtsLanguage, type TtsSettings } from '@shared/llm'
```

在 `const BACKENDS` 下面加:

```ts
const TTS_LANGUAGES: TtsLanguage[] = ['zh', 'ja', 'en']
```

在 `normalizeSettings` 函数里,`const bc = ...` 那段之后、`return {` 之前插入:

```ts
  const ts = (r.tts ?? {}) as Record<string, unknown>
  const tts: TtsSettings = {
    enabled: ts.enabled === true,
    language: TTS_LANGUAGES.includes(ts.language as TtsLanguage) ? (ts.language as TtsLanguage) : DEFAULT_SETTINGS.tts.language,
    packagePath: typeof ts.packagePath === 'string' && ts.packagePath.trim().length > 0 ? ts.packagePath.trim() : undefined
  }
```

`return { ... }` 对象字面量末尾加 `tts`:

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
    tts
  }
```

- [ ] **Step 5: 修其余三处硬编码 `AppSettings` 字面量,补 `tts` 字段**

`src/main/config/settings.test.ts` 第 26 行(round-trip 测试)的字面量末尾加 `, tts: { enabled: false, language: 'zh' as const }`:

```ts
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, tts: { enabled: false, language: 'zh' as const } }
```

`src/main/providers/embedder.test.ts` 的 `base()` helper(约第 55-65 行),`browserControl: { enabled: false, mode: 'isolated' }` 后加一行:

```ts
    desktopControl: { enabled: false },
    browserControl: { enabled: false, mode: 'isolated' },
    tts: { enabled: false, language: 'zh' }
  })
```

`src/main/shell/chat.test.ts` 顶部的 `settings` 常量(约第 12-22 行),末尾加:

```ts
const settings: AppSettings = {
  schemaVersion: 3,
  activePetId: 'luluka',
  provider: { kind: 'fake', model: 'fake' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  tts: { enabled: false, language: 'zh' }
}
```

- [ ] **Step 6: 把 `settingsMigration.test.ts` / `settings.test.ts` 里硬编码的 `.toBe(8)` 全部改成 `.toBe(9)`**

`src/main/config/settingsMigration.test.ts` 第 24、52、74、112、137、165 行的 `expect(...).toBe(8)` 全部改成 `expect(...).toBe(9)`(6 处);第 18、67、104、128、155 行注释文案里的"升到 8"/"升为 8"顺手改成"升到 9"/"升为 9"(纯文案,不影响断言但保持一致)。

`src/main/config/settings.test.ts` 第 66、94 行的 `expect(loadSettings(f).schemaVersion).toBe(8)` 改成 `.toBe(9)`(2 处),对应的 `it('归一化后 schemaVersion 升为 8', ...)` 描述文案改成"升为 9"。

- [ ] **Step 7: 运行确认全部通过**

Run: `pnpm vitest run src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts`
Expected: PASS(全部通过)

Run: `pnpm typecheck`
Expected: PASS(此时其余引用 `AppSettings` 字面量的文件如果 typecheck 报缺 `tts` 字段,记下报错文件路径,在本任务内一并补上 `tts: { enabled: false, language: 'zh' }`,直到 typecheck 干净)

- [ ] **Step 8: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts
git commit -m "feat(tts): 新增 AppSettings.tts 设置项(schemaVersion 8→9)"
```

---

## Task 2: `lines.json` 多语言台词字段

**Files:**
- Modify: `src/main/lines/linesLoader.ts`
- Modify: `src/main/lines/linesLoader.test.ts`

**Interfaces:**
- Consumes: `TtsLanguage` from `@shared/llm`(Task 1)。
- Produces: `Line` 新增 `text_ja?: string; text_en?: string`;新增 `export function resolveLineText(line: Line, language: TtsLanguage): string`。Task 9(chat.ts 集成)与 Task 12(PET_SPEAK 接线)都会调用 `resolveLineText`。

- [ ] **Step 1: 追加失败测试**

在 `src/main/lines/linesLoader.test.ts` 末尾追加:

```ts
describe('parseLines 多语言字段', () => {
  it('解析 text_ja/text_en', () => {
    const raw = JSON.stringify({ idle: [{ text: '早安', text_ja: 'おはよう', text_en: 'Good morning' }] })
    const t = parseLines(raw)
    expect(t.idle).toEqual([{ text: '早安', text_ja: 'おはよう', text_en: 'Good morning' }])
  })
  it('缺 text_ja/text_en 时不产出这两个 key(而不是 undefined 占位)', () => {
    const t = parseLines(JSON.stringify({ idle: [{ text: '早安' }] }))
    expect(t.idle![0]).toEqual({ text: '早安' })
    expect('text_ja' in t.idle![0]).toBe(false)
  })
})

describe('resolveLineText', () => {
  it('zh 直接用 text', () => {
    expect(resolveLineText({ text: '早安', text_ja: 'おはよう' }, 'zh')).toBe('早安')
  })
  it('ja 有 text_ja 时用它', () => {
    expect(resolveLineText({ text: '早安', text_ja: 'おはよう' }, 'ja')).toBe('おはよう')
  })
  it('ja 缺 text_ja 时回退 text(硬读中文原文)', () => {
    expect(resolveLineText({ text: '早安' }, 'ja')).toBe('早安')
  })
  it('en 有 text_en 时用它,缺则回退 text', () => {
    expect(resolveLineText({ text: '早安', text_en: 'Good morning' }, 'en')).toBe('Good morning')
    expect(resolveLineText({ text: '早安' }, 'en')).toBe('早安')
  })
})
```

同时把文件顶部 import 改成:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactionCategory } from '@shared/reactionPlanner'
import type { TtsLanguage } from '@shared/llm'
import { parseLines, pickLine, resolveLineText, type Line } from './linesLoader'
```

(注:测试文件已有 `import { parseLines, pickLine } from './linesLoader'`,改成上面这行把 `resolveLineText`/`Line`/`TtsLanguage` 一并带进来,删掉原来那行重复 import。)

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: FAIL(`resolveLineText`/`text_ja` 相关用例报未定义或不匹配)

- [ ] **Step 3: 实现**

把 `src/main/lines/linesLoader.ts` 顶部 import 加 `TtsLanguage`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactionCategory } from '@shared/reactionPlanner'
import type { TtsLanguage } from '@shared/llm'
```

`Line` 接口改成:

```ts
export interface Line { text: string; text_ja?: string; text_en?: string; audio?: string }
```

`parseLines` 里构造 `line` 的那段(原来只处理 `text`/`audio`)改成:

```ts
    for (const item of val) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec.text !== 'string') continue
      const line: Line = { text: rec.text }
      if (typeof rec.text_ja === 'string') line.text_ja = rec.text_ja
      if (typeof rec.text_en === 'string') line.text_en = rec.text_en
      if (typeof rec.audio === 'string') line.audio = rec.audio
      lines.push(line)
    }
```

文件末尾(`pickLine` 函数后)加:

```ts
/** 按朗读语言取台词文案;缺对应语言字段时回退中文原文(硬读,不现场翻译)。 */
export function resolveLineText(line: Line, language: TtsLanguage): string {
  if (language === 'ja' && line.text_ja) return line.text_ja
  if (language === 'en' && line.text_en) return line.text_en
  return line.text
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/lines/linesLoader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/lines/linesLoader.ts src/main/lines/linesLoader.test.ts
git commit -m "feat(tts): lines.json 支持 text_ja/text_en 多语言台词"
```

---

## Task 3: 句子缓冲(`sentenceBuffer.ts`,移植自 minimal_tts)

**Files:**
- Create: `src/main/providers/tts/sentenceBuffer.ts`
- Test: `src/main/providers/tts/sentenceBuffer.test.ts`

**Interfaces:**
- Produces: `export interface SentenceClock { setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(h: ReturnType<typeof setTimeout>): void }`,`export interface SentenceBuffer { push(token: string): string[]; flush(): string; clear(): void }`,`export function createSentenceBuffer(options?: { minLength?: number; idleMs?: number; maxLength?: number; clock?: SentenceClock; onIdle?: () => void }): SentenceBuffer`。Task 5(`ttsClient.ts`)消费这个模块。

来源:`D:\LProject\claude_Project\minimal_tts\electron\SentenceBuffer.ts`——把原来的 ES6 class 改写成本项目惯用的工厂函数(仿 `automationControl.ts`/`chat.ts` 里 `createXxx(): Interface` 的风格),逻辑(强标点立即切分、软标点延迟切分、最大长度强制切分、空闲计时器)原样保留,不改动任何阈值/正则。

- [ ] **Step 1: 写失败测试**

创建 `src/main/providers/tts/sentenceBuffer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createSentenceBuffer } from './sentenceBuffer'

describe('createSentenceBuffer', () => {
  it('无标点时不产出片段', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好')).toEqual([])
    expect(buf.push('世界')).toEqual([])
  })

  it('强标点(。！？!?.)立即切出片段', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好。')).toEqual(['你好。'])
    expect(buf.push('后面的')).toEqual([])
  })

  it('短于 minLength 的强标点片段被丢弃', () => {
    const buf = createSentenceBuffer({ minLength: 3 })
    expect(buf.push('好。')).toEqual([]) // 长度 2 < minLength 3
  })

  it('软标点(，、,;：:)首次出现记下断点,buffer 继续增长超过断点才真正切出', () => {
    const buf = createSentenceBuffer()
    expect(buf.push('你好，')).toEqual([]) // 软断点刚好在末尾,buffer.length 不大于 softBreakIndex,先不切
    expect(buf.push('世界')).toEqual(['你好，']) // 继续增长,超过断点 → 切出
  })

  it('超过 maxLength 强制切分', () => {
    const buf = createSentenceBuffer({ maxLength: 10, minLength: 1 })
    const segments = buf.push('a'.repeat(15))
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0].length).toBeLessThanOrEqual(10)
  })

  it('flush 返回剩余内容并清空;不足 minLength 的残留也会被 flush 出来', () => {
    const buf = createSentenceBuffer()
    buf.push('好')
    expect(buf.flush()).toBe('好')
    expect(buf.flush()).toBe('') // 再次 flush 是空
  })

  it('clear 丢弃残留内容,flush 拿不到东西', () => {
    const buf = createSentenceBuffer()
    buf.push('残留内容')
    buf.clear()
    expect(buf.flush()).toBe('')
  })

  it('markdown 代码块围栏与 URL 被清除,换行变空格', () => {
    const buf = createSentenceBuffer({ minLength: 1 })
    buf.push('```js\n')
    const segs = buf.push('看 https://example.com/x 这里\n结束。')
    expect(segs[0]).not.toContain('```')
    expect(segs[0]).not.toContain('https://')
    expect(segs[0]).not.toContain('\n')
  })

  it('注入 clock:push 后不主动 flush 也不触发 onIdle;手动推进 clock 后触发 onIdle', () => {
    let scheduled: (() => void) | null = null
    const clock = {
      setTimeout: vi.fn((fn: () => void) => { scheduled = fn; return 1 as unknown as ReturnType<typeof setTimeout> }),
      clearTimeout: vi.fn()
    }
    let idleFired = 0
    const buf = createSentenceBuffer({ clock, onIdle: () => { idleFired++ } })
    buf.push('还没说完')
    expect(idleFired).toBe(0)
    expect(scheduled).not.toBeNull()
    scheduled!()
    expect(idleFired).toBe(1)
  })

  it('push 会取消上一个待触发的 idle 计时器', () => {
    const clock = {
      setTimeout: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimeout: vi.fn()
    }
    const buf = createSentenceBuffer({ clock, onIdle: () => {} })
    buf.push('第一段')
    buf.push('继续')
    expect(clock.clearTimeout).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/tts/sentenceBuffer.test.ts`
Expected: FAIL(找不到模块 `./sentenceBuffer`)

- [ ] **Step 3: 实现**

创建 `src/main/providers/tts/sentenceBuffer.ts`:

```ts
/** LLM token 清洗与流式分句缓冲,移植自 minimal_tts/electron/SentenceBuffer.ts(逻辑与阈值不变,改写成工厂函数风格)。 */

export interface SentenceClock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(h: ReturnType<typeof setTimeout>): void
}

export interface SentenceBufferOptions {
  minLength?: number
  idleMs?: number
  maxLength?: number
  clock?: SentenceClock
  onIdle?: () => void
}

export interface SentenceBuffer {
  push(token: string): string[]
  flush(): string
  clear(): void
}

const DEFAULT_MIN_LENGTH = 2
const DEFAULT_IDLE_MS = 250
const DEFAULT_MAX_LENGTH = 80

const STRONG_PUNCT_RE = /[。！？!?.]/g
const SOFT_PUNCT_RE = /[，、,;：:]/
const MD_FENCE_RE = /```[a-zA-Z]*\n?|```/g
const URL_RE = /https?:\/\/\S+/g

function cleanToken(token: string): string {
  return token.replace(MD_FENCE_RE, '').replace(URL_RE, '').replace(/\n/g, ' ')
}

export function createSentenceBuffer(options?: SentenceBufferOptions): SentenceBuffer {
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH
  const idleMs = options?.idleMs ?? DEFAULT_IDLE_MS
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH
  const clock: SentenceClock = options?.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h)
  }
  const onIdle = options?.onIdle

  let buffer = ''
  let softBreakIndex = -1
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function cancelIdle(): void {
    if (idleTimer !== null) {
      clock.clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdle(): void {
    cancelIdle()
    idleTimer = clock.setTimeout(() => {
      idleTimer = null
      onIdle?.()
    }, idleMs)
  }

  function process(): string[] {
    const segments: string[] = []

    for (;;) {
      STRONG_PUNCT_RE.lastIndex = 0
      const match = STRONG_PUNCT_RE.exec(buffer)
      if (!match) break
      const end = match.index + match[0].length
      const segment = buffer.substring(0, end).trim()
      buffer = buffer.substring(end)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    const softMatch = SOFT_PUNCT_RE.exec(buffer)
    if (softMatch) {
      if (softBreakIndex === -1) softBreakIndex = softMatch.index + softMatch[0].length
    }
    if (softBreakIndex !== -1 && buffer.length > softBreakIndex) {
      const segment = buffer.substring(0, softBreakIndex).trim()
      buffer = buffer.substring(softBreakIndex)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    while (buffer.length >= maxLength) {
      let breakIdx = buffer.lastIndexOf(' ', maxLength)
      if (breakIdx <= 0) breakIdx = maxLength
      const segment = buffer.substring(0, breakIdx).trim()
      buffer = buffer.substring(breakIdx)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    if (buffer.trim().length >= minLength) scheduleIdle()

    return segments
  }

  return {
    push(token: string): string[] {
      cancelIdle()
      buffer += cleanToken(token)
      return process()
    },
    flush(): string {
      cancelIdle()
      const result = buffer.trim()
      buffer = ''
      softBreakIndex = -1
      return result
    },
    clear(): void {
      cancelIdle()
      buffer = ''
      softBreakIndex = -1
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/tts/sentenceBuffer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/tts/sentenceBuffer.ts src/main/providers/tts/sentenceBuffer.test.ts
git commit -m "feat(tts): 移植 minimal_tts 的流式分句缓冲(sentenceBuffer)"
```

---

## Task 4: TTS 协议类型(`protocol.ts`,移植自 minimal_tts)

**Files:**
- Create: `src/main/providers/tts/protocol.ts`
- Test: `src/main/providers/tts/protocol.test.ts`

**Interfaces:**
- Consumes: `TtsLanguage` from `@shared/llm`(Task 1)。
- Produces: `ReadyEvent`、`ClientMessage`(`StartMessage|EnqueueMessage|FinishMessage|CancelMessage`)、`ServerEvent`(`SegmentStartEvent|AudioStartEvent|SegmentEndEvent|DoneEvent|CancelledEvent|ReferenceReadyEvent|ErrorEvent`)、`isBinaryMessage(data): data is ArrayBuffer`、`parseServerEvent(raw: string): ServerEvent`。Task 5 消费这些类型。

来源:`D:\LProject\claude_Project\minimal_tts\electron\protocol.ts`,原样移植,唯一改动是用 `@shared/llm` 的 `TtsLanguage` 替换原文件自定义的 `SpeechLanguage`(避免重复定义同一个 `'zh'|'ja'|'en'` 类型)。

- [ ] **Step 1: 写失败测试**

创建 `src/main/providers/tts/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isBinaryMessage, parseServerEvent } from './protocol'

describe('isBinaryMessage', () => {
  it('ArrayBuffer → true', () => {
    expect(isBinaryMessage(new ArrayBuffer(4))).toBe(true)
  })
  it('字符串 → false', () => {
    expect(isBinaryMessage('{"type":"done"}')).toBe(false)
  })
})

describe('parseServerEvent', () => {
  it('解析 audio_start', () => {
    const e = parseServerEvent(JSON.stringify({ type: 'audio_start', id: 'x', sampleRate: 32000, channels: 1, format: 'pcm_s16le' }))
    expect(e).toEqual({ type: 'audio_start', id: 'x', sampleRate: 32000, channels: 1, format: 'pcm_s16le' })
  })
  it('解析 done/cancelled/error', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'done', id: 'x' }))).toEqual({ type: 'done', id: 'x' })
    expect(parseServerEvent(JSON.stringify({ type: 'cancelled', id: 'x' }))).toEqual({ type: 'cancelled', id: 'x' })
    const err = parseServerEvent(JSON.stringify({ type: 'error', id: 'x', code: 'SYNTHESIS_FAILED', message: 'boom', fatal: false }))
    expect(err).toEqual({ type: 'error', id: 'x', code: 'SYNTHESIS_FAILED', message: 'boom', fatal: false })
  })
  it('缺 type 字段抛错', () => {
    expect(() => parseServerEvent('{}')).toThrow('Server event missing type field')
  })
  it('非法 JSON 抛错', () => {
    expect(() => parseServerEvent('{ not json')).toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/tts/protocol.test.ts`
Expected: FAIL(找不到模块 `./protocol`)

- [ ] **Step 3: 实现**

创建 `src/main/providers/tts/protocol.ts`:

```ts
/** minimal_tts WebSocket 协议的 wire 类型,移植自 minimal_tts/electron/protocol.ts。 */
import type { TtsLanguage } from '@shared/llm'

export interface ReadyEvent {
  readonly type: 'ready'
  readonly protocol: number
  readonly host: string
  readonly port: number
  readonly token: string
  readonly device: string
  readonly precision: string
}

export interface StartMessage { readonly type: 'start'; readonly id: string; readonly language: TtsLanguage }
export interface EnqueueMessage { readonly type: 'enqueue'; readonly id: string; readonly sequence: number; readonly text: string }
export interface FinishMessage { readonly type: 'finish'; readonly id: string }
export interface CancelMessage { readonly type: 'cancel'; readonly id: string }
export type ClientMessage = StartMessage | EnqueueMessage | FinishMessage | CancelMessage

export interface SegmentStartEvent { readonly type: 'segment_start'; readonly id: string; readonly sequence: number }
export interface AudioStartEvent { readonly type: 'audio_start'; readonly id: string; readonly sampleRate: number; readonly channels: number; readonly format: string }
export interface SegmentEndEvent { readonly type: 'segment_end'; readonly id: string; readonly sequence: number }
export interface DoneEvent { readonly type: 'done'; readonly id: string }
export interface CancelledEvent { readonly type: 'cancelled'; readonly id: string }
export interface ReferenceReadyEvent { readonly type: 'reference_ready'; readonly id: string }
export interface ErrorEvent { readonly type: 'error'; readonly id: string | null; readonly code: string; readonly message: string; readonly fatal: boolean }

export type ServerEvent =
  | SegmentStartEvent
  | AudioStartEvent
  | SegmentEndEvent
  | DoneEvent
  | CancelledEvent
  | ReferenceReadyEvent
  | ErrorEvent

export function isBinaryMessage(data: unknown): data is ArrayBuffer {
  return data instanceof ArrayBuffer
}

export function parseServerEvent(raw: string): ServerEvent {
  const obj = JSON.parse(raw) as Record<string, unknown>
  if (typeof obj['type'] !== 'string') throw new Error('Server event missing type field')
  return obj as unknown as ServerEvent
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/tts/protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/tts/protocol.ts src/main/providers/tts/protocol.test.ts
git commit -m "feat(tts): 移植 minimal_tts 的 WebSocket 协议类型"
```

---

## Task 5: TTS sidecar 客户端(`ttsClient.ts`,依赖注入,移植自 AliceTts.ts)

**Files:**
- Create: `src/main/providers/tts/ttsClient.ts`
- Test: `src/main/providers/tts/ttsClient.test.ts`

**Interfaces:**
- Consumes: `TtsLanguage`(`@shared/llm`,Task 1);`ClientMessage`/`ReadyEvent`/`ServerEvent`/`isBinaryMessage`/`parseServerEvent`(`./protocol`,Task 4);`createSentenceBuffer`(`./sentenceBuffer`,Task 3)。
- Produces: `export interface TtsClient { start(): Promise<ReadyEvent>; begin(id: string, language: TtsLanguage): void; pushToken(token: string): void; finish(): void; cancel(): void; close(): Promise<void> }`,`export interface SpawnedProcess { ... }`,`export interface MinimalWebSocket { ... }`,`export function createTtsClient(opts: TtsClientOptions): TtsClient`。Task 7(`index.ts`)与 Task 12(`shell/index.ts`)消费这个模块。

来源:`D:\LProject\claude_Project\minimal_tts\electron\AliceTts.ts`,移植时把构造参数改成显式依赖注入(`spawn`/`createWebSocket`/`clock` 全部注入,不直接 `import('child_process')` 或用全局 `WebSocket`——这正是本模块要解决的"主进程没有全局 WebSocket"问题),`cancel()` 去掉原来隐含依赖 `activeId` 的行为不变(不接收 id 参数,取消"当前正在进行的那个")。

- [ ] **Step 1: 写失败测试**

创建 `src/main/providers/tts/ttsClient.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTtsClient, type SpawnedProcess, type MinimalWebSocket } from './ttsClient'
import type { ServerEvent } from './protocol'

function fakeChild(): SpawnedProcess & { emitStdout: (line: string) => void; emitExit: (code: number | null) => void; emitError: (e: Error) => void } {
  const stdoutHandlers: Array<(chunk: string) => void> = []
  const exitHandlers: Array<(code: number | null) => void> = []
  const errorHandlers: Array<(e: Error) => void> = []
  return {
    stdout: { setEncoding: () => {}, on: (_e, cb) => { stdoutHandlers.push(cb) } },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: (event, cb) => { if (event === 'exit') exitHandlers.push(cb as (code: number | null) => void); if (event === 'error') errorHandlers.push(cb as (e: Error) => void) },
    kill: vi.fn(),
    emitStdout(line: string) { for (const h of stdoutHandlers) h(line) },
    emitExit(code) { for (const h of exitHandlers) h(code) },
    emitError(e) { for (const h of errorHandlers) h(e) }
  }
}

function fakeWebSocket(): MinimalWebSocket & { emitMessage: (data: unknown) => void; sent: string[] } {
  const sent: string[] = []
  const ws: MinimalWebSocket & { emitMessage: (data: unknown) => void; sent: string[] } = {
    readyState: 1,
    send: (data: string) => { sent.push(data) },
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    sent,
    emitMessage(data: unknown) { ws.onmessage?.({ data }) }
  }
  return ws
}

const readyLine = JSON.stringify({ type: 'ready', protocol: 1, host: '127.0.0.1', port: 49152, token: 'tok', device: 'cpu', precision: 'fp32' }) + '\n'

describe('createTtsClient', () => {
  it('start():解析 ready 行、建立 WebSocket 连接后 resolve', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe',
      packageRoot: 'C:\\pkg',
      spawn: () => child,
      createWebSocket: () => ws
    })
    const startPromise = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    const ready = await startPromise
    expect(ready.port).toBe(49152)
    expect(ready.token).toBe('tok')
  })

  it('start() 前 kill 掉的进程 / 无 ready 行直接 exit → reject', async () => {
    const child = fakeChild()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => fakeWebSocket()
    })
    const p = client.start()
    child.emitExit(1)
    await expect(p).rejects.toThrow('TTS sidecar exited before ready')
  })

  it('begin/pushToken/finish 按顺序发送 start → enqueue(累计 sequence)→ finish 消息', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p

    client.begin('r1', 'zh')
    client.pushToken('你好。')  // 强标点立即切出一个 segment
    client.finish()

    const msgs = ws.sent.map((s) => JSON.parse(s))
    expect(msgs[0]).toEqual({ type: 'start', id: 'r1', language: 'zh' })
    expect(msgs[1]).toEqual({ type: 'enqueue', id: 'r1', sequence: 0, text: '你好。' })
    expect(msgs[2]).toEqual({ type: 'finish', id: 'r1' })
  })

  it('cancel() 发送 cancel 消息并清空缓冲(cancel 后 pushToken 不会补发遗留内容)', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p

    client.begin('r1', 'zh')
    client.pushToken('没说完') // 无标点,停在 buffer 里
    client.cancel()
    const msgs = ws.sent.map((s) => JSON.parse(s))
    expect(msgs[msgs.length - 1]).toEqual({ type: 'cancel', id: 'r1' })
    client.finish() // cancel 后 activeId 已清空,finish 不应再发消息
    expect(ws.sent.length).toBe(msgs.length)
  })

  it('onAudio 收到二进制帧,onEvent 收到 JSON 事件(按 audio_start 记录采样率)', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const audioCalls: Array<{ id: string; sampleRate: number }> = []
    const events: ServerEvent[] = []
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws,
      onAudio: (id, _pcm, sampleRate) => audioCalls.push({ id, sampleRate }),
      onEvent: (e) => events.push(e)
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p
    client.begin('r1', 'zh')
    ws.emitMessage(JSON.stringify({ type: 'audio_start', id: 'r1', sampleRate: 32000, channels: 1, format: 'pcm_s16le' }))
    ws.emitMessage(new ArrayBuffer(8))
    ws.emitMessage(JSON.stringify({ type: 'done', id: 'r1' }))
    expect(events.map((e) => e.type)).toEqual(['audio_start', 'done'])
    expect(audioCalls).toEqual([{ id: 'r1', sampleRate: 32000 }])
  })

  it('close():关闭 WebSocket 并 kill 子进程', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p
    await client.close()
    expect(ws.close).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/tts/ttsClient.test.ts`
Expected: FAIL(找不到模块 `./ttsClient`)

- [ ] **Step 3: 实现**

创建 `src/main/providers/tts/ttsClient.ts`:

```ts
/** minimal_tts sidecar 客户端,移植自 minimal_tts/electron/AliceTts.ts,依赖全部注入
 *  (spawn/WebSocket/clock),供测试用假实现替换,也解决主进程 Node 20 上下文没有
 *  全局 WebSocket 的问题(由调用方注入一个真实 ws 实例的构造函数)。 */
import type { TtsLanguage } from '@shared/llm'
import {
  type ClientMessage, type ReadyEvent, type ServerEvent,
  isBinaryMessage, parseServerEvent
} from './protocol'
import { createSentenceBuffer, type SentenceBuffer } from './sentenceBuffer'

export interface SpawnedProcess {
  stdout: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void } | null
  stderr: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void } | null
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'exit', cb: (code: number | null) => void): void
  kill(signal?: string): void
}

export interface MinimalWebSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}

const WS_OPEN = 1

export interface TtsClockLike {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(h: ReturnType<typeof setTimeout>): void
}

export interface TtsClientOptions {
  pythonExe: string
  packageRoot: string
  startupTimeoutMs?: number
  spawn: (exe: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProcess
  createWebSocket: (url: string) => MinimalWebSocket
  clock?: TtsClockLike
  onAudio?: (id: string, pcm: ArrayBuffer, sampleRate: number) => void
  onEvent?: (event: ServerEvent) => void
}

export interface TtsClient {
  start(): Promise<ReadyEvent>
  begin(id: string, language: TtsLanguage): void
  pushToken(token: string): void
  finish(): void
  cancel(): void
  close(): Promise<void>
}

export function createTtsClient(opts: TtsClientOptions): TtsClient {
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30000
  const clock: TtsClockLike = opts.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h)
  }

  let child: SpawnedProcess | null = null
  let ws: MinimalWebSocket | null = null
  let ready: ReadyEvent | null = null
  let sequence = 0
  let activeId: string | null = null
  let currentSampleRate = 0
  const buffer: SentenceBuffer = createSentenceBuffer({ onIdle: () => flushBuffer() })

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg))
  }

  function enqueueSegment(text: string): void {
    if (!activeId) return
    send({ type: 'enqueue', id: activeId, sequence: sequence++, text })
  }

  function flushBuffer(): void {
    const remaining = buffer.flush()
    if (remaining) enqueueSegment(remaining)
  }

  function handleMessage(data: unknown): void {
    if (isBinaryMessage(data)) {
      if (activeId) opts.onAudio?.(activeId, data, currentSampleRate)
      return
    }
    if (typeof data !== 'string') return
    let event: ServerEvent
    try { event = parseServerEvent(data) } catch { return }
    if (event.type === 'audio_start') currentSampleRate = event.sampleRate
    if (event.type === 'done' || event.type === 'cancelled') activeId = null
    opts.onEvent?.(event)
  }

  function spawnAndReadReady(): Promise<ReadyEvent> {
    return new Promise<ReadyEvent>((resolve, reject) => {
      const proc = opts.spawn(opts.pythonExe, ['-B', '-m', 'service'], {
        cwd: opts.packageRoot,
        env: { ...process.env, PYTHONPATH: opts.packageRoot, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
      })
      child = proc

      let stdoutBuf = ''
      let resolved = false
      const timer = clock.setTimeout(() => {
        if (resolved) return
        resolved = true
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error('TTS sidecar startup timed out'))
      }, startupTimeoutMs)

      proc.stdout?.setEncoding('utf-8')
      proc.stdout?.on('data', (chunk: string) => {
        if (resolved) return
        stdoutBuf += chunk
        const newlineIdx = stdoutBuf.indexOf('\n')
        if (newlineIdx === -1) return
        const line = stdoutBuf.substring(0, newlineIdx).trim()
        stdoutBuf = stdoutBuf.substring(newlineIdx + 1)
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj['type'] === 'ready') {
            resolved = true
            clock.clearTimeout(timer)
            resolve(obj as unknown as ReadyEvent)
          }
        } catch { /* not a JSON ready line yet */ }
      })
      proc.stderr?.setEncoding('utf-8')
      proc.stderr?.on('data', () => { /* main 进程可按需接管日志,MVP 不做 */ })
      proc.on('error', (err: Error) => {
        if (resolved) return
        resolved = true
        clock.clearTimeout(timer)
        reject(new Error(`Failed to spawn TTS sidecar: ${err.message}`))
      })
      proc.on('exit', (code: number | null) => {
        if (resolved) return
        resolved = true
        clock.clearTimeout(timer)
        reject(new Error(`TTS sidecar exited before ready (code ${code})`))
      })
    })
  }

  function connectWebSocket(url: string): Promise<MinimalWebSocket> {
    return new Promise<MinimalWebSocket>((resolve, reject) => {
      const socket = opts.createWebSocket(url)
      const timer = clock.setTimeout(() => {
        try { socket.close() } catch { /* ignore */ }
        reject(new Error('WebSocket connection timed out'))
      }, 5000)
      socket.onopen = () => { clock.clearTimeout(timer); resolve(socket) }
      socket.onerror = () => {
        if (socket.readyState !== WS_OPEN) { clock.clearTimeout(timer); reject(new Error('WebSocket connection failed')) }
      }
    })
  }

  return {
    async start(): Promise<ReadyEvent> {
      if (ready) return ready
      const r = await spawnAndReadReady()
      const socket = await connectWebSocket(`ws://${r.host}:${r.port}/?token=${r.token}`)
      socket.onmessage = (ev) => handleMessage(ev.data)
      socket.onerror = () => {}
      socket.onclose = () => {}
      ws = socket
      ready = r
      return r
    },
    begin(id, language): void {
      activeId = id
      sequence = 0
      buffer.clear()
      send({ type: 'start', id, language })
    },
    pushToken(token): void {
      for (const segment of buffer.push(token)) enqueueSegment(segment)
    },
    finish(): void {
      flushBuffer()
      if (activeId) send({ type: 'finish', id: activeId })
    },
    cancel(): void {
      if (activeId) send({ type: 'cancel', id: activeId })
      buffer.clear()
      activeId = null
    },
    async close(): Promise<void> {
      buffer.clear()
      if (ws) { try { ws.close() } catch { /* ignore */ } ws = null }
      if (child) { try { child.kill('SIGTERM') } catch { /* ignore */ } child = null }
      ready = null
      activeId = null
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/tts/ttsClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/tts/ttsClient.ts src/main/providers/tts/ttsClient.test.ts
git commit -m "feat(tts): 移植 minimal_tts sidecar 客户端(依赖注入 spawn/WebSocket)"
```

---

## Task 6: 音色切换纯函数(`voiceModelSwitch.ts`)

**Files:**
- Create: `src/main/providers/tts/voiceModelSwitch.ts`
- Test: `src/main/providers/tts/voiceModelSwitch.test.ts`

**Interfaces:**
- Consumes: `TtsLanguage` from `@shared/llm`(Task 1)。
- Produces:
  - `export interface AliceConfig { gpt_weight: string; sovits_lora: string; default_reference: string; prompt_text: string; prompt_language: TtsLanguage; [key: string]: unknown }`
  - `export interface VoiceMeta { promptText: string; promptLanguage: TtsLanguage }`
  - `export function defaultVoiceBackupDir(packageRoot: string): string`
  - `export function hasPetVoice(exists: (p: string) => boolean, petVoiceDir: string): boolean`
  - `export function readVoiceMeta(readFile: (p: string) => string, petVoiceDir: string): VoiceMeta | null`
  - `export interface VoiceCopyPlan { copies: Array<{ from: string; to: string }>; patchedConfig: AliceConfig }`
  - `export function planVoiceSwitch(opts: { packageRoot: string; currentConfig: AliceConfig; petVoiceDir: string | null; petMeta: VoiceMeta | null; backupMeta: VoiceMeta }): VoiceCopyPlan`
  - `export function applyVoiceCopyPlan(plan: VoiceCopyPlan, fs: { copyFileSync: (from: string, to: string) => void; writeFileSync: (path: string, content: string) => void }, configPath: string): void`
  - `export function planBackupDefaultVoice(packageRoot: string, currentConfig: AliceConfig): { copies: Array<{ from: string; to: string }>; metaPath: string; metaJson: string }`

Task 12(`shell/index.ts`)在启动时用真实 `fs` 调用这些函数。

- [ ] **Step 1: 写失败测试**

创建 `src/main/providers/tts/voiceModelSwitch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  defaultVoiceBackupDir, hasPetVoice, readVoiceMeta,
  planVoiceSwitch, applyVoiceCopyPlan, planBackupDefaultVoice,
  type AliceConfig
} from './voiceModelSwitch'
import { join } from 'node:path'

const packageRoot = 'C:\\minimal_tts'
const currentConfig: AliceConfig = {
  version: 'v4',
  gpt_weight: 'models/Alice-e15.ckpt',
  sovits_lora: 'models/Alice_e2_s758_l32.pth',
  sovits_base: 'models/s2Gv4.pth',
  vocoder: 'models/vocoder.pth',
  bert_dir: 'models/chinese-roberta-wwm-ext-large',
  hubert_dir: 'models/chinese-hubert-base',
  default_reference: 'reference/alice.wav',
  prompt_text: 'rpg で例えるなら',
  prompt_language: 'ja'
}

describe('defaultVoiceBackupDir', () => {
  it('固定放在 packageRoot/models/_default_voice', () => {
    expect(defaultVoiceBackupDir(packageRoot)).toBe(join(packageRoot, 'models', '_default_voice'))
  })
})

describe('hasPetVoice', () => {
  it('四个文件都存在 → true', () => {
    const exists = () => true
    expect(hasPetVoice(exists, 'C:\\pets\\luluka\\voice\\tts')).toBe(true)
  })
  it('缺任意一个文件 → false', () => {
    const missing = new Set(['C:\\pets\\luluka\\voice\\tts\\voice.json'])
    const exists = (p: string) => !missing.has(p)
    expect(hasPetVoice(exists, 'C:\\pets\\luluka\\voice\\tts')).toBe(false)
  })
})

describe('readVoiceMeta', () => {
  it('合法 voice.json → 解析 promptText/promptLanguage', () => {
    const readFile = () => JSON.stringify({ promptText: '你好', promptLanguage: 'zh' })
    expect(readVoiceMeta(readFile, 'C:\\pets\\luluka\\voice\\tts')).toEqual({ promptText: '你好', promptLanguage: 'zh' })
  })
  it('promptLanguage 非法 → null', () => {
    const readFile = () => JSON.stringify({ promptText: '你好', promptLanguage: 'fr' })
    expect(readVoiceMeta(readFile, 'x')).toBeNull()
  })
  it('promptText 缺失/非字符串 → null', () => {
    expect(readVoiceMeta(() => JSON.stringify({ promptLanguage: 'zh' }), 'x')).toBeNull()
  })
  it('读取抛错(文件不存在)→ null', () => {
    const readFile = () => { throw new Error('ENOENT') }
    expect(readVoiceMeta(readFile, 'x')).toBeNull()
  })
  it('坏 JSON → null', () => {
    expect(readVoiceMeta(() => '{ not json', 'x')).toBeNull()
  })
})

describe('planVoiceSwitch', () => {
  const backupMeta = { promptText: 'rpg で例えるなら', promptLanguage: 'ja' as const }

  it('宠物有专属音色:从宠物 voice/tts 拷到 config 声明的三个目标路径,config 的 prompt 字段换成宠物的', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig,
      petVoiceDir: 'C:\\pets\\luluka\\voice\\tts',
      petMeta: { promptText: '早安喵', promptLanguage: 'zh' },
      backupMeta
    })
    expect(plan.copies).toEqual([
      { from: 'C:\\pets\\luluka\\voice\\tts\\gpt.ckpt', to: join(packageRoot, 'models/Alice-e15.ckpt') },
      { from: 'C:\\pets\\luluka\\voice\\tts\\sovits.pth', to: join(packageRoot, 'models/Alice_e2_s758_l32.pth') },
      { from: 'C:\\pets\\luluka\\voice\\tts\\reference.wav', to: join(packageRoot, 'reference/alice.wav') }
    ])
    expect(plan.patchedConfig.prompt_text).toBe('早安喵')
    expect(plan.patchedConfig.prompt_language).toBe('zh')
    // 非声音字段原样保留(共享 base 权重不动)
    expect(plan.patchedConfig.sovits_base).toBe('models/s2Gv4.pth')
    expect(plan.patchedConfig.vocoder).toBe('models/vocoder.pth')
  })

  it('宠物没有专属音色(petVoiceDir 为 null):从默认备份拷回,prompt 字段换成备份的', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig, petVoiceDir: null, petMeta: null, backupMeta
    })
    const backupDir = join(packageRoot, 'models', '_default_voice')
    expect(plan.copies).toEqual([
      { from: join(backupDir, 'gpt.ckpt'), to: join(packageRoot, 'models/Alice-e15.ckpt') },
      { from: join(backupDir, 'sovits.pth'), to: join(packageRoot, 'models/Alice_e2_s758_l32.pth') },
      { from: join(backupDir, 'reference.wav'), to: join(packageRoot, 'reference/alice.wav') }
    ])
    expect(plan.patchedConfig.prompt_text).toBe('rpg で例えるなら')
    expect(plan.patchedConfig.prompt_language).toBe('ja')
  })

  it('petVoiceDir 非 null 但 petMeta 是 null(voice.json 解析失败)→ 视同没有专属音色,回退备份', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig, petVoiceDir: 'C:\\pets\\bad\\voice\\tts', petMeta: null, backupMeta
    })
    expect(plan.patchedConfig.prompt_text).toBe(backupMeta.promptText)
  })
})

describe('applyVoiceCopyPlan', () => {
  it('依次执行 copies 并把 patchedConfig 写到 configPath', () => {
    const copyFileSync = vi.fn()
    const writeFileSync = vi.fn()
    const plan = {
      copies: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }],
      patchedConfig: { ...currentConfig, prompt_text: 'x' }
    }
    applyVoiceCopyPlan(plan, { copyFileSync, writeFileSync }, 'C:\\minimal_tts\\config\\alice.json')
    expect(copyFileSync).toHaveBeenNthCalledWith(1, 'a', 'b')
    expect(copyFileSync).toHaveBeenNthCalledWith(2, 'c', 'd')
    expect(writeFileSync).toHaveBeenCalledWith('C:\\minimal_tts\\config\\alice.json', JSON.stringify(plan.patchedConfig, null, 2))
  })
})

describe('planBackupDefaultVoice', () => {
  it('从 currentConfig 声明的三个路径拷到 _default_voice/,并产出 meta.json 内容', () => {
    const plan = planBackupDefaultVoice(packageRoot, currentConfig)
    const backupDir = join(packageRoot, 'models', '_default_voice')
    expect(plan.copies).toEqual([
      { from: join(packageRoot, 'models/Alice-e15.ckpt'), to: join(backupDir, 'gpt.ckpt') },
      { from: join(packageRoot, 'models/Alice_e2_s758_l32.pth'), to: join(backupDir, 'sovits.pth') },
      { from: join(packageRoot, 'reference/alice.wav'), to: join(backupDir, 'reference.wav') }
    ])
    expect(plan.metaPath).toBe(join(backupDir, 'meta.json'))
    expect(JSON.parse(plan.metaJson)).toEqual({ promptText: currentConfig.prompt_text, promptLanguage: currentConfig.prompt_language })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/tts/voiceModelSwitch.test.ts`
Expected: FAIL(找不到模块 `./voiceModelSwitch`)

- [ ] **Step 3: 实现**

创建 `src/main/providers/tts/voiceModelSwitch.ts`:

```ts
/** 按宠物包切换 minimal_tts 音色:纯规划函数(planXxx)+ 薄 apply 函数,
 *  真实 fs 调用只在 shell/index.ts 里接线(见设计文档 §4)。 */
import { join } from 'node:path'
import type { TtsLanguage } from '@shared/llm'

export interface AliceConfig {
  gpt_weight: string
  sovits_lora: string
  default_reference: string
  prompt_text: string
  prompt_language: TtsLanguage
  [key: string]: unknown
}

export interface VoiceMeta { promptText: string; promptLanguage: TtsLanguage }

const TTS_LANGUAGES: TtsLanguage[] = ['zh', 'ja', 'en']

export function defaultVoiceBackupDir(packageRoot: string): string {
  return join(packageRoot, 'models', '_default_voice')
}

/** pets/<id>/voice/tts/{gpt.ckpt,sovits.pth,reference.wav,voice.json} 四份文件都存在才算有专属音色。 */
export function hasPetVoice(exists: (p: string) => boolean, petVoiceDir: string): boolean {
  return (
    exists(join(petVoiceDir, 'gpt.ckpt')) &&
    exists(join(petVoiceDir, 'sovits.pth')) &&
    exists(join(petVoiceDir, 'reference.wav')) &&
    exists(join(petVoiceDir, 'voice.json'))
  )
}

export function readVoiceMeta(readFile: (p: string) => string, petVoiceDir: string): VoiceMeta | null {
  try {
    const raw = JSON.parse(readFile(join(petVoiceDir, 'voice.json'))) as Record<string, unknown>
    if (typeof raw.promptText !== 'string' || !raw.promptText) return null
    if (!TTS_LANGUAGES.includes(raw.promptLanguage as TtsLanguage)) return null
    return { promptText: raw.promptText, promptLanguage: raw.promptLanguage as TtsLanguage }
  } catch {
    return null
  }
}

export interface VoiceCopyPlan {
  copies: Array<{ from: string; to: string }>
  patchedConfig: AliceConfig
}

/** 三份声音文件的拷贝源:宠物有专属音色(petVoiceDir+petMeta 均非空)时用宠物的,否则用默认备份。 */
export function planVoiceSwitch(opts: {
  packageRoot: string
  currentConfig: AliceConfig
  petVoiceDir: string | null
  petMeta: VoiceMeta | null
  backupMeta: VoiceMeta
}): VoiceCopyPlan {
  const useSource = opts.petVoiceDir && opts.petMeta
    ? { dir: opts.petVoiceDir, meta: opts.petMeta }
    : { dir: defaultVoiceBackupDir(opts.packageRoot), meta: opts.backupMeta }

  const copies = [
    { from: join(useSource.dir, 'gpt.ckpt'), to: join(opts.packageRoot, opts.currentConfig.gpt_weight) },
    { from: join(useSource.dir, 'sovits.pth'), to: join(opts.packageRoot, opts.currentConfig.sovits_lora) },
    { from: join(useSource.dir, 'reference.wav'), to: join(opts.packageRoot, opts.currentConfig.default_reference) }
  ]
  const patchedConfig: AliceConfig = {
    ...opts.currentConfig,
    prompt_text: useSource.meta.promptText,
    prompt_language: useSource.meta.promptLanguage
  }
  return { copies, patchedConfig }
}

export function applyVoiceCopyPlan(
  plan: VoiceCopyPlan,
  fs: { copyFileSync: (from: string, to: string) => void; writeFileSync: (path: string, content: string) => void },
  configPath: string
): void {
  for (const c of plan.copies) fs.copyFileSync(c.from, c.to)
  fs.writeFileSync(configPath, JSON.stringify(plan.patchedConfig, null, 2))
}

/** 首次接入 minimal_tts 时,把当前(未被任何宠物覆盖过的)默认音色备份一份到 models/_default_voice/,
 *  供之后"没有专属音色的宠物"回退用。只读 currentConfig,不做存在性判断(是否需要执行由调用方按
 *  meta.json 是否已存在来决定,幂等地跳过)。 */
export function planBackupDefaultVoice(
  packageRoot: string,
  currentConfig: AliceConfig
): { copies: Array<{ from: string; to: string }>; metaPath: string; metaJson: string } {
  const backupDir = defaultVoiceBackupDir(packageRoot)
  const copies = [
    { from: join(packageRoot, currentConfig.gpt_weight), to: join(backupDir, 'gpt.ckpt') },
    { from: join(packageRoot, currentConfig.sovits_lora), to: join(backupDir, 'sovits.pth') },
    { from: join(packageRoot, currentConfig.default_reference), to: join(backupDir, 'reference.wav') }
  ]
  const metaJson = JSON.stringify({ promptText: currentConfig.prompt_text, promptLanguage: currentConfig.prompt_language })
  return { copies, metaPath: join(backupDir, 'meta.json'), metaJson }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/tts/voiceModelSwitch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/tts/voiceModelSwitch.ts src/main/providers/tts/voiceModelSwitch.test.ts
git commit -m "feat(tts): 按宠物包切换 minimal_tts 音色的纯规划函数"
```

---

## Task 7: TTS provider orchestrator(`index.ts`)

**Files:**
- Create: `src/main/providers/tts/index.ts`
- Test: `src/main/providers/tts/index.test.ts`

**Interfaces:**
- Consumes: `TtsClient`(`./ttsClient`,Task 5),`TtsLanguage`(`@shared/llm`,Task 1)。
- Produces: `export interface TtsProvider { start(): Promise<boolean>; begin(id: string, language: TtsLanguage): void; pushToken(token: string): void; finish(): void; cancel(): void; close(): Promise<void> }`,`export function createTtsProvider(opts: { enabled: boolean; client?: TtsClient }): TtsProvider`。Task 9(chat.ts)与 Task 12(shell/index.ts)消费。

- [ ] **Step 1: 写失败测试**

创建 `src/main/providers/tts/index.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTtsProvider } from './index'
import type { TtsClient } from './ttsClient'

function fakeClient(overrides?: Partial<TtsClient>): TtsClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    start: overrides?.start ?? vi.fn(async () => { calls.push('start'); return { type: 'ready', protocol: 1, host: '127.0.0.1', port: 1, token: 't', device: 'cpu', precision: 'fp32' } }),
    begin: vi.fn((id, lang) => calls.push(`begin:${id}:${lang}`)),
    pushToken: vi.fn((t) => calls.push(`pushToken:${t}`)),
    finish: vi.fn(() => calls.push('finish')),
    cancel: vi.fn(() => calls.push('cancel')),
    close: overrides?.close ?? vi.fn(async () => { calls.push('close') })
  }
}

describe('createTtsProvider', () => {
  it('enabled:false → start() 恒返回 false,begin/pushToken/finish/cancel 全部安全 no-op', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: false, client })
    expect(await provider.start()).toBe(false)
    provider.begin('x', 'zh')
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await provider.close()
    expect(client.calls).toEqual([]) // client 从未被真正调用
  })

  it('enabled:true 且 client.start() 成功 → start() 返回 true,后续调用透传给 client', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: true, client })
    expect(await provider.start()).toBe(true)
    provider.begin('x', 'ja')
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await provider.close()
    expect(client.calls).toEqual(['start', 'begin:x:ja', 'pushToken:hi', 'finish', 'cancel', 'close'])
  })

  it('enabled:true 但 client.start() 拒绝 → start() 返回 false,之后调用保持安全 no-op(不抛错)', async () => {
    const client = fakeClient({ start: vi.fn(async () => { throw new Error('sidecar 挂了') }) })
    const provider = createTtsProvider({ enabled: true, client })
    expect(await provider.start()).toBe(false)
    expect(() => provider.begin('x', 'zh')).not.toThrow()
    provider.pushToken('hi')
    provider.finish()
    provider.cancel()
    await expect(provider.close()).resolves.toBeUndefined()
    expect(client.begin).not.toHaveBeenCalled()
  })

  it('enabled:true 但未传 client → start() 返回 false,不抛错', async () => {
    const provider = createTtsProvider({ enabled: true })
    expect(await provider.start()).toBe(false)
    expect(() => provider.begin('x', 'zh')).not.toThrow()
  })

  it('close() 后 available 复位,再调用又变回 no-op', async () => {
    const client = fakeClient()
    const provider = createTtsProvider({ enabled: true, client })
    await provider.start()
    await provider.close()
    provider.begin('x', 'zh')
    expect(client.begin).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/providers/tts/index.test.ts`
Expected: FAIL(找不到模块 `./index`)

- [ ] **Step 3: 实现**

创建 `src/main/providers/tts/index.ts`:

```ts
/** TTS provider orchestrator:enabled 开关 + 启动失败静默降级的安全包装层,
 *  真正的 sidecar 通信全部委托给注入的 TtsClient(见 ttsClient.ts)。 */
import type { TtsLanguage } from '@shared/llm'
import type { TtsClient } from './ttsClient'

export interface TtsProvider {
  /** 尝试启动 sidecar;返回是否可用。enabled:false 或未传 client 时恒返回 false,不抛错。 */
  start(): Promise<boolean>
  begin(id: string, language: TtsLanguage): void
  pushToken(token: string): void
  finish(): void
  cancel(): void
  close(): Promise<void>
}

export function createTtsProvider(opts: { enabled: boolean; client?: TtsClient }): TtsProvider {
  let available = false
  const client = opts.client

  return {
    async start(): Promise<boolean> {
      if (!opts.enabled || !client) return false
      try {
        await client.start()
        available = true
      } catch (e) {
        available = false
        console.warn('[tts] sidecar 启动失败,本次会话降级为纯文字', e)
      }
      return available
    },
    begin(id, language): void { if (available && client) client.begin(id, language) },
    pushToken(token): void { if (available && client) client.pushToken(token) },
    finish(): void { if (available && client) client.finish() },
    cancel(): void { if (available && client) client.cancel() },
    async close(): Promise<void> {
      if (available && client) {
        available = false
        await client.close()
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/providers/tts/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/tts/index.ts src/main/providers/tts/index.test.ts
git commit -m "feat(tts): TTS provider orchestrator(启用开关 + 启动失败静默降级)"
```

---

## Task 8: 翻译辅助(`translate.ts`)

**Files:**
- Create: `src/main/agent/translate.ts`
- Test: `src/main/agent/translate.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`(`../providers/llmProvider`),`runAgent`(`./agentLoop`),`TtsLanguage`(`@shared/llm`)。
- Produces: `export function translateText(opts: { provider: LlmProvider; text: string; targetLanguage: 'ja' | 'en'; signal: AbortSignal; timeoutMs?: number }): Promise<string | null>`。Task 9(chat.ts)消费。

- [ ] **Step 1: 写失败测试**

创建 `src/main/agent/translate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { translateText } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'

describe('translateText', () => {
  it('成功:返回 provider 的完整回复文本(掐头去尾空白)', async () => {
    const provider = createFakeProvider({ reply: '  Good morning!  ' })
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBe('Good morning!')
  })

  it('system prompt 要求整句翻译成目标语言、只输出译文', async () => {
    const seen: string[] = []
    const provider = {
      streamChat: (req: { system: string }) => {
        seen.push(req.system)
        return (async function* () { yield { type: 'text' as const, text: 'おはよう' }; yield { type: 'done' as const } })()
      }
    }
    await translateText({ provider, text: '早安', targetLanguage: 'ja', signal: new AbortController().signal })
    expect(seen[0]).toContain('日语')
  })

  it('取消:signal 提前 abort → 返回 null', async () => {
    const provider = createFakeProvider({ reply: 'x' })
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: ctrl.signal })
    expect(r).toBeNull()
  })

  it('provider 报错 → 返回 null(静默降级,不抛)', async () => {
    const provider = { streamChat: () => (async function* () { yield { type: 'error' as const, message: 'boom' } })() }
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBeNull()
  })

  it('空回复(掐头去尾后为空)→ 返回 null', async () => {
    const provider = createFakeProvider({ reply: '   ' })
    const r = await translateText({ provider, text: '早安', targetLanguage: 'en', signal: new AbortController().signal })
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/agent/translate.test.ts`
Expected: FAIL(找不到模块 `./translate`)

- [ ] **Step 3: 实现**

创建 `src/main/agent/translate.ts`:

```ts
/** 把一段中文文本整句翻译成目标语言,复用当前已配置的 LLM provider(不引入新依赖)。
 *  非流式:等模型吐完整段译文再返回,失败(取消/报错/空回复)一律静默返回 null,
 *  调用方据此决定"跳过朗读,只保留文字气泡"。 */
import type { LlmProvider } from '../providers/llmProvider'
import { runAgent } from './agentLoop'

const LANGUAGE_NAMES = { ja: '日语', en: '英语' } as const

export async function translateText(opts: {
  provider: LlmProvider
  text: string
  targetLanguage: 'ja' | 'en'
  signal: AbortSignal
  timeoutMs?: number
}): Promise<string | null> {
  const res = await runAgent({
    provider: opts.provider,
    system: `你是专业翻译。把用户给出的中文文本完整翻译成${LANGUAGE_NAMES[opts.targetLanguage]},只输出译文本身,不要解释、不要加引号或额外说明。`,
    messages: [{ role: 'user', content: opts.text }],
    maxOutputTokens: 1024,
    timeoutMs: opts.timeoutMs ?? 20000,
    signal: opts.signal,
    onText: () => {}
  })
  if (res.canceled || res.error) return null
  const trimmed = res.text.trim()
  return trimmed.length > 0 ? trimmed : null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/agent/translate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/translate.ts src/main/agent/translate.test.ts
git commit -m "feat(tts): LLM 整句翻译辅助函数(非中文朗读语言用)"
```

---

## Task 9: `chat.ts` 接线(流式 zh + 翻译后整句 ja/en + 打断)

**Files:**
- Modify: `src/main/shell/chat.ts`
- Modify: `src/main/shell/chat.test.ts`

**Interfaces:**
- Consumes: `TtsProvider`(`../providers/tts`,Task 7),`translateText`(`../agent/translate`,Task 8),`TtsLanguage`(`@shared/llm`,Task 1)。
- Produces: `createChatStore` 新增可选注入 `tts?: TtsProvider` 和 `translate?: typeof translateText`。Task 12(shell/index.ts)负责真实注入。

- [ ] **Step 1: 写失败测试**

在 `src/main/shell/chat.test.ts` 里,先把 `makeStore` 的签名扩展一个可选参数(找到 `function makeStore(` 开头那段,改成):

```ts
function makeStore(
  provider: LlmProvider,
  seen: StreamChatRequest[],
  clip?: { readText?: () => string; writeText?: (t: string) => void },
  desktop?: {
    buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]
    wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[]
    buildBrowserTools?: () => import('../tools/toolSpec').ToolSpec[]
  },
  ttsOpts?: {
    tts?: import('../providers/tts').TtsProvider
    translate?: typeof import('../agent/translate').translateText
    settingsOverride?: AppSettings
  }
) {
  const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
  const written: string[] = []
  let done: () => void = () => {}
  const finished = new Promise<void>((r) => { done = r })
  const store = createChatStore({
    petDir: join(dir, 'no-pet'),
    skills: { list: () => [], body: () => null },
    memory,
    todoStore: {
      list: () => [],
      add: (i) => ({ id: 'x', title: i.title, createdAt: 0, dueAt: i.dueAt, done: false, doneAt: null, firedAt: null }),
      toggleDone: () => null,
      remove: () => false,
      markFired: () => {},
      onChange: () => () => {}
    } as TodoStore,
    loadSettings: () => ttsOpts?.settingsOverride ?? settings,
    getKey: () => 'k',
    getSearchKey: () => null,
    getFirecrawlKey: () => firecrawlKey,
    buildDesktopTools: desktop?.buildDesktopTools,
    wrapDesktopTools: desktop?.wrapDesktopTools,
    buildBrowserTools: desktop?.buildBrowserTools,
    makeProvider: () => recording(provider, seen),
    prepareImages: (atts) => atts.map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 })),
    clipboard: { readText: clip?.readText ?? (() => ''), writeText: clip?.writeText ?? ((t) => { written.push(t) }) },
    emitPetEvent: () => {},
    pushUpdate: () => {},
    pushStream: () => {},
    pushStatus: () => {},
    pushDone: () => done(),
    pushError: () => done(),
    openSettings: () => {},
    tts: ttsOpts?.tts,
    translate: ttsOpts?.translate
  })
  return { store, memory, finished, written }
}
```

在文件末尾追加新的 describe 块:

```ts
describe('TTS 接线', () => {
  function fakeTts() {
    const calls: string[] = []
    return {
      calls,
      tts: {
        start: async () => true,
        begin: (id: string, lang: string) => calls.push(`begin:${id}:${lang}`),
        pushToken: (t: string) => calls.push(`pushToken:${t}`),
        finish: () => calls.push('finish'),
        cancel: () => calls.push('cancel'),
        close: async () => {}
      }
    }
  }

  const ttsSettingsZh: AppSettings = { ...settings, tts: { enabled: true, language: 'zh' } }
  const ttsSettingsJa: AppSettings = { ...settings, tts: { enabled: true, language: 'ja' } }

  it('zh:流式 token 边生成边 pushToken,结束调 finish', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store, finished } = makeStore(createFakeProvider({ reply: '你好呀' }), seen, undefined, undefined, { tts, settingsOverride: ttsSettingsZh })
    store.handleSend({ text: '嗨' })
    await finished
    // calls[0] 固定是 'cancel':handleSend 开头无条件调用 cancel()(哪怕没有在途请求),
    // 这样才能打断"发新消息前宠物正在念 lines.json 台词"这种与 chat.ts 自身 inFlight 无关的语音。
    expect(calls[0]).toBe('cancel')
    expect(calls[1]).toMatch(/^begin:chat-\d+:zh$/)
    expect(calls).toContain('pushToken:你好呀')
    expect(calls[calls.length - 1]).toBe('finish')
  })

  it('ja:回复生成阶段不调用 pushToken(zh 专属流式分支不触发);回复完毕后翻译整句,再一次性 begin/pushToken/finish', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const translate = async () => 'おはよう'
    const { store, finished } = makeStore(createFakeProvider({ reply: '早安' }), seen, undefined, undefined, { tts, translate, settingsOverride: ttsSettingsJa })
    store.handleSend({ text: '嗨' })
    await finished
    // pushDone() 在翻译发起之前就已同步调用,finished 在此刻已经 resolve,翻译分支还没跑
    expect(calls.filter((c) => c.startsWith('pushToken')).length).toBe(0)
    await new Promise((r) => setTimeout(r, 0)) // 让翻译分支的微任务/宏任务跑完
    expect(calls).toEqual(expect.arrayContaining([expect.stringMatching(/^begin:chat-\d+:ja$/), 'pushToken:おはよう', 'finish']))
  })

  it('ja:翻译失败(返回 null)→ 静默不朗读,不抛错、不影响文字回复', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const translate = async () => null
    const { store, memory, finished } = makeStore(createFakeProvider({ reply: '早安' }), seen, undefined, undefined, { tts, translate, settingsOverride: ttsSettingsJa })
    store.handleSend({ text: '嗨' })
    await finished
    await new Promise((r) => setTimeout(r, 0)) // 让翻译分支的微任务跑完
    expect(calls.some((c) => c.startsWith('begin'))).toBe(false)
    expect(memory.messages().map((m) => m.text)).toEqual(['嗨', '早安']) // 文字回复不受影响
  })

  it('tts.enabled:false → 不调用 begin/pushToken/finish(cancel() 仍会被调,但那是无条件的兜底,真实 ttsProvider 在禁用态下会安全吸收它)', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store, finished } = makeStore(createFakeProvider({ reply: '你好' }), seen, undefined, undefined, { tts, settingsOverride: settings })
    store.handleSend({ text: '嗨' })
    await finished
    expect(calls.some((c) => c.startsWith('begin') || c.startsWith('pushToken') || c === 'finish')).toBe(false)
  })

  it('新消息打断:cancel() 会调用 tts.cancel()', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store } = makeStore(createFakeProvider({ reply: '你好' }), seen, undefined, undefined, { tts, settingsOverride: ttsSettingsZh })
    store.handleSend({ text: '第一句' })
    store.cancel()
    expect(calls).toContain('cancel')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: FAIL(`createChatStore` 尚不接受 `tts`/`translate` 选项,`calls` 断言不匹配)

- [ ] **Step 3: 实现**

`src/main/shell/chat.ts` 顶部 import 区加:

```ts
import type { TtsProvider } from '../providers/tts'
import { translateText } from '../agent/translate'
```

`createChatStore` 的 `opts` 参数类型里,在 `openSettings: () => void` 后加两个可选字段:

```ts
  openSettings: () => void
  /** TTS provider;未注入(多数既有测试)则全程安全 no-op,与 settings.tts 无关 */
  tts?: TtsProvider
  /** 测试注入缝;生产默认 translateText */
  translate?: typeof translateText
}): ChatStore {
```

`createChatStore` 函数体顶部,`const make = opts.makeProvider ?? createProvider` 后面加:

```ts
  const translate = opts.translate ?? translateText
```

`cancel` 函数改成:

```ts
  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
    opts.tts?.cancel()
  }
```

`handleSend` 里,`const registry = createToolRegistry(tools)` 之后、`const ctrl = new AbortController()` 之前,加:

```ts
      const ttsEnabled = settings.tts.enabled
      const ttsLanguage = settings.tts.language
      const ttsId = `chat-${Date.now()}`
```

`onText: (t) => { acc += t; opts.pushStream(t) }` 改成:

```ts
          onText: (t) => {
            acc += t
            opts.pushStream(t)
            if (ttsEnabled && ttsLanguage === 'zh') opts.tts?.pushToken(t)
          },
```

紧邻 `const res = await runAgent({` 这行**之前**,加上 zh 分支的 begin(必须在流式 onText 触发前调用,所以要放在 `runAgent(...)` 调用之前;由于 `onText` 是传给 `runAgent` 的回调,`runAgent` 内部才会开始流式调用 provider,所以在同一个 IIFE 里、构造 `runAgent` 参数对象之前调用 `opts.tts?.begin` 即可保证时序):

```ts
        if (ttsEnabled && ttsLanguage === 'zh') opts.tts?.begin(ttsId, 'zh')
        const res = await runAgent({
          provider,
          system,
          messages,
          registry,
          maxToolRounds,
          maxOutputTokens: needsBiggerBudget ? DESKTOP_CONTROL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          signal: ctrl.signal,
          onText: (t) => {
            acc += t
            opts.pushStream(t)
            if (ttsEnabled && ttsLanguage === 'zh') opts.tts?.pushToken(t)
          },
          onStatus: (t) => opts.pushStatus(t)
        })
```

`res.canceled`/`res.error`/成功三个分支改成(替换原有的 `if (res.canceled) return` 到函数末尾那一段):

```ts
        if (res.canceled) { if (inFlight === ctrl) inFlight = null; return } // 静默丢弃;cancel() 已经调过 tts.cancel()
        if (res.error) {
          if (acc) opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
          if (ttsEnabled && ttsLanguage === 'zh') opts.tts?.finish()
          if (inFlight === ctrl) inFlight = null
          return
        }
        opts.memory.appendMessage({ role: 'pet', text: acc })
        opts.pushUpdate(opts.memory.messages())
        opts.pushDone()
        opts.emitPetEvent('replyDone')
        if (ttsEnabled && ttsLanguage === 'zh') {
          opts.tts?.finish()
        } else if (ttsEnabled && ttsLanguage !== 'zh' && acc) {
          // 非中文:不流式,等整句生成完毕后翻译再一次性合成。刻意不 null 掉 inFlight,让
          // 期间到来的新消息(handleSend/cancel)的 ctrl.abort() 也能中断这次翻译请求。
          const translated = await translate({ provider, text: acc, targetLanguage: ttsLanguage, signal: ctrl.signal })
          if (translated && !ctrl.signal.aborted) {
            opts.tts?.begin(ttsId, ttsLanguage)
            opts.tts?.pushToken(translated)
            opts.tts?.finish()
          }
        }
        if (inFlight === ctrl) inFlight = null
        // 回复收尾后检查滚动摘要(异步后台,不阻塞下一条)
        opts.memory.maybeSummarize(() => {
          const k = opts.getKey()
          return k ? make(settings.provider, k) : null
        })
      })()
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/chat.test.ts
git commit -m "feat(tts): chat.ts 接线朗读(zh 流式 / ja·en 翻译后整句),新消息打断朗读"
```

---

## Task 10: IPC 通道 + preload `voiceApi`

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `IPC.TTS_AUDIO_START/TTS_AUDIO_CHUNK/TTS_AUDIO_DONE/TTS_AUDIO_CANCELLED/TTS_CHECK_PACKAGE`,`TtsAudioStart`,`TtsAudioChunk`,`VoiceApi`,`window.voiceApi`。`SettingsApi.checkTtsPackage`。Task 11(renderer 播放)与 Task 12(shell 接线)、Task 13(设置页)消费。

- [ ] **Step 1: 修改 `src/shared/ipc.ts`**

在 `IPC` 常量对象的 `CONTEXT_SIGNAL: 'context:signal'` 后加(注意补逗号):

```ts
  CONTEXT_SIGNAL: 'context:signal',
  TTS_AUDIO_START: 'tts:audio-start',
  TTS_AUDIO_CHUNK: 'tts:audio-chunk',
  TTS_AUDIO_DONE: 'tts:audio-done',
  TTS_AUDIO_CANCELLED: 'tts:audio-cancelled',
  TTS_CHECK_PACKAGE: 'tts:check-package'
} as const
```

在 `export interface OverlayRect { ... }` 之后加:

```ts
export interface TtsAudioStart { id: string; sampleRate: number }
export interface TtsAudioChunk { id: string; pcm: ArrayBuffer }

export interface VoiceApi {
  onAudioStart(cb: (d: TtsAudioStart) => void): void
  onAudioChunk(cb: (d: TtsAudioChunk) => void): void
  onAudioDone(cb: (id: string) => void): void
  onAudioCancelled(cb: (id: string) => void): void
}
```

`SettingsApi` 接口末尾(`relaunch(): void` 前后)加一个方法:

```ts
export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  setFirecrawlKey(key: string): Promise<boolean>
  confirmDesktopControl(): Promise<boolean>
  confirmBrowserControl(): Promise<boolean>
  confirmCdpMode(): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
  listPets(): Promise<PetSummary[]>
  importPet(): Promise<ImportResult | null>
  relaunch(): void
  /** 检测某路径(留空则用约定默认路径)下是否存在可用的 minimal_tts 包,供设置页"检测"按钮用 */
  checkTtsPackage(packagePath?: string): Promise<boolean>
}
```

`declare global` 块里的 `interface Window` 加 `voiceApi: VoiceApi`:

```ts
declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi; voiceApi: VoiceApi }
}
```

- [ ] **Step 2: 修改 `src/preload/index.ts`**

顶部 import 里的类型列表加 `VoiceApi, type TtsAudioStart, type TtsAudioChunk`:

```ts
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace, type ContextSignalKind,
  type VoiceApi, type TtsAudioStart, type TtsAudioChunk
} from '@shared/ipc'
```

`settingsApi` 对象里,`relaunch: (): void => ipcRenderer.send(IPC.RELAUNCH_APP)` 后加逗号 + 一行:

```ts
  relaunch: (): void => ipcRenderer.send(IPC.RELAUNCH_APP),
  checkTtsPackage: (packagePath?: string): Promise<boolean> => ipcRenderer.invoke(IPC.TTS_CHECK_PACKAGE, packagePath)
}
```

文件末尾(`contextBridge.exposeInMainWorld('bubbleApi', bubbleApi)` 之前)加:

```ts
const voiceApi: VoiceApi = {
  onAudioStart: (cb: (d: TtsAudioStart) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TTS_AUDIO_START)
    ipcRenderer.on(IPC.TTS_AUDIO_START, (_e, d: TtsAudioStart) => cb(d))
  },
  onAudioChunk: (cb: (d: TtsAudioChunk) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TTS_AUDIO_CHUNK)
    ipcRenderer.on(IPC.TTS_AUDIO_CHUNK, (_e, d: TtsAudioChunk) => cb(d))
  },
  onAudioDone: (cb: (id: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TTS_AUDIO_DONE)
    ipcRenderer.on(IPC.TTS_AUDIO_DONE, (_e, id: string) => cb(id))
  },
  onAudioCancelled: (cb: (id: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TTS_AUDIO_CANCELLED)
    ipcRenderer.on(IPC.TTS_AUDIO_CANCELLED, (_e, id: string) => cb(id))
  }
}
```

`contextBridge.exposeInMainWorld('bubbleApi', bubbleApi)` 后加一行:

```ts
contextBridge.exposeInMainWorld('bubbleApi', bubbleApi)
contextBridge.exposeInMainWorld('voiceApi', voiceApi)
```

- [ ] **Step 3: 运行确认通过**

Run: `pnpm typecheck`
Expected: PASS(preload/ipc 无单测,靠 typecheck 兜底,与项目里其余 IPC 新增一致)

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(tts): 新增 TTS 音频 IPC 通道与 preload voiceApi"
```

---

## Task 11: 渲染层 PCM 播放(`pcmPlayer.ts` + `main.ts` 接线)

**Files:**
- Create: `src/renderer/voice/pcmPlayer.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `window.voiceApi`(Task 10)。
- Produces: `export interface PcmPlayer { start(id: string, sampleRate: number): void; enqueue(id: string, pcm: ArrayBuffer): void; cancel(id: string): void; close(): void }`,`export function createPcmPlayer(): PcmPlayer`。

来源:`D:\LProject\claude_Project\minimal_tts\electron\PcmPlayer.ts`,原样移植成工厂函数(已是函数式接口,原文件是 class,改写成闭包)。这个模块是纯浏览器 Web Audio API,项目里同类模块(如 `spritePlayer.ts` 的 canvas 部分)在 Electron 渲染进程外没有单测环境,遵循既有惯例不写单测,靠 §"真机验收清单"人工验证。

- [ ] **Step 1: 创建 `src/renderer/voice/pcmPlayer.ts`**

```ts
/** 渲染层 PCM 播放,移植自 minimal_tts/electron/PcmPlayer.ts(class 改写成工厂函数,逻辑不变):
 *  int16 PCM → Float32Array,按 Web Audio 时钟顺序调度,取消/替换时停止已排队音频并忽略旧 id 的帧。 */

export interface PcmPlayer {
  start(id: string, sampleRate: number): void
  enqueue(id: string, pcm: ArrayBuffer): void
  cancel(id: string): void
  close(): void
}

export function createPcmPlayer(): PcmPlayer {
  let context: AudioContext | null = null
  let sampleRate = 0
  let activeId: string | null = null
  let nextStartTime = 0
  const sources = new Set<AudioBufferSourceNode>()

  function stopAll(): void {
    for (const source of sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    sources.clear()
    nextStartTime = 0
  }

  return {
    start(id, rate): void {
      if (activeId !== null && activeId !== id) stopAll()
      activeId = id
      sampleRate = rate
      if (!context) context = new AudioContext()
      if (context.state === 'suspended') void context.resume()
      nextStartTime = context.currentTime
    },
    enqueue(id, pcm): void {
      if (id !== activeId || !context) return
      const samples = new Int16Array(pcm)
      const float32 = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i++) float32[i] = samples[i]! / 32768
      const audioBuffer = context.createBuffer(1, float32.length, sampleRate)
      audioBuffer.getChannelData(0).set(float32)
      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      source.addEventListener('ended', () => { sources.delete(source) })
      sources.add(source)
      const startTime = Math.max(nextStartTime, context.currentTime)
      source.start(startTime)
      nextStartTime = startTime + audioBuffer.duration
    },
    cancel(id): void {
      if (id !== activeId) return
      stopAll()
      activeId = null
    },
    close(): void {
      stopAll()
      if (context) { void context.close(); context = null }
      activeId = null
      sampleRate = 0
    }
  }
}
```

- [ ] **Step 2: 接线到 `src/renderer/main.ts`**

打开 `src/renderer/main.ts`,在顶部 import 区加:

```ts
import { createPcmPlayer } from './voice/pcmPlayer'
```

找一个模块初始化的位置(其余 `petApi.onPetEvent`/`petApi.onContextSignal` 之类的订阅注册处附近),加:

```ts
const pcmPlayer = createPcmPlayer()
window.voiceApi.onAudioStart(({ id, sampleRate }) => pcmPlayer.start(id, sampleRate))
window.voiceApi.onAudioChunk(({ id, pcm }) => pcmPlayer.enqueue(id, pcm))
window.voiceApi.onAudioCancelled((id) => pcmPlayer.cancel(id))
```

(`onAudioDone` 不需要特殊处理——PCM 帧本身播完就结束,`done` 事件目前只用于关闭前端可能存在的"正在说话"视觉状态,MVP 暂不加这类状态,故不订阅。)

- [ ] **Step 3: 验证 typecheck 通过**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/voice/pcmPlayer.ts src/renderer/main.ts
git commit -m "feat(tts): 渲染层 PCM 播放(移植 minimal_tts PcmPlayer)"
```

---

## Task 12: `shell/index.ts` 接线(启动音色切换 + sidecar 生命周期 + IPC 接线)

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: 本计划前 11 个任务的全部导出。
- Produces: 无新导出(纯接线);`ttsProvider` 成为 `startShell()` 内的模块级变量,供 `chat`/IPC handler/`will-quit` 共用。

这个任务是纯 Electron 副作用接线,不写单测(与 `automationControl`/`browserControl` 在 `shell/index.ts` 里的真实接线部分同样未单测的既有惯例一致),靠 `pnpm typecheck` + 后续任务的真机验收清单兜底。

- [ ] **Step 1: 顶部 import 区加**

```ts
import { readFileSync as readFileSyncTts, copyFileSync, existsSync as existsSyncTts, writeFileSync as writeFileSyncTts, mkdirSync as mkdirSyncTts } from 'node:fs'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { createTtsClient } from '../providers/tts/ttsClient'
import { createTtsProvider } from '../providers/tts'
import {
  hasPetVoice, readVoiceMeta, planVoiceSwitch, applyVoiceCopyPlan,
  planBackupDefaultVoice, defaultVoiceBackupDir, type AliceConfig
} from '../providers/tts/voiceModelSwitch'
import { resolveLineText } from '../lines/linesLoader'
```

(`existsSyncTts`/`readFileSyncTts`/`writeFileSyncTts`/`mkdirSyncTts` 起别名是因为文件顶部已有 `import { mkdirSync, readFileSync } from 'node:fs'`,避免同名冲突;`copyFileSync` 原文件未导入,不用改名。)

- [ ] **Step 2: 加 `package.json` 依赖**

```bash
pnpm add ws
pnpm add -D @types/ws
```

- [ ] **Step 3: 在 `startShell()` 里,`const chat = createChatStore({` 之前插入 TTS 初始化块**

紧接在 `const automationWithTracking = { ... }` 定义之后(`const chat = createChatStore({` 之前)插入:

```ts
  // ---- TTS(minimal_tts sidecar,见设计文档 2026-07-09-tts-voice-minimal-tts-design.md) ----
  function resolveTtsPackageRoot(configuredPath: string | undefined): string {
    return configuredPath && configuredPath.trim() ? configuredPath.trim() : join(appRoot, 'minimal_tts')
  }
  function readAliceConfig(configPath: string): AliceConfig {
    return JSON.parse(readFileSyncTts(configPath, 'utf-8')) as AliceConfig
  }
  function petVoiceDirFor(dir: string): string {
    return join(dir, 'voice', 'tts')
  }

  const initialSettings = loadSettings(settingsFile)
  let ttsClientInstance: ReturnType<typeof createTtsClient> | undefined
  if (initialSettings.tts.enabled) {
    const ttsPackageRoot = resolveTtsPackageRoot(initialSettings.tts.packagePath)
    const configPath = join(ttsPackageRoot, 'config', 'alice.json')
    try {
      const currentConfig = readAliceConfig(configPath)
      const backupDir = defaultVoiceBackupDir(ttsPackageRoot)
      const backupMetaPath = join(backupDir, 'meta.json')
      if (!existsSyncTts(backupMetaPath)) {
        const backupPlan = planBackupDefaultVoice(ttsPackageRoot, currentConfig)
        mkdirSyncTts(backupDir, { recursive: true })
        for (const c of backupPlan.copies) copyFileSync(c.from, c.to)
        writeFileSyncTts(backupPlan.metaPath, backupPlan.metaJson)
      }
      const backupMeta = JSON.parse(readFileSyncTts(backupMetaPath, 'utf-8')) as { promptText: string; promptLanguage: 'zh' | 'ja' | 'en' }
      const petVoiceDir = petVoiceDirFor(petDir)
      const hasVoice = hasPetVoice(existsSyncTts, petVoiceDir)
      const petMeta = hasVoice ? readVoiceMeta((p) => readFileSyncTts(p, 'utf-8'), petVoiceDir) : null
      const plan = planVoiceSwitch({
        packageRoot: ttsPackageRoot,
        currentConfig,
        petVoiceDir: hasVoice ? petVoiceDir : null,
        petMeta,
        backupMeta
      })
      applyVoiceCopyPlan(plan, { copyFileSync, writeFileSync: writeFileSyncTts }, configPath)

      ttsClientInstance = createTtsClient({
        pythonExe: join(ttsPackageRoot, 'python', 'python.exe'),
        packageRoot: ttsPackageRoot,
        spawn: (exe, args, o) => spawn(exe, args, { ...o, windowsHide: true }),
        createWebSocket: (url) => new WebSocket(url) as unknown as Parameters<typeof createTtsClient>[0]['createWebSocket'] extends (u: string) => infer R ? R : never,
        onEvent: (event) => {
          if (event.type === 'audio_start') petWin.webContents.send(IPC.TTS_AUDIO_START, { id: event.id, sampleRate: event.sampleRate })
          else if (event.type === 'done') petWin.webContents.send(IPC.TTS_AUDIO_DONE, event.id)
          else if (event.type === 'cancelled') petWin.webContents.send(IPC.TTS_AUDIO_CANCELLED, event.id)
          else if (event.type === 'error') console.warn('[tts] 合成错误', event.code, event.message)
        },
        // sampleRate 已经在 audio_start(TTS_AUDIO_START)里给过一次,TtsAudioChunk payload
        // 不重复带(renderer 的 pcmPlayer.enqueue(id, pcm) 也只要这两个字段)。
        onAudio: (id, pcm, _sampleRate) => petWin.webContents.send(IPC.TTS_AUDIO_CHUNK, { id, pcm })
      })
    } catch (e) {
      console.warn('[tts] 初始化失败(minimal_tts 包缺失或损坏),本次会话不提供语音', e)
    }
  }
  const ttsProvider = createTtsProvider({ enabled: initialSettings.tts.enabled, client: ttsClientInstance })
  void ttsProvider.start()
```

- [ ] **Step 4: 修一处类型 workaround**

上一步里 `createWebSocket` 那行用了一个内联条件类型只是为了绕开 `ws` 包的 `WebSocket` 类型和 `MinimalWebSocket` 接口不完全一致的问题,写法比较别扭。改成更直接的写法——把 Step 3 里那一行:

```ts
        createWebSocket: (url) => new WebSocket(url) as unknown as Parameters<typeof createTtsClient>[0]['createWebSocket'] extends (u: string) => infer R ? R : never,
```

替换成:

```ts
        createWebSocket: (url) => new WebSocket(url) as unknown as import('../providers/tts/ttsClient').MinimalWebSocket,
```

- [ ] **Step 5: `createChatStore` 调用里注入 `tts`**

找到 `const chat = createChatStore({` 调用,在 `openSettings: () => openSettings()` 后加逗号 + 一行:

```ts
    openSettings: () => openSettings(),
    tts: ttsProvider
  })
```

- [ ] **Step 6: `PET_SPEAK` 处理器接入朗读**

找到:

```ts
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = pickLine(loadLines(petDir), category, lastLineText ?? undefined)
    if (!line) return // lines.json 缺失或该 category 为空 → 静默降级
    lastLineText = line.text
    showAmbientLine(line.text)
  })
```

改成:

```ts
  ipcMain.on(IPC.PET_SPEAK, (_e, raw) => {
    const category = validateReactionCategory(raw)
    if (!category) return
    if (dialog.isOpen()) return // 对话框开着不冒话
    const line = pickLine(loadLines(petDir), category, lastLineText ?? undefined)
    if (!line) return // lines.json 缺失或该 category 为空 → 静默降级
    lastLineText = line.text
    showAmbientLine(line.text)
    const ttsSettings = loadSettings(settingsFile).tts
    if (ttsSettings.enabled) {
      const spoken = resolveLineText(line, ttsSettings.language)
      ttsProvider.begin(`line-${Date.now()}`, ttsSettings.language)
      ttsProvider.pushToken(spoken)
      ttsProvider.finish()
    }
  })
```

- [ ] **Step 7: `SET_SETTINGS` 关闭开关时释放 sidecar**

找到:

```ts
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => {
    const prev = loadSettings(settingsFile)
    const next = normalizeSettings(raw)
    saveSettings(settingsFile, next)
    if (prev.browserControl.enabled && !next.browserControl.enabled) void browserControl.close()
  })
```

改成:

```ts
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => {
    const prev = loadSettings(settingsFile)
    const next = normalizeSettings(raw)
    saveSettings(settingsFile, next)
    if (prev.browserControl.enabled && !next.browserControl.enabled) void browserControl.close()
    if (prev.tts.enabled && !next.tts.enabled) void ttsProvider.close()
  })
```

- [ ] **Step 8: `TTS_CHECK_PACKAGE` handler**

在 `ipcMain.handle(IPC.TEST_CONNECTION, ...)` 块之后加:

```ts
  ipcMain.handle(IPC.TTS_CHECK_PACKAGE, async (_e, raw): Promise<boolean> => {
    const p = resolveTtsPackageRoot(typeof raw === 'string' ? raw : undefined)
    return existsSyncTts(join(p, 'python', 'python.exe')) && existsSyncTts(join(p, 'service', '__main__.py'))
  })
```

- [ ] **Step 9: `will-quit` 加清理**

找到:

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close() })
```

改成:

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close(); void ttsProvider.close() })
```

- [ ] **Step 10: 运行 typecheck 与全量测试**

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm test`
Expected: PASS(全量回归)

- [ ] **Step 11: Commit**

```bash
git add src/main/shell/index.ts package.json pnpm-lock.yaml
git commit -m "feat(tts): shell 接线(启动音色切换、sidecar 生命周期、PET_SPEAK 朗读、IPC)"
```

---

## Task 13: 设置面板"语音"页

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `window.settingsApi.checkTtsPackage`(Task 10)。

- [ ] **Step 1: `settings.html` 加导航项 + 页面**

在 `<nav id="sidenav">` 里,`<button class="navitem" data-page="memory" ...>记忆</button>` 后加:

```html
          <button class="navitem" data-page="memory" type="button">记忆</button>
          <button class="navitem" data-page="voice" type="button">语音</button>
        </nav>
```

在 `<section class="page" data-page="memory">...</section>` 结束标签之后、`</div>`(`#pages` 结束)之前加:

```html
          <section class="page" data-page="voice">
            <h2>语音(需要本机部署 minimal_tts)</h2>
            <div class="hint">
              语音朗读依赖一个独立的本地 TTS 推理包(minimal_tts),体积约 8GB,不随本程序分发。
              默认关闭,开启前请确认已按说明放好该包。
            </div>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="ttsEnabled" type="checkbox" style="width:auto" />
              <span>启用语音朗读(重启后生效)</span>
            </label>
            <label>朗读语言
              <select id="ttsLanguage">
                <option value="zh">中文</option>
                <option value="ja">日语(中文回复会先翻译成日语再朗读)</option>
                <option value="en">英语(中文回复会先翻译成英语再朗读)</option>
              </select>
            </label>
            <label>minimal_tts 包路径(可选,留空用默认位置)
              <input id="ttsPackagePath" type="text" placeholder="留空则用 <安装目录>/minimal_tts" />
            </label>
            <div class="row">
              <button id="ttsCheckPackage" class="secondary">检测</button>
              <span id="ttsCheckStatus"></span>
            </div>
          </section>

        </div>
```

- [ ] **Step 2: `settings.ts` 加读取/保存/检测逻辑**

顶部 `const $ = ...` 常量区,`const relaunchBtn = ...` 后加:

```ts
const ttsEnabled = $<HTMLInputElement>('ttsEnabled')
const ttsLanguage = $<HTMLSelectElement>('ttsLanguage')
const ttsPackagePath = $<HTMLInputElement>('ttsPackagePath')
const ttsCheckBtn = $<HTMLButtonElement>('ttsCheckPackage')
const ttsCheckStatus = $<HTMLElement>('ttsCheckStatus')
```

`import` 那行加 `type TtsLanguage`:

```ts
import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind, type SearchBackendKind, type TtsLanguage } from '@shared/llm'
```

`$<HTMLButtonElement>('openMemoryDir').addEventListener(...)` 那行之后加:

```ts
ttsCheckBtn.addEventListener('click', async () => {
  ttsCheckStatus.textContent = '检测中…'
  const ok = await window.settingsApi.checkTtsPackage(ttsPackagePath.value.trim() || undefined)
  ttsCheckStatus.textContent = ok ? '✓ 检测到可用的 minimal_tts 包' : '✗ 未检测到,请检查路径'
})
```

`save` 按钮的 `window.settingsApi.setSettings({...})` 调用里,`browserControl: {...}` 后加逗号 + 一行:

```ts
    await window.settingsApi.setSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activePetId: petSelect.value,
      provider,
      search: { backend: searchBackend.value as SearchBackendKind },
      memory: { embedding },
      textTools: { autoCopyResult: autoCopyResult.checked },
      firecrawl: {
        enabled: firecrawlEnabled.checked,
        baseURL: firecrawlBaseURL.value.trim() || undefined
      },
      desktopControl: { enabled: desktopControlEnabled.checked },
      browserControl: {
        enabled: browserControlEnabled.checked,
        mode: browserControlMode.value as 'isolated' | 'cdp',
        chromePath: browserControlChromePath.value.trim() || undefined
      },
      tts: {
        enabled: ttsEnabled.checked,
        language: ttsLanguage.value as TtsLanguage,
        packagePath: ttsPackagePath.value.trim() || undefined
      }
    })
```

初始化 IIFE(`void (async () => { ... })()`)里,`syncBrowserControlModeRow()` 之后、`status.textContent = ...` 之前加:

```ts
  ttsEnabled.checked = snap.settings.tts.enabled
  ttsLanguage.value = snap.settings.tts.language
  ttsPackagePath.value = snap.settings.tts.packagePath ?? ''
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: 真机验证(见 Task 14 的验收清单一并做)**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(tts): 设置面板新增「语音」页(开关/朗读语言/包路径/检测)"
```

---

## Task 14: 打包(`extraResources` + `.gitignore`)与真机验收

**Files:**
- Modify: `electron-builder.yml`
- Modify: `.gitignore`

**Interfaces:** 无新代码接口,收尾任务。

- [ ] **Step 1: `.gitignore` 排除 `minimal_tts`**

在 `.gitignore` 里 `pets/juwang` 那行之后加一行:

```
pets/juwang
/minimal_tts
```

- [ ] **Step 2: `electron-builder.yml` 加 `extraResources` 条目**

打开 `electron-builder.yml`,找到:

```yaml
extraResources:
  - from: pets
    to: pets
    filter:
      - '!**/memory/**'
  - from: skills
    to: skills
  - from: resources
    to: resources
```

改成:

```yaml
extraResources:
  - from: pets
    to: pets
    filter:
      - '!**/memory/**'
  - from: skills
    to: skills
  - from: resources
    to: resources
  # minimal_tts 不随源码分发(见 .gitignore),开发者需自行把它放在仓库根目录的 minimal_tts/
  # 下(与 settings.tts.packagePath 缺省时的开发态约定路径一致)才能被这条规则收进打包产物。
  - from: minimal_tts
    to: minimal_tts
```

- [ ] **Step 3: 开发机放置 `minimal_tts`**

把 `D:\LProject\claude_Project\minimal_tts` 复制或建目录联接(junction)到 `D:\LProject\claude_Project\pet-Agent\minimal_tts`:

```cmd
mklink /J "D:\LProject\claude_Project\pet-Agent\minimal_tts" "D:\LProject\claude_Project\minimal_tts"
```

（用 junction 而不是复制,省一份 ~8GB 磁盘空间;`git status` 应确认它不出现在待跟踪文件里,因为 Step 1 已加了 `.gitignore` 规则。）

- [ ] **Step 4: 真机验收清单(自动化覆盖不到,人工在真实 Windows + CUDA 环境执行)**

- [ ] `pnpm dev` 或 `pnpm build && pnpm preview` 正常启动,无崩溃。
- [ ] 设置 →「语音」页:未开启时点「检测」→ 提示检测到/未检测到与实际情况相符。
- [ ] 勾选启用、保存、重启 app → sidecar 成功拉起(可在任务管理器看到常驻的 `python.exe`)。
- [ ] 中文对话:文字气泡流式打字的同时能听到对应语音,内容/语速大致同步。
- [ ] 语音播放中发送新消息 → 旧语音立即停止,新回复的语音正常开始。
- [ ] 设置里朗读语言切成日语/英语、保存(无需重启,语言只影响后续朗读)→ 发一句中文对话,确认有明显延迟后听到对应语言的语音,且发音语言正确。
- [ ] 断网或故意填错 API key 时切非中文语言 → 翻译失败,确认文字回复仍正常显示、只是没有声音,不报错弹窗。
- [ ] 待机/拖拽等触发 `lines.json` 口癖台词 → 中文默认朗读正常;若某条台词没有 `text_ja`,切到日语后确认它退化朗读中文原文而不是报错或静音。
- [ ] 关闭「启用语音朗读」开关并保存(不重启)→ 确认任务管理器里的 sidecar 进程消失(验证 Task 12 Step 7 的即时释放)。
- [ ] 到 §4"宠物包音色约定"配出一份真实的专属音色(需要你自己按设计文档 §4 的目录结构在某个宠物包下放 `voice/tts/{gpt.ckpt,sovits.pth,reference.wav,voice.json}`)→ 重启 app → 确认声音明显变化;换回没有专属音色的宠物 → 重启 → 确认回退到默认音色而不是残留上一个宠物的声音。
- [ ] `pnpm dist` 打包产物(`dist/win-unpacked/` 或安装后的应用)冒烟:确认 `resources/minimal_tts` 存在、语音功能可正常开启使用(参考项目记忆 `packaged-gui-gpu-crash` 的教训,不能只信开发模式)。

- [ ] **Step 5: Commit**

```bash
git add electron-builder.yml .gitignore
git commit -m "chore(tts): minimal_tts 打包 extraResources + gitignore"
```
