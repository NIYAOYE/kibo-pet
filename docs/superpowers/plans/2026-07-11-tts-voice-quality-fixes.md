# 语音质量问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复语音(TTS)功能的四个已知缺陷——漏句、Markdown 原样朗读导致乱读、播放乱序、特殊符号乱读——同时修复宠物启动后首次朗读明显偏慢的问题。

**Architecture:** 三个独立组件,互不依赖对方的实现细节,只依赖约定好的函数签名:
1. `speakableText.ts`(纯函数):把模型回复的原始 Markdown/符号文本转成适合朗读的纯文本。
2. `voiceProvider.ts`(改造):`speak()` 改成每次调用各自传入 `onChunk`(而不是构造时固定一份),并在内部调用 `toSpeakableText()`。
3. `speechSequencer.ts`(新增):包在 `voiceProvider` 外面,把"哪句先合成完就先播放"改成"永远按文本顺序播放,同时允许最多 2 句在途合成"。`chat.ts` 完全不需要改动——`speechSequencer` 对外暴露的形状和 `chat.ts` 现在期待的 `{getSettings, speak(text), stop()}` 完全一致。

再加一个独立的、没有自动化测试覆盖的 Python 端修复:sidecar 启动时做一次推理预热,把 CUDA 冷启动成本移到启动阶段。

**Tech Stack:** TypeScript(Vitest 单测)、Python(`resources/voice/gsv_server.py`,无自动化测试,手动验收)。

## Global Constraints

- 包管理器用 **pnpm**;跑单个测试文件用 `pnpm vitest run <path>`。
- TDD:每个纯逻辑改动都先写失败的测试,再写实现。
- 提交粒度:每个 Task 结束时一次提交,中文 conventional-commit 风格(如 `feat(voice): ...`、`fix(voice): ...`),遵循本仓库现有 `git log` 里的写法。
- **`src/main/shell/chat.ts` 在本计划里不需要任何改动** —— 它现在对 `opts.voice` 的类型期待是 `{ getSettings: () => TtsSettings; speak: (text: string) => void; stop: () => void }`(见 `chat.ts:84`),`speechSequencer` 严格按这个形状实现,不要"顺便"改 `chat.ts`。
- 改动范围仅限:`src/main/voice/*`、`src/main/shell/index.ts`(仅接线,3 处)、`resources/voice/gsv_server.py`。
- 不引入新的 npm/pip 依赖。

---

### Task 1: `speakableText.ts` —— Markdown/符号 → 可朗读纯文本

**Files:**
- Create: `src/main/voice/speakableText.ts`
- Test: `src/main/voice/speakableText.test.ts`

**Interfaces:**
- Produces: `export function toSpeakableText(raw: string): string` —— 后续 Task 2 会在 `voiceProvider.speak()` 内部调用它。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/voice/speakableText.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toSpeakableText } from './speakableText'

