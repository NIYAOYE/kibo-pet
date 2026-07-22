# 语音与文字逐段同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当某个 LLM 切分段的首个可播放 PCM 块按顺序转发时，显示该段完整原文；没有可用语音时保持现有 LLM 文字流式输出。

**Architecture:** `toSpeakableText` 只生成本地 TTS 输入，绝不改写 UI 原文。`speechSequencer` 为每一段保存显示回调，在首个 PCM 真正转发前放行；新建 `replyPresenter` 协调 LLM 增量、分句、语音队列和最终聊天记录提交。

**Tech Stack:** TypeScript strict、Electron、Vitest、pnpm。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `src/main/voice/speakableText.ts` / `.test.ts` | 本地清洗 URL、代码、路径与技术标识。 |
| `src/main/voice/voiceProvider.ts` / `.test.ts` | 返回单段合成状态。 |
| `src/main/voice/speechSequencer.ts` / `.test.ts` | 以音频播放顺序放行文字。 |
| `src/main/shell/replyPresenter.ts` / `.test.ts` | 协调 LLM 增量、语音和最终提交。 |
| `src/main/shell/petSession.ts` | 暴露真实语音就绪状态和带显示回调的入队接口。 |
| `src/main/shell/chat.ts` / `.test.ts` | 接入常规聊天与快捷动作。 |

### Task 1: 清洗不可朗读的技术载荷

**Files:**
- Modify: `src/main/voice/speakableText.ts`
- Test: `src/main/voice/speakableText.test.ts`

- [ ] **Step 1: 先写失败测试**

在 `speakableText.test.ts` 添加：

```ts
it('跳过 URL、路径和技术标识，保留自然语言', () => {
  expect(toSpeakableText('详情见 https://example.com/a?x=1。')).toBe('详情见。')
  expect(toSpeakableText('访问 www.example.com 获取资料')).toBe('访问 获取资料')
  expect(toSpeakableText('C:\\work\\pet-Agent\\src\\main.ts')).toBe('')
  expect(toSpeakableText('550e8400-e29b-41d4-a716-446655440000')).toBe('')
})

it('保留链接标签、跳过图片和代码', () => {
  expect(toSpeakableText('请查看[安装说明](https://example.com/install)。')).toBe('请查看安装说明。')
  expect(toSpeakableText('![截图](https://example.com/a.png)')).toBe('')
  expect(toSpeakableText('命令是 `pnpm test`。')).toBe('命令是。')
})

it('跳过 HTML、命令行、哈希与疑似密钥', () => {
  expect(toSpeakableText('结果是 <strong>成功</strong><!-- trace -->。')).toBe('结果是 成功。')
  expect(toSpeakableText('$ pnpm test\n测试通过。')).toBe('测试通过。')
  expect(toSpeakableText('提交 0123456789abcdef0123456789abcdef 后完成。')).toBe('提交 后完成。')
  expect(toSpeakableText('api_1234567890abcdefghij')).toBe('')
})
```

- [ ] **Step 2: 运行测试，确认失败原因是缺少清洗规则**

Run: `pnpm vitest run src/main/voice/speakableText.test.ts`

Expected: FAIL，URL、路径或技术标识仍出现在输出中。

- [ ] **Step 3: 实现确定性清洗器**

在 `speakableText.ts` 的现有 `CODE_FENCE` 之后加入下列常量和辅助函数，并将 `toSpeakableText` 替换为下列完整实现。图片先于普通 Markdown 链接清洗；URL 正则保留句末标点。

```ts
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]*[A-Za-z0-9/#?=&_%~-]/gi
const MAILTO_URL = /mailto:[^\s<>()\[\]{}]+/gi
const DATA_URL = /\bdata:[^\s<>()\[\]{}]+/gi
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const WINDOWS_PATH = /(?:^|\s)[A-Za-z]:\\[^\s]+/g
const UNIX_PATH = /(?:^|\s)(?:~\/|\/)[^\s]+/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const LONG_HASH = /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g
const API_TOKEN = /\b(?:sk|pk|api|token|key)_[A-Za-z0-9_-]{16,}\b/gi

function stripTechnicalPayload(s: string): string {
  return s.replace(HTML_COMMENT, '').replace(MARKDOWN_IMAGE, '').replace(MAILTO_URL, '')
    .replace(DATA_URL, '').replace(BARE_URL, '').replace(HTML_TAG, '').replace(UUID, '')
    .replace(LONG_HASH, '').replace(API_TOKEN, '').replace(WINDOWS_PATH, '').replace(UNIX_PATH, '')
    .replace(/^\s*(?:\$|PS [^>]+>)\s*.*$/gm, '')
}

function normalizeSpeakableWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.;:!?，。；：！？])/g, '$1').trim()
}

export function toSpeakableText(raw: string): string {
  const lines = stripTechnicalPayload(raw).replace(CODE_FENCE, '').split(/\r?\n/).map((line) => {
    if (isTableSeparator(line)) return null
    let l = line
    const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (bullet) l = bullet[1]
    const header = l.match(/^\s*#{1,6}\s+(.*)$/)
    if (header) l = header[1]
    if (l.includes('|')) l = tableRowToText(l)
    return mapSymbols(stripInlineMarkdown(l))
  })
  return normalizeSpeakableWhitespace(lines.filter((l): l is string => l !== null).join('\n'))
}
```