describe('toSpeakableText', () => {
  it('纯文本原样返回', () => {
    expect(toSpeakableText('今天天气不错')).toBe('今天天气不错')
  })

  it('去掉加粗标记,保留文字', () => {
    expect(toSpeakableText('这是**重点**内容')).toBe('这是重点内容')
  })

  it('去掉斜体标记(* 和 _ 两种写法),保留文字', () => {
    expect(toSpeakableText('这是*斜体*文字')).toBe('这是斜体文字')
    expect(toSpeakableText('这是_斜体_文字')).toBe('这是斜体文字')
  })

  it('行内代码整体丢弃', () => {
    expect(toSpeakableText('运行 `pnpm test` 命令')).toBe('运行  命令')
  })

  it('围栏代码块整体丢弃(含多行)', () => {
    const raw = '说明如下:\n```js\nconst a = 1\nconsole.log(a)\n```\n就这样'
    expect(toSpeakableText(raw)).toBe('说明如下:\n\n就这样')
  })

  it('Markdown 链接只读文字,丢弃 URL', () => {
    expect(toSpeakableText('参考[这篇文章](https://example.com/a)')).toBe('参考这篇文章')
  })

  it('标题标记去掉前导 #,保留文字', () => {
    expect(toSpeakableText('## 今日总结')).toBe('今日总结')
  })

  it('无序/有序列表标记去掉前导符号,保留文字', () => {
    expect(toSpeakableText('- 第一项')).toBe('第一项')
    expect(toSpeakableText('* 第二项')).toBe('第二项')
    expect(toSpeakableText('1. 第三项')).toBe('第三项')
  })

  it('表格分隔行整行丢弃,数据行转为顿号连接的纯文本', () => {
    const raw = '|城市|气温|\n|---|---|\n|北京|20|'
    expect(toSpeakableText(raw)).toBe('城市 · 气温\n北京 · 20')
  })

  it('常见数学/单位符号映射成可读文字', () => {
    expect(toSpeakableText('今天20℃,湿度60%')).toBe('今天20摄氏度,湿度60百分之')
    expect(toSpeakableText('3×4÷2')).toBe('3乘4除以2')
    expect(toSpeakableText('a≥b 且 a≠c 且 a≈d,误差±1')).toBe('a大于等于b 且 a不等于c 且 a约等于d,误差正负1')
  })

  it('组合场景:加粗 + 符号一起出现', () => {
    expect(toSpeakableText('**当前气温**:20℃')).toBe('当前气温:20摄氏度')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/voice/speakableText.test.ts`
Expected: FAIL,报错 `Cannot find module './speakableText'`(文件还不存在)。

- [ ] **Step 3: 写最小实现**

创建 `src/main/voice/speakableText.ts`:

```ts
/**
 * 把模型回复的原始 Markdown/特殊符号文本,转成适合朗读的纯文本。
 * 只处理"发音前归一化",不做任何朗读语言/翻译相关的事情。
 */

const CODE_FENCE = /```[\s\S]*?```/g

/** 是否为 Markdown 表格的分隔行(如 |----|----| 或 |:--|:-:|)——与 renderer/markdown.ts 的同名判断保持一致。 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')
}

/** 表格数据行 → 纯文本(去掉首尾竖线,单元格用 · 连接)——与 renderer/markdown.ts 的处理风格保持一致。 */
function tableRowToText(line: string): string {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(' · ')
}

function stripInlineMarkdown(s: string): string {
  s = s.replace(/`[^`]*`/g, '') // 行内代码整体丢弃
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接只留文字
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1') // 加粗
  s = s.replace(/\*([^*\n]+)\*/g, '$1') // 斜体(*)
  s = s.replace(/_([^_\n]+)_/g, '$1') // 斜体(_)
  return s
}

const SYMBOL_MAP: Record<string, string> = {
  '℃': '摄氏度',
  '℉': '华氏度',
  '%': '百分之',
  '×': '乘',
  '÷': '除以',
  '≥': '大于等于',
  '≤': '小于等于',
  '≠': '不等于',
  '≈': '约等于',
  '±': '正负',
  '°': '度'
}
const SYMBOL_PATTERN = /[℃℉%×÷≥≤≠≈±°]/g

function mapSymbols(s: string): string {
  return s.replace(SYMBOL_PATTERN, (ch) => SYMBOL_MAP[ch] ?? ch)
}

export function toSpeakableText(raw: string): string {
  const noCode = raw.replace(CODE_FENCE, '')
  const lines = noCode.split(/\r?\n/).map((line) => {
    if (isTableSeparator(line)) return null
    let l = line
    const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (bullet) l = bullet[1]
    const header = l.match(/^\s*#{1,6}\s+(.*)$/)
    if (header) l = header[1]
    if (l.includes('|')) l = tableRowToText(l)
    l = stripInlineMarkdown(l)
    l = mapSymbols(l)
    return l
  })
  return lines.filter((l): l is string => l !== null).join('\n')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/voice/speakableText.test.ts`
Expected: PASS(全部用例通过)。

> 提示:如果"围栏代码块"那条用例没通过,检查空行数量——`CODE_FENCE` 替换只是把 ` ```...``` ` 这段字符(包含它前后紧邻的换行由原文本保留)替换成空字符串,原来代码块前后的换行符还在,所以结果里代码块位置会留一个空行,断言时按上面给的期望值对齐即可,不要额外去重空行。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/speakableText.ts src/main/voice/speakableText.test.ts
git commit -m "$(cat <<'EOF'
feat(voice): 新增 Markdown/特殊符号朗读前归一化(toSpeakableText)

修复模型回复里的 Markdown 语法和数学/单位符号被原样送去合成导致发音古怪的问题。
EOF
)"
```

---

### Task 2: `voiceProvider.ts` —— `speak()` 改为每次调用传入 `onChunk` + 接入归一化

**Files:**
- Modify: `src/main/voice/voiceProvider.ts`(全文重写,见下方完整内容)
- Modify: `src/main/voice/voiceProvider.test.ts`(全文重写,见下方完整内容)

**Interfaces:**
- Consumes: `toSpeakableText(raw: string): string`(Task 1 产出)
- Produces:
  ```ts
  export interface VoiceProvider {
    speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void>
    stop(): void
  }
  export function createVoiceProvider(opts: {
    sidecar: VoiceSidecar
    translator: Translator
    getSettings: () => TtsSettings
    onError: (message: string) => void
  }): VoiceProvider
  ```
  注意:构造参数**去掉了** `onChunk`(以前固定一份,现在每次 `speak()` 调用各自传入)。Task 3 的 `speechSequencer.ts` 会把这个 `speak` 方法当作 `speakOne` 使用。

- [ ] **Step 1: 改测试(先改成新签名,预期失败)**

用以下内容整体替换 `src/main/voice/voiceProvider.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createVoiceProvider } from './voiceProvider'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'

function fakeSidecar(impl?: Partial<VoiceSidecar>): VoiceSidecar {
  return {
    start: vi.fn(async () => {}),
    speak: vi.fn(async (_req, onChunk) => { onChunk({ audioBase64: 'QUJD', sampleRate: 32000 }) }),
    stop: vi.fn(),
    ...impl
  }
}

describe('createVoiceProvider', () => {
  it('targetLanguage=auto → 不翻译,直接把原文送去合成', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const chunks: PcmChunk[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'auto' }),
      onError: () => {}
    })
    await vp.speak('你好', (c) => chunks.push(c))
    expect(translate).not.toHaveBeenCalled()
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '你好' }), expect.any(Function), expect.any(Object))
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }])
  })

  it('targetLanguage=ja 且文本不含假名 → 先翻译再合成翻译后的文本', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    await vp.speak('你好', () => {})
    expect(translate).toHaveBeenCalledWith('你好', 'ja', expect.any(Object))
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'こんにちは' }), expect.any(Function), expect.any(Object))
  })

  it('targetLanguage=ja 且文本已含假名 → 跳过翻译', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: () => {}
    })
    await vp.speak('こんにちは', () => {})
    expect(translate).not.toHaveBeenCalled()
  })

  it('翻译失败 → onError 收到消息,不调用 sidecar.speak', async () => {
    const translate = vi.fn(async () => { throw new Error('翻译服务不可用') })
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onError: (m) => errors.push(m)
    })
    await vp.speak('你好', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors[0]).toContain('翻译服务不可用')
  })

  it('sidecar.speak 失败 → onError 收到消息', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => { throw new Error('合成失败') }) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    await vp.speak('你好', () => {})
    expect(errors[0]).toContain('合成失败')
  })

  it('空文本/纯空白 → 直接跳过,不调用 sidecar', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    await vp.speak('   ', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
  })

  it('只含 Markdown/符号、归一化后为空 → 直接跳过,不调用 sidecar(不当作错误)', async () => {
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: (m) => errors.push(m)
    })
    await vp.speak('`raw_only_code`', () => {})
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it('发音前会先做 Markdown/符号归一化,再送去合成', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    await vp.speak('**今天20℃**', () => {})
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: '今天20摄氏度' }), expect.any(Function), expect.any(Object))
  })

  it('stop() 让正在进行的 speak() 的 signal 被 abort', async () => {
    let capturedSignal: AbortSignal | null = null
    const sidecar = fakeSidecar({
      speak: vi.fn(async (_req, _onChunk, signal: AbortSignal) => { capturedSignal = signal })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })
    const p = vp.speak('你好', () => {})
    vp.stop()
    await p
    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true)
  })

  it('两句重叠合成时,stop() 必须 abort 全部在途请求(而非仅最后一个)', async () => {
    const capturedSignals: AbortSignal[] = []
    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    const pendingA = new Promise<void>((resolve) => { releaseA = resolve })
    const pendingB = new Promise<void>((resolve) => { releaseB = resolve })

    const sidecar = fakeSidecar({
      speak: vi.fn(async (req: { text: string }, _onChunk, signal: AbortSignal) => {
        capturedSignals.push(signal)
        await (req.text === 'A' ? pendingA : pendingB)
      })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onError: () => {}
    })

    const pA = vp.speak('A', () => {})
    const pB = vp.speak('B', () => {})

    vp.stop()

    releaseA()
    releaseB()
    await pA
    await pB

    expect(capturedSignals).toHaveLength(2)
    expect(capturedSignals.every((s) => s.aborted)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: FAIL(`vp.speak(text, onChunk)` 参数数量与当前实现的 `speak(text)` 不符,`toHaveBeenCalledWith` 断言里的 `text: '今天20摄氏度'` 等新行为也不存在)。

- [ ] **Step 3: 写实现**

用以下内容整体替换 `src/main/voice/voiceProvider.ts`:

```ts
import type { TtsSettings } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'
import { needsTranslation } from './languageDetect'
import { toSpeakableText } from './speakableText'

export interface VoiceProvider {
  speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void>
  stop(): void
}

export function createVoiceProvider(opts: {
  sidecar: VoiceSidecar
  translator: Translator
  getSettings: () => TtsSettings
  onError: (message: string) => void
}): VoiceProvider {
  const inFlight = new Set<AbortController>()

  return {
    async speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void> {
      const speakable = toSpeakableText(text)
      if (!speakable.trim()) return
      const settings = opts.getSettings()
      const ctrl = new AbortController()
      inFlight.add(ctrl)

      try {
        let toSpeak = speakable
        if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
          try {
            toSpeak = await opts.translator.translate(speakable, settings.targetLanguage, ctrl.signal)
          } catch (e) {
            opts.onError(`翻译失败,朗读已跳过本段:${String((e as Error)?.message ?? e)}`)
            return
          }
        }
        if (ctrl.signal.aborted || !toSpeak.trim()) return

        try {
          await opts.sidecar.speak({
            text: toSpeak,
            isCutText: settings.isCutText,
            cutMinLen: settings.cutMinLen,
            cutMute: settings.cutMute,
            synthesisChunking: settings.synthesisChunking,
            speed: settings.speed,
            noiseScale: settings.noiseScale,
            temperature: settings.temperature,
            topK: settings.topK,
            topP: settings.topP,
            repetitionPenalty: settings.repetitionPenalty
          }, onChunk, ctrl.signal)
        } catch (e) {
          opts.onError(`语音合成失败:${String((e as Error)?.message ?? e)}`)
        }
      } finally {
        inFlight.delete(ctrl)
      }
    },
    stop(): void {
      for (const ctrl of inFlight) ctrl.abort()
      inFlight.clear()
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: PASS(全部 10 条用例通过)。

- [ ] **Step 5: 跑一次全量测试,确认没有间接破坏别处**

Run: `pnpm test`
Expected: 全绿(此时 `shell/index.ts` 还没改,可能出现 TS 类型报错——那是 Task 4 的工作,`pnpm test` 本身跑的是 Vitest 单测不做全量 typecheck,应仍是绿的;如果看到 `voiceProvider.ts` 相关以外的测试失败,先停下来排查而不是继续往下做)。

- [ ] **Step 6: 提交**

```bash
git add src/main/voice/voiceProvider.ts src/main/voice/voiceProvider.test.ts
git commit -m "$(cat <<'EOF'
fix(voice): speak() 改为逐次传入 onChunk,并接入朗读前文本归一化

为下一步的语音播放顺序修复做准备——onChunk 从构造时固定一份改成每次调用各自
传入,这样多句并发合成时才能区分音频块归属;同时在合成前调用 toSpeakableText()
去掉 Markdown 语法、映射特殊符号。
EOF
)"
```

---

### Task 3: `speechSequencer.ts` —— 严格按文本顺序播放,允许有限度预取

**Files:**
- Create: `src/main/voice/speechSequencer.ts`
- Test: `src/main/voice/speechSequencer.test.ts`

**Interfaces:**
- Consumes: `PcmChunk`(来自 `./voiceSidecar`)、`TtsSettings`(来自 `@shared/llm`)。不直接依赖 `voiceProvider.ts` 的实现,只依赖形状匹配的 `speakOne: (text: string, onChunk: (c: PcmChunk) => void) => Promise<void>`(Task 2 产出的 `VoiceProvider.speak` 方法可以直接当 `speakOne` 用)。
- Produces:
  ```ts
  export interface SpeechSequencer {
    getSettings: () => TtsSettings
    speak: (text: string) => void
    stop: () => void
  }
  export function createSpeechSequencer(opts: {
    speakOne: (text: string, onChunk: (c: PcmChunk) => void) => Promise<void>
    onChunk: (c: PcmChunk) => void
    getSettings: () => TtsSettings
    stopUnderlying: () => void
  }): SpeechSequencer
  ```
  Task 4 会在 `shell/index.ts` 里用这个替换直接暴露 `voiceProviderInstance` 的地方。这个形状和 `chat.ts:84` 现有的 `voice?:` 字段类型完全一致,`chat.ts` 不需要改。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/voice/speechSequencer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createSpeechSequencer } from './speechSequencer'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'

/** 造一个可以手动控制完成时机的 speakOne:每个文本对应一个可外部 resolve 的 Promise。 */
function makeControllableSpeakOne() {
  const releases = new Map<string, () => void>()
  const calls: string[] = []
  const speakOne = vi.fn((text: string, onChunk: (c: PcmChunk) => void) => {
    calls.push(text)
    return new Promise<void>((resolve) => {
      releases.set(text, () => {
        onChunk({ audioBase64: text, sampleRate: 32000 })
        resolve()
      })
    })
  })
  return {
    speakOne,
    calls,
    /** 让某个文本的合成"完成":发出它的音频块并 resolve 对应的 Promise。 */
    finish: (text: string) => releases.get(text)!()
  }
}

describe('createSpeechSequencer', () => {
  it('单句:speakOne 产生的音频块立即转发', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    finish('第一句')
    await Promise.resolve()
    expect(chunks).toEqual([{ audioBase64: '第一句', sampleRate: 32000 }])
  })

  it('两句合成完成顺序与文本顺序一致时,播放顺序也一致', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    finish('第一句')
    await Promise.resolve()
    finish('第二句')
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第一句', '第二句'])
  })

  it('核心修复:句子 2 比句子 1 先完成合成,播放顺序仍必须是 1 先、2 后', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish, calls } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    // 两句都已经开始合成(有限度预取):
    expect(calls).toEqual(['第一句', '第二句'])
    // 句子 2 先完成 —— 必须被缓冲,不能立即转发
    finish('第二句')
    await Promise.resolve()
    expect(chunks).toEqual([])
    // 句子 1 后完成 —— 此时应先转发 1,再把缓冲住的 2 一起转发
    finish('第一句')
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第一句', '第二句'])
  })

  it('并发上限为 2:第三句在前两句之一完成前不会开始合成', async () => {
    const { speakOne, finish, calls } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: () => {},
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    seq.speak('第三句')
    expect(calls).toEqual(['第一句', '第二句'])
    finish('第一句')
    await Promise.resolve()
    expect(calls).toEqual(['第一句', '第二句', '第三句'])
  })

  it('某句合成失败(reject)不会卡住队列,后续句子正常推进', async () => {
    const chunks: PcmChunk[] = []
    const calls: string[] = []
    const releases = new Map<string, () => void>()
    const speakOne = vi.fn((text: string, onChunk: (c: PcmChunk) => void) => {
      calls.push(text)
      return new Promise<void>((resolve, reject) => {
        releases.set(text, () => {
          if (text === '第一句') reject(new Error('合成失败'))
          else { onChunk({ audioBase64: text, sampleRate: 32000 }); resolve() }
        })
      })
    })
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('第一句')
    seq.speak('第二句')
    releases.get('第一句')!()
    await Promise.resolve()
    await Promise.resolve()
    releases.get('第二句')!()
    await Promise.resolve()
    expect(chunks.map((c) => c.audioBase64)).toEqual(['第二句'])
  })

  it('stop() 清空队列 + 调用 stopUnderlying,之后残留的音频块不再被转发', async () => {
    const chunks: PcmChunk[] = []
    const stopUnderlying = vi.fn()
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying
    })
    seq.speak('第一句')
    seq.speak('第二句')
    seq.stop()
    expect(stopUnderlying).toHaveBeenCalledOnce()
    // 打断之后,即便旧请求最终还是"完成"了(真实场景里是 abort 触发的异常/空结果),
    // 它们的音频块也不应该被转发出去
    finish('第一句')
    finish('第二句')
    await Promise.resolve()
    expect(chunks).toEqual([])
  })

  it('stop() 之后新的 speak() 从头开始正常播放(不受旧一轮影响)', async () => {
    const chunks: PcmChunk[] = []
    const { speakOne, finish } = makeControllableSpeakOne()
    const seq = createSpeechSequencer({
      speakOne, onChunk: (c) => chunks.push(c),
      getSettings: () => DEFAULT_TTS_SETTINGS, stopUnderlying: () => {}
    })
    seq.speak('旧一轮')
    seq.stop()
    seq.speak('新一轮')
    finish('新一轮')
    await Promise.resolve()
    expect(chunks).toEqual([{ audioBase64: '新一轮', sampleRate: 32000 }])
  })

  it('getSettings 透传底层 getSettings', () => {
    const getSettings = vi.fn(() => DEFAULT_TTS_SETTINGS)
    const seq = createSpeechSequencer({
      speakOne: vi.fn(async () => {}), onChunk: () => {},
      getSettings, stopUnderlying: () => {}
    })
    seq.getSettings()
    expect(getSettings).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/voice/speechSequencer.test.ts`
Expected: FAIL,报错 `Cannot find module './speechSequencer'`。

- [ ] **Step 3: 写实现**

创建 `src/main/voice/speechSequencer.ts`:

```ts
import type { TtsSettings } from '@shared/llm'
import type { PcmChunk } from './voiceSidecar'

export interface SpeechSequencer {
  getSettings: () => TtsSettings
  speak: (text: string) => void
  stop: () => void
}

/** 最多同时有多少句在合成中("当前应播放的一句" + "预取的下一句")。 */
const MAX_CONCURRENT = 2

interface QueueItem { seq: number; text: string }
interface SeqBuffer { chunks: PcmChunk[]; finished: boolean }

/**
 * 把"哪句先合成完就先播放"改成"永远按文本顺序播放,同时允许最多
 * MAX_CONCURRENT 句在途合成"。
 *
 * 根因:sidecar 端用 threading.Lock 把并发合成请求串行化,但锁的获取顺序不保证
 * 和请求到达顺序一致;渲染层的播放队列又是"谁先到就排谁"——两层叠加导致乱序。
 * 这里用序号 + 缓冲区确保:只有轮到播放的那一句,它的音频块才会被转发;抢先
 * 合成完的下一句先缓冲住,等前一句真正播完再按顺序放出来。
 */
export function createSpeechSequencer(opts: {
  speakOne: (text: string, onChunk: (c: PcmChunk) => void) => Promise<void>
  onChunk: (c: PcmChunk) => void
  getSettings: () => TtsSettings
  stopUnderlying: () => void
}): SpeechSequencer {
  let nextSeq = 0
  let cursor = 0
  let inFlightCount = 0
  const pending: QueueItem[] = []
  const buffers = new Map<number, SeqBuffer>()

  function bufferFor(seq: number): SeqBuffer {
    let b = buffers.get(seq)
    if (!b) { b = { chunks: [], finished: false }; buffers.set(seq, b) }
    return b
  }

  /** cursor 指向的句子如果已经在缓冲区里"完工"了,就把它放出来,并继续往前推。 */
  function drainReady(): void {
    for (;;) {
      const b = buffers.get(cursor)
      if (!b || !b.finished) return
      for (const c of b.chunks) opts.onChunk(c)
      buffers.delete(cursor)
      cursor++
    }
  }

  function pump(): void {
    while (inFlightCount < MAX_CONCURRENT && pending.length > 0) {
      const item = pending.shift()!
      const seq = item.seq
      inFlightCount++
      void opts.speakOne(item.text, (c) => {
        if (seq === cursor) opts.onChunk(c)
        else if (seq > cursor) bufferFor(seq).chunks.push(c)
        // seq < cursor:属于已被 stop() 跳过的旧一轮,丢弃
      }).finally(() => {
        inFlightCount--
        if (seq === cursor) {
          cursor++
          drainReady()
        } else if (seq > cursor) {
          bufferFor(seq).finished = true
        }
        pump()
      }).catch(() => {
        // speakOne 失败(合成出错)时 .finally() 会让 rejection 继续冒泡;
        // voiceProvider 内部已经把错误报给 onError 了,这里只是防止
        // 出现 unhandled promise rejection,不需要再做任何事。
      })
    }
  }

  return {
    getSettings: opts.getSettings,
    speak(text: string): void {
      pending.push({ seq: nextSeq++, text })
      pump()
    },
    stop(): void {
      opts.stopUnderlying()
      pending.length = 0
      buffers.clear()
      cursor = nextSeq
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/voice/speechSequencer.test.ts`
Expected: PASS(全部 8 条用例通过)。

> 如果"某句合成失败"那条用例没通过:检查 `.finally()` 是否总会执行 `pump()`——无论 `speakOne` 的 Promise 是 resolve 还是 reject,`finally` 都要跑,继续把队列往前推。另外别漏了 `.finally()` 后面那个空的 `.catch(() => {})`——`.finally()` 本身不会"吃掉"上游的 rejection,它执行完回调后会让原来的 rejection 继续往下传;如果不接一个 `.catch()`,`speakOne` 失败时 Vitest 会报 unhandled promise rejection(即便测试断言本身能通过,也会在测试输出里看到一条恼人的警告/报错)。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/speechSequencer.ts src/main/voice/speechSequencer.test.ts
git commit -m "$(cat <<'EOF'
fix(voice): 新增 speechSequencer,修复句子级 TTS 播放乱序/漏句

chat.ts 逐句触发的合成请求本是完全并发的(无排队),sidecar 的锁又不保证 FIFO,
两层叠加导致"后面的话先播放"。speechSequencer 用序号+缓冲区保证播放顺序永远
等于文本顺序,同时保留有限度预取(最多 2 句在途合成)以维持吞吐;某句合成出错
时不再卡住整条队列。
EOF
)"
```

---

### Task 4: 接线 —— `shell/index.ts` 改用 `speechSequencer`

**Files:**
- Modify: `src/main/shell/index.ts:366-367`(新增变量声明)
- Modify: `src/main/shell/index.ts:409-416`(`voiceProviderInstance` 构造去掉 `onChunk`,新增 `speechSequencerInstance` 构造)
- Modify: `src/main/shell/index.ts:464-468`(`voice:` 字段改指向 `speechSequencerInstance`)
- Modify: `src/main/shell/index.ts:870`(`IPC.VOICE_STOP` 处理器改调用 `speechSequencerInstance?.stop()`)

**Interfaces:**
- Consumes: Task 3 产出的 `createSpeechSequencer`;Task 2 改造后的 `createVoiceProvider`(`speak(text, onChunk)` 新签名)。
- 本 Task 无自动化测试(`src/main/shell/index.ts` 现在没有单测文件,是真实 Electron 接线,项目既有惯例是手动 `pnpm dev`/`pnpm preview` 验证)。

- [ ] **Step 1: 加 import**

在 `src/main/shell/index.ts` 里找到:

```ts
import { createVoiceProvider } from '../voice/voiceProvider'
```

改成:

```ts
import { createVoiceProvider } from '../voice/voiceProvider'
import { createSpeechSequencer } from '../voice/speechSequencer'
```

- [ ] **Step 2: 新增 `speechSequencerInstance` 变量**

找到:

```ts
  let voiceProviderInstance: ReturnType<typeof createVoiceProvider> | null = null
  let voiceSidecarInstance: ReturnType<typeof createVoiceSidecar> | null = null
```

改成:

```ts
  let voiceProviderInstance: ReturnType<typeof createVoiceProvider> | null = null
  let speechSequencerInstance: ReturnType<typeof createSpeechSequencer> | null = null
  let voiceSidecarInstance: ReturnType<typeof createVoiceSidecar> | null = null
```

- [ ] **Step 3: 构造 `voiceProviderInstance` 时去掉 `onChunk`,紧接着构造 `speechSequencerInstance`**

找到:

```ts
    const translatorProvider = createProviderForVoice() // 见下方辅助函数
    voiceProviderInstance = createVoiceProvider({
      sidecar,
      translator: createLlmTranslator(translatorProvider),
      getSettings: () => loadSettings(settingsFile).tts,
      onChunk: (c: VoicePcmChunk) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
      onError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
    })
  }
```

改成:

```ts
    const translatorProvider = createProviderForVoice() // 见下方辅助函数
    voiceProviderInstance = createVoiceProvider({
      sidecar,
      translator: createLlmTranslator(translatorProvider),
      getSettings: () => loadSettings(settingsFile).tts,
      onError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
    })
    const vp = voiceProviderInstance
    speechSequencerInstance = createSpeechSequencer({
      speakOne: (text, onChunk) => vp.speak(text, onChunk),
      onChunk: (c: VoicePcmChunk) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
      getSettings: () => loadSettings(settingsFile).tts,
      stopUnderlying: () => vp.stop()
    })
  }
```

> 这里用局部变量 `vp` 捕获非空的 `voiceProviderInstance`,避免 TypeScript 因为闭包里引用可能变成 `null` 的外层变量而报类型错误(`voiceProviderInstance` 这一行赋值完之后,在同一个函数作用域里它就是非空的,但 TS 的控制流分析不会跨闭包保留这个事实)。

- [ ] **Step 4: `voice:` 字段改指向 `speechSequencerInstance`**

找到:

```ts
    voice: {
      getSettings: () => loadSettings(settingsFile).tts,
      speak: (text) => voiceProviderInstance?.speak(text),
      stop: () => voiceProviderInstance?.stop()
    }