- [ ] **Step 4: 验证清洗器**

Run: `pnpm vitest run src/main/voice/speakableText.test.ts`

Expected: PASS，既有单位、列表、表格和 Markdown 标签用例仍通过。

- [ ] **Step 5: 提交本任务**

```bash
git add src/main/voice/speakableText.ts src/main/voice/speakableText.test.ts
git commit -m "feat(语音): 清洗不可朗读技术内容"
```

### Task 2: 使单段 TTS 有明确结果

**Files:**
- Modify: `src/main/voice/voiceProvider.ts`
- Test: `src/main/voice/voiceProvider.test.ts`

- [ ] **Step 1: 写失败测试**

在 `voiceProvider.test.ts` 添加：

```ts
it('清洗后为空时跳过 sidecar', async () => {
  const sidecar = fakeSidecar()
  const vp = createVoiceProvider({ sidecar, translator: { translate: vi.fn() }, getSettings: () => DEFAULT_TTS_SETTINGS, onError: () => {} })
  await expect(vp.speak('https://example.com/a', () => {})).resolves.toBe('skipped')
  expect(sidecar.speak).not.toHaveBeenCalled()
})

it('sidecar 未返回 PCM 时失败并报告错误', async () => {
  const errors: string[] = []
  const sidecar = fakeSidecar({ speak: vi.fn(async () => {}) })
  const vp = createVoiceProvider({ sidecar, translator: { translate: vi.fn() }, getSettings: () => DEFAULT_TTS_SETTINGS, onError: (m) => errors.push(m) })
  await expect(vp.speak('可朗读文本', () => {})).resolves.toBe('failed')
  expect(errors).toContain('语音合成未返回音频,本段改为仅显示')
})
```

把现有成功、翻译失败和 sidecar 失败测试分别断言为 `spoken`、`failed`、`failed`。

- [ ] **Step 2: 确认测试先失败**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`

Expected: FAIL，当前 `speak()` 返回 `undefined`。

- [ ] **Step 3: 返回 `spoken | skipped | failed`**

将接口及 `speak` 方法改为：

```ts
export type VoiceSynthesisOutcome = 'spoken' | 'skipped' | 'failed'
export interface VoiceProvider {
  speak(text: string, onChunk: (c: PcmChunk) => void): Promise<VoiceSynthesisOutcome>
  stop(): void
}

async speak(text: string, onChunk: (c: PcmChunk) => void): Promise<VoiceSynthesisOutcome> {
  const speakable = toSpeakableText(text)
  if (!speakable) return 'skipped'
  const settings = opts.getSettings()
  const ctrl = new AbortController()
  inFlight.add(ctrl)
  try {
    let toSpeak = speakable
    if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
      try { toSpeak = await opts.translator.translate(speakable, settings.targetLanguage, ctrl.signal) }
      catch (error) { opts.onError(`翻译失败,朗读已跳过本段:${String((error as Error)?.message ?? error)}`); return 'failed' }
    }
    if (ctrl.signal.aborted || !toSpeak.trim()) return 'skipped'
    let receivedAudio = false
    try {
      await opts.sidecar.speak({ text: toSpeak, language: settings.targetLanguage, isCutText: settings.isCutText, cutMinLen: settings.cutMinLen, cutMute: settings.cutMute, synthesisChunking: settings.synthesisChunking, speed: settings.speed, noiseScale: settings.noiseScale, temperature: settings.temperature, topK: settings.topK, topP: settings.topP, repetitionPenalty: settings.repetitionPenalty }, (chunk) => {
        receivedAudio = true; onChunk(chunk)
      }, ctrl.signal)
    } catch (error) { opts.onError(`语音合成失败:${String((error as Error)?.message ?? error)}`); return 'failed' }
    if (!receivedAudio) { opts.onError('语音合成未返回音频,本段改为仅显示'); return 'failed' }
    return 'spoken'
  } finally { inFlight.delete(ctrl) }
}
```

- [ ] **Step 4: 验证 Provider**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`