```

改成:

```ts
    voice: {
      getSettings: () => loadSettings(settingsFile).tts,
      speak: (text) => speechSequencerInstance?.speak(text),
      stop: () => speechSequencerInstance?.stop()
    }
```

- [ ] **Step 5: `IPC.VOICE_STOP` 处理器改调用 sequencer 的 `stop()`**

找到:

```ts
  ipcMain.on(IPC.VOICE_STOP, () => voiceProviderInstance?.stop())
```

改成:

```ts
  ipcMain.on(IPC.VOICE_STOP, () => speechSequencerInstance?.stop())
```

> 这一处对应"点击宠物打断正在播放的语音"功能。改成调用 sequencer 的 `stop()` 很关键——如果继续只调 `voiceProviderInstance?.stop()`,打断只会中止当前 1-2 个在途的底层合成请求,但 sequencer 自己的待播队列/缓冲区不会被清空,中止请求产生的 rejection 冒泡到 `.finally()` 后 sequencer 还会继续把队列里剩下的句子接着合成播放——达不到"打断后剩余队列全部丢弃"的效果。

- [ ] **Step 6: 类型检查 + 全量测试 + 手动验证**

Run: `pnpm typecheck`
Expected: 通过,无新增类型错误。

Run: `pnpm test`
Expected: 全绿。

Run: `pnpm build && pnpm preview`
Expected: 应用正常启动、宠物窗口正常显示(不崩溃)。**语音真机验收**(需要真实机器+已安装好的语音运行时,不在本 Task 的自动化范围内,留给你自己找时间过一遍):
1. 开启语音、stream 播放模式,让宠物说一段包含多句、带 Markdown(如列表/加粗)和至少一个 ℃/%的回复,确认:朗读顺序与文字顺序一致、听不到 Markdown 符号本身、℃/%等被读成了"摄氏度"/"百分之"。
2. 回复中途点击宠物打断,确认剩余句子不再播放(没有"打断了却还在陆续冒出后面几句"的现象)。
3. 打断后立刻发一条新消息,确认新一轮朗读正常从头播放,没有受旧一轮影响。

- [ ] **Step 7: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "$(cat <<'EOF'
fix(voice): 主进程接线改用 speechSequencer,替换直连 voiceProvider

chat.ts 无需改动——speechSequencer 对外形状与既有 voice 字段类型完全一致。
点击宠物打断语音(VOICE_STOP)也改为调用 sequencer.stop(),确保打断时正确
清空待播队列,而不只是中止底层的 1-2 个在途合成请求。
EOF
)"
```