Expected: PASS，现有 stop/abort 行为不变。

- [ ] **Step 5: 提交本任务**

```bash
git add src/main/voice/voiceProvider.ts src/main/voice/voiceProvider.test.ts
git commit -m "feat(语音): 返回分段合成结果"
```

### Task 3: 将文字放行绑定到音频顺序队列

**Files:**
- Modify: `src/main/voice/speechSequencer.ts`
- Test: `src/main/voice/speechSequencer.test.ts`

- [ ] **Step 1: 写失败测试**

在 `speechSequencer.test.ts` 添加以下两个测试：

```ts
it('在转发首个 PCM 前放行一次文字', async () => {
  const events: string[] = []
  const { speakOne, finish } = makeControllableSpeakOne()
  const seq = createSpeechSequencer({ speakOne, onChunk: () => events.push('audio'), getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {} })
  const displayed = seq.speak('第一句', () => events.push('text'))
  finish('第一句')
  await displayed
  expect(events).toEqual(['text', 'audio'])
})

it('后句先完成时文字和音频仍按原顺序放行', async () => {
  const events: string[] = []
  const { speakOne, finish } = makeControllableSpeakOne()
  const seq = createSpeechSequencer({ speakOne, onChunk: (c) => events.push(`audio:${c.audioBase64}`), getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {} })
  seq.speak('一', () => events.push('text:一'))
  seq.speak('二', () => events.push('text:二'))
  finish('二'); await Promise.resolve(); expect(events).toEqual([])
  finish('一'); await Promise.resolve()
  expect(events).toEqual(['text:一', 'audio:一', 'text:二', 'audio:二'])
})
```

另加一个不调用 `onChunk` 的 `speakOne`，在其 resolve 后断言对应文字仍放行且后项不会阻塞。

- [ ] **Step 2: 确认测试先失败**

Run: `pnpm vitest run src/main/voice/speechSequencer.test.ts`

Expected: FAIL，当前 `speak(text)` 没有回调参数也不返回 Promise。

- [ ] **Step 3: 改造队列 API 和 flush**

使用以下接口与状态；`speakOne` 的返回类型是 `Promise<unknown>`，所以它接受 Provider 的新结果和已有 `Promise<void>` 测试替身。

```ts
export interface SpeechSequencer {
  getSettings: () => TtsSettings
  speak(text: string, onDisplay: () => void): Promise<void>
  stop(): void
}
interface QueueItem { seq: number; text: string; onDisplay: () => void; resolve: () => void; displayed: boolean }
interface SeqBuffer { chunks: PcmChunk[]; finished: boolean }
```

`QueueItem` 同时进入 `pending` 和 `items: Map<number, QueueItem>`。在 `flush()` 里实现：

```ts
function release(item: QueueItem): void {
  if (item.displayed) return
  item.displayed = true
  item.onDisplay()
  item.resolve()
}

if (buffer.chunks.length > 0) {
  release(item)
  for (const chunk of buffer.chunks) opts.onChunk(chunk)
  buffer.chunks = []
}
if (!buffer.finished) return
release(item)
buffers.delete(cursor); items.delete(cursor); cursor++
```

在 `speakOne(...).finally(...)` 中，先跳过 `seq < cursor` 的旧轮回调；其余项标记完成、`flush()` 后继续 `pump()`。`stop()` 必须调用 `stopUnderlying()`、resolve 所有未完成的 Promise、清空 `pending`/`buffers`/`items`，但绝不调用旧项 `onDisplay`。

- [ ] **Step 4: 验证队列**

Run: `pnpm vitest run src/main/voice/speechSequencer.test.ts`

Expected: PASS，原有两句预合成和 PCM 顺序缓冲测试仍通过。

- [ ] **Step 5: 提交本任务**

```bash
git add src/main/voice/speechSequencer.ts src/main/voice/speechSequencer.test.ts
git commit -m "feat(语音): 按首个音频放行文字"
```

### Task 4: 新建回复呈现协调器

**Files:**
- Create: `src/main/shell/replyPresenter.ts`
- Create: `src/main/shell/replyPresenter.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `replyPresenter.test.ts`。用一个 `speak(text, onDisplay)` 可控门面验证：语音未就绪时 `append('立即显示')` 立即调用 `pushStream`；stream 模式中 `append('第一句。')` 在调用 `onDisplay` 前不显示；batch 模式中 `append('甲。乙。')` 在 `finish()` 前不调用 `speak`，在 `finish()` 后按 `['甲。', '乙。']` 入队。

```ts
const voice = {
  isReady: () => true,
  getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, playbackTrigger: 'stream' as const, textSplit: 'sentence' as const }),
  speak: vi.fn((text: string, onDisplay: () => void) => new Promise<void>((resolve) => {
    callbacks.set(text, onDisplay); resolvers.set(text, resolve)
  }))
}
```

- [ ] **Step 2: 确认模块缺失**

Run: `pnpm vitest run src/main/shell/replyPresenter.test.ts`

Expected: FAIL，找不到 `./replyPresenter`。

- [ ] **Step 3: 实现协调器**

创建 `replyPresenter.ts`，实现下列完整模块。`finish` 缓存一个 Promise，防止两次 flush；`show` 始终发送原始段。

```ts
import type { TtsSettings } from '@shared/llm'
import { createSentenceSplitter, createSmartSplitter, type SentenceSplitter } from '../voice/sentenceSplitter'

export interface VoiceReplyGate {
  isReady(): boolean
  getSettings(): TtsSettings
  speak(text: string, onDisplay: () => void): Promise<void>
}
export interface ReplyPresenter { append(delta: string): void; finish(): Promise<void>; cancel(): void }