---

### Task 5: sidecar 启动预热(修复首次朗读慢)

**Files:**
- Modify: `resources/voice/gsv_server.py`

**Interfaces:** 无(Python 脚本,无自动化测试基础设施)。

- [ ] **Step 1: 找到模型加载完成、打印 `READY` 之前的位置**

在 `resources/voice/gsv_server.py` 的 `main()` 函数里找到:

```python
    tts = TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn, models_dir=args.models_dir)
    tts.load_gpt_model(args.gpt_model)
    tts.load_sovits_model(args.sovits_model)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()
```

- [ ] **Step 2: 插入一次真实推理预热**

改成:

```python
    tts = TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn, models_dir=args.models_dir)
    tts.load_gpt_model(args.gpt_model)
    tts.load_sovits_model(args.sovits_model)

    # 首次真实推理会触发 CUDA kernel 编译/cuDNN 算法选择,耗时明显长于后续调用。
    # 在这里用参考音频/文本跑一次丢弃结果的预热推理,把这个成本移到启动阶段
    # (本来就是一个有加载等待的阶段),而不是让用户等第一句真实回复。
    try:
        for _ in tts.infer_stream(
            spk_audio_path=REF_AUDIO,
            prompt_audio_path=REF_AUDIO,
            prompt_audio_text=REF_TEXT,
            text=REF_TEXT,
            is_cut_text=True,
            cut_minlen=10,
            cut_mute=0.3,
            stream_mode="token",
            top_k=15,
            top_p=1.0,
            temperature=1.0,
            repetition_penalty=1.35,
            noise_scale=0.5,
            speed=1.0,
            debug=False,
        ):
            pass
    except Exception as e:
        sys.stderr.write("[voice] 预热推理失败,不影响正常启动:%s\n" % e)
        sys.stderr.flush()

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()
```