export function createReplyPresenter(opts: { voice?: VoiceReplyGate; pushStream: (text: string) => void }): ReplyPresenter {
  const enabled = opts.voice?.isReady() === true
  const settings = enabled ? opts.voice!.getSettings() : null
  const splitter: SentenceSplitter | null = !settings ? null : settings.textSplit === 'sentence' ? createSentenceSplitter() : createSmartSplitter()
  const waits = new Set<Promise<void>>()
  let raw = ''; let active = true; let finishPromise: Promise<void> | null = null
  const enqueue = (segment: string): void => {
    let displayed = false
    const show = () => { if (active && !displayed) { displayed = true; opts.pushStream(segment) } }
    const wait = opts.voice!.speak(segment, show).catch(show).finally(() => waits.delete(wait))
    waits.add(wait)
  }
  return {
    append(delta) {
      raw += delta
      if (!settings) { opts.pushStream(delta); return }
      if (settings.playbackTrigger === 'stream') for (const segment of splitter!.push(delta)) enqueue(segment)
    },
    finish() {
      if (finishPromise) return finishPromise
      finishPromise = (async () => {
        if (!settings) return
        if (settings.playbackTrigger === 'batch') for (const segment of splitter!.push(raw)) enqueue(segment)
        const tail = splitter!.flush()
        if (tail) enqueue(tail)
        await Promise.all([...waits])
      })()
      return finishPromise
    },
    cancel() { active = false }
  }
}
```

- [ ] **Step 4: 验证协调器**

Run: `pnpm vitest run src/main/shell/replyPresenter.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/main/shell/replyPresenter.ts src/main/shell/replyPresenter.test.ts
git commit -m "feat(聊天): 增加语音同步呈现协调器"
```

### Task 5: 接入宠物会话与两类聊天回复

**Files:**
- Modify: `src/main/shell/petSession.ts`
- Modify: `src/main/shell/chat.ts`
- Modify: `src/main/shell/chat.test.ts`

- [ ] **Step 1: 写聊天接线失败测试**

在 `chat.test.ts` 的语音接线测试内使用可控门面：`speak` 保存 `onDisplay` 和 resolver。发送 `createFakeProvider({ reply: '第一句。' })` 后，断言 `pushStream` 仍为空；调用保存的 `onDisplay()` 和 resolver 后，断言 `pushStream === ['第一句。']` 且 `pushDone` 才被调用。再加两个用例：只有 URL 的 reply 仍把原 URL 传入 `speak` 并显示；`isReady: () => false` 时每个 provider 增量立即显示且零次 `speak`。

将既有四个 voice mock 统一改为：

```ts
voice: {
  isReady: () => true,
  getSettings: () => ({ ...settings.tts, playbackTrigger: 'stream', textSplit: 'sentence' }),
  speak: (text, onDisplay) => { spoken.push(text); onDisplay(); return Promise.resolve() },
  stop: () => {}
}
```

- [ ] **Step 2: 确认测试先失败**

Run: `pnpm vitest run src/main/shell/chat.test.ts`

Expected: FAIL，当前文字在 `onText` 中提前 `pushStream`。

- [ ] **Step 3: 更新会话语音门面**

从 `replyPresenter.ts` 导入 `VoiceReplyGate`，将 `makeVoiceFacade` 替换为：

```ts
function makeVoiceFacade(): VoiceReplyGate & { stop(): void } {
  return {
    isReady: () => deps.loadSettings().tts.enabled && speechSequencerInstance !== null,
    getSettings: () => deps.loadSettings().tts,
    speak: (text, onDisplay) => speechSequencerInstance?.speak(text, onDisplay) ?? Promise.resolve(),
    stop: () => speechSequencerInstance?.stop()
  }
}
```

- [ ] **Step 4: 复用协调器呈现 LLM 回复**

在 `chat.ts` 导入 `createReplyPresenter`/`ReplyPresenter`，加入 `let activePresenter: ReplyPresenter | null = null`。`cancel()` 的第一段必须是：

```ts
activePresenter?.cancel()
activePresenter = null
if (inFlight) { inFlight.abort(); inFlight = null }
opts.voice?.stop()
```

常规聊天和 `runQuickAction` 都在创建 `AbortController` 后创建 presenter，并将 `runAgent` 的 `onText` 替换为：

```ts
const presenter = createReplyPresenter({ voice: opts.voice, pushStream: opts.pushStream })
activePresenter = presenter
let acc = ''
// runAgent options:
onText: (text) => { acc += text; presenter.append(text) }
```

在每个 `runAgent` 返回分支中：`res.canceled` 时执行 `presenter.cancel()` 后返回；其他分支先 `await presenter.finish()`，再检查 `activePresenter === presenter`。只有通过检查后才能调用 `appendMessage`、`pushUpdate`、`pushDone`、`pushError`、`emitPetEvent('replyDone')`、自动复制或 `maybeSummarize`。删除旧的 `sentenceSplitter`、直接 `pushStream`、`voice.speak(acc)` 和 stream flush 代码。

- [ ] **Step 5: 验证聊天接线**

Run: `pnpm vitest run src/main/shell/chat.test.ts`

Expected: PASS，常规聊天、快捷动作、工具回合和原有 TTS 设置测试均通过。

- [ ] **Step 6: 提交本任务**

```bash
git add src/main/shell/petSession.ts src/main/shell/chat.ts src/main/shell/chat.test.ts
git commit -m "feat(聊天): 按语音片段同步显示回复"
```

### Task 6: 全量验证、真实启动与单一最终提交

**Files:**
- Verify: `src/main/voice/speakableText.test.ts`
- Verify: `src/main/voice/voiceProvider.test.ts`
- Verify: `src/main/voice/speechSequencer.test.ts`
- Verify: `src/main/shell/replyPresenter.test.ts`
- Verify: `src/main/shell/chat.test.ts`

- [ ] **Step 1: 运行针对性回归**

Run: `pnpm vitest run src/main/voice/speakableText.test.ts src/main/voice/voiceProvider.test.ts src/main/voice/speechSequencer.test.ts src/main/shell/replyPresenter.test.ts src/main/shell/chat.test.ts`

Expected: PASS，0 failed。

- [ ] **Step 2: 运行项目验证**

Run: `pnpm test`

Expected: PASS，0 failed。

Run: `pnpm typecheck`

Expected: exit 0。

Run: `pnpm build`

Expected: exit 0。

- [ ] **Step 3: 真实 Electron 冒烟检查**

Run: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; pnpm preview`

Expected: 应用启动且无启动期异常。手动确认：语音未就绪时文字保持 LLM 流式；语音就绪时普通句子在首个声音开始时显示，URL/代码不发声但仍按原顺序显示完整原文。

- [ ] **Step 4: 按项目约束压缩为唯一提交**

先只读核对设计、计划和 Task 1–5 的连续七个提交：

```bash
git log --oneline -7
git diff --name-only HEAD~7 HEAD
```

确认输出只涉及本计划列出的文件后，执行：

```bash
git reset --soft HEAD~7
git commit -m "feat(语音): 同步音频与文字输出"
```

Expected: `git log -1 --oneline` 是唯一最终功能提交，`git status --short` 没有本功能的未提交改动。