- [ ] **Step 3: 手动验证(无自动化测试)**

这段改动依赖真实 GPU/已安装好的语音运行时,在本地沙箱环境里无法运行验证。留给你在真机上确认:
1. 重新启动宠物应用(语音已启用、运行时已安装),观察 sidecar 日志——`READY` 之前应该能看到多了几秒钟的等待(预热推理耗时),而不是直接秒开。
2. 应用启动完成、宠物说第一句话时,朗读开始的延迟应该明显短于之前(不再有"第一次特别慢"的感觉);第二句、第三句延迟应该和第一句接近(证明冷启动成本确实被吸收到启动阶段了,而不是简单地"整体变慢了但看不出差异")。
3. 如果预热本身报错(比如参考音频路径有问题),确认应用仍能正常启动、后续真实朗读请求仍然可用(预热失败不应该导致 sidecar 整体起不来)。

- [ ] **Step 4: 提交**

```bash
git add resources/voice/gsv_server.py
git commit -m "$(cat <<'EOF'
fix(voice): sidecar 启动时预热一次推理,修复首次朗读明显偏慢

模型加载完成后立即可以接收请求,但首次真实推理会触发 CUDA kernel 编译/cuDNN
算法选择,耗时明显长于后续调用。在打印 READY 前用参考音频/文本跑一次丢弃结果
的预热推理,把这个成本移到启动阶段。预热失败不影响正常启动。
EOF
)"
```

---

## 完成后自查清单

- [ ] `pnpm typecheck` 全绿
- [ ] `pnpm test` 全绿(应比开始前多 ~19 条:`speakableText.test.ts` 11 条 + `speechSequencer.test.ts` 8 条,`voiceProvider.test.ts` 从 8 条变 10 条)
- [ ] `pnpm build` 三包均成功
- [ ] `pnpm preview` 冒烟启动无崩溃
- [ ] 真机验收(Task 4 Step 6 + Task 5 Step 3):朗读顺序正确、Markdown/符号不再乱读、打断后队列正确清空、首次朗读延迟明显改善
