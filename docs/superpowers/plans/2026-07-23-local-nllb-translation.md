# 本地 NLLB 翻译替换 LLM 翻译 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用本地 NLLB-200-distilled-600M（CTranslate2 int8 推理）替换朗读翻译环节里对聊天 LLM 的调用，本地不可用时静默回退现有 LLM 翻译，并让 GSV-TTS-Lite / Genie-TTS 两个 TTS 后端都能在同一次朗读里正确混合发音保留下来的英文与翻译出的中/日文。

**Architecture:** 新增一个独立的本地 Python sidecar（`translate_server.py`，CTranslate2 + sentencepiece，无 torch/transformers）常驻运行、不随宠物切换重启；`Translator` 接口不变，新增 `createLocalNllbTranslator` 实现 + `createFallbackTranslator` 组合装饰器完成"本地优先、静默回退"。翻译预处理与两个 TTS sidecar 共用同一个纯函数 `splitByScript` 判定"哪段英文、哪段非英文"，`SpeakRequest` 协议新增 `segments` 字段把这个判定结果带给 GSV（单次调用内消费）与 Genie（拆成多次调用拼接 PCM）。

**Tech Stack:** TypeScript（Electron 主进程,Vitest）+ Python 3.11（ctranslate2、sentencepiece，标准库 `http.server`）。

## Global Constraints

- 语言范围固定为 `zh`/`ja`/`en`，不扩展到其他语言（源语言与目标语言都在这三者之内）。
- 翻译运行时禁止引入 `torch`/`transformers`；分词用 `sentencepiece` 直接操作，推理用 `ctranslate2`。
- 本地翻译推理固定用 CPU，不提供设备（CUDA）选项。
- 不做流式翻译或目标语言短语级流式提交——整句输入整句输出。
- 不提供"本地翻译 / LLM 翻译"的用户可见切换开关；本地优先，安装/推理失败静默回退 LLM，用户无感知。
- 翻译 sidecar 生命周期不跟宠物切换绑定，应用启动时起一次、常驻到应用退出。
- 不实现占位符替换式整句翻译；英文保留通过"拆段分别翻"实现（见 Task 3 之上文 spec 5.2 节）。
- TDD：所有纯函数/可注入依赖的逻辑必须先写失败测试再实现（`pnpm vitest run <path>`）。
- Python sidecar 的实际推理行为（分词/语言标记/CT2 API 调用）、安装下载全流程、GSV/Genie 真实发音效果，在当前开发环境下**无法自动化验证**——这些点在对应任务里会明确标注为"真机验证清单项"，不会假装已经跑通。
- 提交信息使用 conventional commit 前缀 + 中文描述，遵循仓库现有风格（参考 `git log`）。
- 参考 spec：`docs/superpowers/specs/2026-07-23-local-nllb-translation-design.md`。

---

## Task 1: `detectSourceLanguage()` —— 判定文本本身是什么语言

**Files:**
- Modify: `src/main/voice/languageDetect.ts`
- Test: `src/main/voice/languageDetect.test.ts`

**Interfaces:**
- Produces: `detectSourceLanguage(text: string): 'zh' | 'ja' | 'en'`（导出的纯函数，复用文件内已有的 `CJK`/`KANA` 正则）

- [ ] **Step 1: 写失败测试**

在 `src/main/voice/languageDetect.test.ts` 末尾追加：

```ts
import { needsTranslation, detectSourceLanguage } from './languageDetect'

describe('detectSourceLanguage', () => {
  it('含假名 → ja', () => {
    expect(detectSourceLanguage('こんにちは、元気ですか')).toBe('ja')
  })

  it('纯中文(无假名)→ zh', () => {
    expect(detectSourceLanguage('你好,今天天气不错。')).toBe('zh')
  })

  it('纯英文 → en', () => {
    expect(detectSourceLanguage('Hello, nice weather today.')).toBe('en')
  })

  it('中英混合但中文字符占多数(无假名)→ zh', () => {
    expect(detectSourceLanguage('我觉得 React 这个框架很好用')).toBe('zh')
  })

  it('空文本 → en(无信息时的确定性兜底)', () => {
    expect(detectSourceLanguage('')).toBe('en')
    expect(detectSourceLanguage('   ')).toBe('en')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/languageDetect.test.ts`
Expected: FAIL，报 `detectSourceLanguage is not a function` 或类似的导入错误。

- [ ] **Step 3: 实现**

在 `src/main/voice/languageDetect.ts` 末尾追加（复用文件顶部已有的 `CJK`/`KANA` 常量，不新增正则）：

```ts
/** 粗略判断:这段文本本身是什么语言。本地翻译需要显式源语言码(NLLB 不会自动识别),
 *  复用与 needsTranslation 相同的字符类启发式——含假名判定日语,否则按中文字符占比
 *  判定中文,都不成立时兜底英文。空文本没有可用信息,同样兜底英文,保证函数总有确定返回值。 */
export function detectSourceLanguage(text: string): 'zh' | 'ja' | 'en' {
  const chars = [...text].filter((c) => !/\s/.test(c))
  if (chars.length === 0) return 'en'
  if (chars.some((c) => KANA.test(c))) return 'ja'
  const cjk = chars.filter((c) => CJK.test(c)).length
  if (cjk / chars.length >= 0.5) return 'zh'
  return 'en'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/languageDetect.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/languageDetect.ts src/main/voice/languageDetect.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增源语言检测,供本地翻译选择 NLLB 源语言码

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `splitByScript()` —— 按拉丁字母切分英文/非英文片段

**Files:**
- Create: `src/main/voice/mixedLanguageSplit.ts`
- Test: `src/main/voice/mixedLanguageSplit.test.ts`

**Interfaces:**
- Produces: `type ScriptSegment = { lang: 'en' | 'other'; text: string }`、`splitByScript(text: string): ScriptSegment[]`
- 供 Task 3(翻译预处理)、Task 11(SpeakRequest.segments 构造)共用，是本设计里唯一一处"英文/非英文"切分逻辑。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { splitByScript } from './mixedLanguageSplit'

describe('splitByScript', () => {
  it('纯英文 → 单个 en 片段', () => {
    expect(splitByScript('Hello world')).toEqual([{ lang: 'en', text: 'Hello world' }])
  })

  it('纯中文 → 单个 other 片段', () => {
    expect(splitByScript('你好世界')).toEqual([{ lang: 'other', text: '你好世界' }])
  })

  it('纯日文(含假名)→ 单个 other 片段', () => {
    expect(splitByScript('こんにちは')).toEqual([{ lang: 'other', text: 'こんにちは' }])
  })

  it('中文夹一个英文单词 → 三段,按原文顺序', () => {
    expect(splitByScript('我觉得 React 框架很好用')).toEqual([
      { lang: 'other', text: '我觉得 ' },
      { lang: 'en', text: 'React' },
      { lang: 'other', text: ' 框架很好用' }
    ])
  })

  it('英文片段允许内部空格与常见标点连续算作一段', () => {
    expect(splitByScript('你说 hello, world 对吧')).toEqual([
      { lang: 'other', text: '你说 ' },
      { lang: 'en', text: 'hello, world' },
      { lang: 'other', text: ' 对吧' }
    ])
  })

  it('空文本 → 空数组', () => {
    expect(splitByScript('')).toEqual([])
  })

  it('数字算作英文片段的一部分', () => {
    expect(splitByScript('降水概率 86% 左右')).toEqual([
      { lang: 'other', text: '降水概率 ' },
      { lang: 'en', text: '86' },
      { lang: 'other', text: '% 左右' }
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/mixedLanguageSplit.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
export interface ScriptSegment { lang: 'en' | 'other'; text: string }

/** 一段"拉丁字母/数字开头结尾、中间允许空格与常见半角标点"的连续片段,视为一个英文片段。
 *  句末标点贴着非英文侧(如中文句号、问号前一个字符如果是拉丁字母,这个标点本身不会被
 *  这个正则捕获,会落进相邻的 other 片段)——单独一个标点字符被当作"non-English"送去
 *  翻译或朗读是无害的(翻译一个逗号是恒等操作,朗读一个逗号大多数 TTS 引擎不发声或极短停顿),
 *  不是需要特殊处理的正确性问题。 */
const LATIN_RUN = /[A-Za-z0-9](?:[A-Za-z0-9 '".,!?;:()-]*[A-Za-z0-9])?/g

export function splitByScript(text: string): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  let cursor = 0
  LATIN_RUN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LATIN_RUN.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ lang: 'other', text: text.slice(cursor, match.index) })
    segments.push({ lang: 'en', text: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ lang: 'other', text: text.slice(cursor) })
  return segments
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/mixedLanguageSplit.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/mixedLanguageSplit.ts src/main/voice/mixedLanguageSplit.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增英文/非英文片段切分,供翻译保留英文与 TTS 混合发音共用

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `createFallbackTranslator()` —— 本地优先、失败静默回退 LLM

**Files:**
- Modify: `src/main/voice/translate.ts`
- Test: `src/main/voice/translate.test.ts`

**Interfaces:**
- Consumes: `Translator`（`src/main/voice/translate.ts` 已有接口，不改动）
- Produces: `createFallbackTranslator(opts: { primary: Translator; fallback: Translator; isPrimaryAvailable: () => boolean }): Translator`

- [ ] **Step 1: 写失败测试**

在 `src/main/voice/translate.test.ts` 末尾追加：

```ts
import { createLlmTranslator, createFallbackTranslator, type Translator } from './translate'

function fakeTranslator(impl: (text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal) => Promise<string>): Translator {
  return { translate: impl }
}

describe('createFallbackTranslator', () => {
  it('primary 可用且成功 → 用 primary 结果,不碰 fallback', async () => {
    const fallback = vi.fn(async () => { throw new Error('不该被调用') })
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => '本地译文'),
      fallback: fakeTranslator(fallback),
      isPrimaryAvailable: () => true
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('本地译文')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('primary 不可用 → 直接用 fallback,primary 不会被调用', async () => {
    const primary = vi.fn(async () => { throw new Error('不该被调用') })
    const t = createFallbackTranslator({
      primary: fakeTranslator(primary),
      fallback: fakeTranslator(async () => 'LLM 译文'),
      isPrimaryAvailable: () => false
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('LLM 译文')
    expect(primary).not.toHaveBeenCalled()
  })

  it('primary 可用但抛错(未取消)→ 回退 fallback', async () => {
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => { throw new Error('本地推理超时') }),
      fallback: fakeTranslator(async () => 'LLM 译文'),
      isPrimaryAvailable: () => true
    })
    const out = await t.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('LLM 译文')
  })

  it('primary 抛错且 signal 已取消 → 直接抛出,不回退', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fallback = vi.fn(async () => 'LLM 译文')
    const t = createFallbackTranslator({
      primary: fakeTranslator(async () => { throw new Error('已取消') }),
      fallback: fakeTranslator(fallback),
      isPrimaryAvailable: () => true
    })
    await expect(t.translate('你好', 'ja', ctrl.signal)).rejects.toThrow('已取消')
    expect(fallback).not.toHaveBeenCalled()
  })
})
```

`translate.test.ts` 顶部已有 `import { describe, it, expect } from 'vitest'`，需要把这行改成 `import { describe, it, expect, vi } from 'vitest'`（新增 `vi`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: FAIL，`createFallbackTranslator` 未导出。

- [ ] **Step 3: 实现**

在 `src/main/voice/translate.ts` 末尾追加：

```ts
export function createFallbackTranslator(opts: {
  primary: Translator
  fallback: Translator
  isPrimaryAvailable: () => boolean
}): Translator {
  return {
    async translate(text, target, signal) {
      if (!opts.isPrimaryAvailable()) return opts.fallback.translate(text, target, signal)
      try {
        return await opts.primary.translate(text, target, signal)
      } catch (e) {
        if (signal.aborted) throw e
        return opts.fallback.translate(text, target, signal)
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: PASS，全部用例(含原有 `createLlmTranslator` 用例)通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/translate.ts src/main/voice/translate.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增翻译器回退组合器,本地优先失败静默回退 LLM

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 设置 schema —— 新增 `ttsTranslate`

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Test: `src/main/config/settings.test.ts`

**Interfaces:**
- Produces: `TtsTranslateSettings { runtimeInstallPath: string }`、`DEFAULT_TTS_TRANSLATE_SETTINGS`、`AppSettings.ttsTranslate`、`SETTINGS_SCHEMA_VERSION` 16。

- [ ] **Step 1: 写失败测试**

在 `src/main/config/settings.test.ts` 的 `describe('ttsGenie', ...)` 块之后插入（照抄该块结构，`15`→`16`）：

```ts
describe('ttsTranslate', () => {
  it('缺省 → 默认 runtimeInstallPath 空字符串', () => {
    const f = tmpSettingsFile({ schemaVersion: 11, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).ttsTranslate).toEqual({ runtimeInstallPath: '' })
  })
  it('保留合法的 runtimeInstallPath', () => {
    const f = tmpSettingsFile({ ttsTranslate: { runtimeInstallPath: 'D:/translate-runtime' } })
    expect(loadSettings(f).ttsTranslate).toEqual({ runtimeInstallPath: 'D:/translate-runtime' })
  })
  it('runtimeInstallPath 非字符串 → 回退空字符串', () => {
    const f = tmpSettingsFile({ ttsTranslate: { runtimeInstallPath: 123 } })
    expect(loadSettings(f).ttsTranslate).toEqual({ runtimeInstallPath: '' })
  })
})
```

同时把文件里已有的 `expect(loadSettings(f).schemaVersion).toBe(15)` 断言（`ttsGenie`/`browserControl` 两个 describe 块各一处）改成 `toBe(16)`——这两处断言验证的是"任意归一化都会把 schemaVersion 升到当前版本"，版本号提到 16 后旧断言会失败，需要同步改。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: FAIL——新 describe 块里 `ttsTranslate` 是 `undefined`，两处 `schemaVersion` 断言期望值也对不上（此时代码还是 15）。

- [ ] **Step 3: 实现**

在 `src/shared/llm.ts`：

```ts
export interface TtsTranslateSettings { runtimeInstallPath: string }

export const DEFAULT_TTS_TRANSLATE_SETTINGS: TtsTranslateSettings = {
  runtimeInstallPath: ''
}
```

把这段放在 `DEFAULT_GENIE_TTS_SETTINGS` 定义之后。然后：

- `export const SETTINGS_SCHEMA_VERSION = 15` 改成 `16`。
- `AppSettings` 接口里 `ttsGenie: GenieTtsSettings;` 后面加 `ttsTranslate: TtsTranslateSettings;`。
- `DEFAULT_SETTINGS` 里 `ttsGenie: DEFAULT_GENIE_TTS_SETTINGS,` 后面加 `ttsTranslate: DEFAULT_TTS_TRANSLATE_SETTINGS,`。

在 `src/main/config/settings.ts`：

- import 列表里的 `type GenieTtsSettings` 后面加 `, type TtsTranslateSettings`。
- 在 `const ttsGenie: GenieTtsSettings = { ... }` 之后加：

```ts
const tr = (r.ttsTranslate ?? {}) as Record<string, unknown>
const ttsTranslate: TtsTranslateSettings = {
  runtimeInstallPath: typeof tr.runtimeInstallPath === 'string' ? tr.runtimeInstallPath : DEFAULT_SETTINGS.ttsTranslate.runtimeInstallPath
}
```

- 返回对象里 `ttsGenie,` 后面加 `ttsTranslate,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 跑一次全量 typecheck 确认没有遗漏引用点**

Run: `pnpm typecheck`
Expected: 无新增类型错误。若报错，通常是某处直接字面量构造 `AppSettings`/`DEFAULT_SETTINGS` 的地方缺 `ttsTranslate` 字段（比如某个测试的 fixture）——按报错位置补上 `ttsTranslate: { runtimeInstallPath: '' }`。

- [ ] **Step 6: 提交**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(设置): 新增 ttsTranslate 设置项,schemaVersion 升至 16

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `translateSidecar.ts` —— 本地翻译 sidecar 的 HTTP 客户端抽象

**Files:**
- Create: `src/main/voice/translateSidecar.ts`
- Test: `src/main/voice/translateSidecar.test.ts`

**Interfaces:**
- Consumes: 无(纯抽象,`spawnProcess`/`postJson` 由调用方注入,同 `voiceSidecar.ts` 的模式)
- Produces: `TranslateRequest { text: string; source: 'zh'|'ja'|'en'; target: 'zh'|'ja'|'en' }`、`TranslateSidecar { start(): Promise<void>; translate(req, signal): Promise<string>; stop(): void }`、`createTranslateSidecar(opts): TranslateSidecar`、`DEFAULT_TRANSLATE_TIMEOUT_MS`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTranslateSidecar } from './translateSidecar'

describe('createTranslateSidecar', () => {
  it('start() 起进程并等待就绪', async () => {
    const waitReady = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => ({ kill: vi.fn(), waitReady }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess, postJson: vi.fn() })
    await sc.start()
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(waitReady).toHaveBeenCalledOnce()
  })

  it('translate() 把请求转发给 postJson,返回 translation 字段', async () => {
    const postJson = vi.fn(async () => ({ translation: 'こんにちは' }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    const out = await sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal)
    expect(out).toBe('こんにちは')
    expect(postJson).toHaveBeenCalledWith(8860, '/translate', { text: '你好', source: 'zh', target: 'ja' }, expect.anything())
  })

  it('响应缺 translation 字段 → 抛错', async () => {
    const postJson = vi.fn(async () => ({}))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    await expect(sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal))
      .rejects.toThrow('本地翻译响应格式错误')
  })

  it('已取消的 signal → 立即拒绝,不调用 postJson', async () => {
    const postJson = vi.fn(async () => ({ translation: 'x' }))
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(sc.translate({ text: '你好', source: 'zh', target: 'ja' }, ctrl.signal)).rejects.toThrow()
    expect(postJson).not.toHaveBeenCalled()
  })

  it('超时 → 拒绝并携带超时信息,请求 signal 被 abort', async () => {
    vi.useFakeTimers()
    try {
      const request = { signal: null as AbortSignal | null }
      const postJson = vi.fn((_port, _path, _body, signal: AbortSignal) => {
        request.signal = signal
        return new Promise(() => {})
      })
      const sc = createTranslateSidecar({ port: 8860, spawnProcess: vi.fn(), postJson, timeoutMs: 25 })
      let failure: unknown
      void sc.translate({ text: '你好', source: 'zh', target: 'ja' }, new AbortController().signal)
        .catch((e) => { failure = e })
      await vi.advanceTimersByTimeAsync(25)
      expect(request.signal?.aborted).toBe(true)
      expect((failure as Error).message).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() 杀掉进程', async () => {
    const kill = vi.fn()
    const sc = createTranslateSidecar({ port: 8860, spawnProcess: () => ({ kill, waitReady: vi.fn(async () => {}) }), postJson: vi.fn() })
    await sc.start()
    sc.stop()
    expect(kill).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/translateSidecar.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
export interface TranslateRequest { text: string; source: 'zh' | 'ja' | 'en'; target: 'zh' | 'ja' | 'en' }

/** 单句 CPU 推理正常应在数十到数百毫秒量级完成;5s 已是明显异常,超时即回退 LLM 而不是让这一句卡住整段回复。 */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 5_000

export interface TranslateSidecar {
  start(): Promise<void>
  translate(req: TranslateRequest, signal: AbortSignal): Promise<string>
  stop(): void
}

export function createTranslateSidecar(opts: {
  port: number
  spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
  postJson: (port: number, path: string, body: unknown, signal: AbortSignal) => Promise<unknown>
  timeoutMs?: number
}): TranslateSidecar {
  let proc: { kill(): void } | null = null

  return {
    async start(): Promise<void> {
      const p = opts.spawnProcess()
      proc = p
      await p.waitReady()
    },

    async translate(req: TranslateRequest, signal: AbortSignal): Promise<string> {
      if (signal.aborted) throw new Error('翻译请求已取消')
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS
      const request = new AbortController()
      const onCallerAbort = (): void => request.abort()
      signal.addEventListener('abort', onCallerAbort, { once: true })
      let timeout: ReturnType<typeof setTimeout> | null = null

      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            request.abort()
            reject(new Error(`本地翻译超时(${timeoutMs}ms)`))
          }, timeoutMs)
        })
        const result = await Promise.race([
          opts.postJson(opts.port, '/translate', req, request.signal),
          timeoutPromise
        ]) as { translation?: unknown }
        if (typeof result.translation !== 'string') throw new Error('本地翻译响应格式错误')
        return result.translation
      } finally {
        if (timeout !== null) clearTimeout(timeout)
        signal.removeEventListener('abort', onCallerAbort)
      }
    },

    stop(): void {
      proc?.kill()
      proc = null
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/translateSidecar.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/translateSidecar.ts src/main/voice/translateSidecar.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增本地翻译 sidecar 的 HTTP 客户端抽象

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `createLocalNllbTranslator()` —— 接入 `Translator` 接口

**Files:**
- Modify: `src/main/voice/translate.ts`
- Test: `src/main/voice/translate.test.ts`

**Interfaces:**
- Consumes: `TranslateSidecar`(Task 5)、`detectSourceLanguage`(Task 1)
- Produces: `createLocalNllbTranslator(sidecar: TranslateSidecar): Translator`

- [ ] **Step 1: 写失败测试**

在 `src/main/voice/translate.test.ts` 追加：

```ts
import { createLocalNllbTranslator } from './translate'
import type { TranslateSidecar } from './translateSidecar'

describe('createLocalNllbTranslator', () => {
  it('自动检测源语言,转发给 sidecar.translate', async () => {
    const translate = vi.fn(async () => 'こんにちは')
    const sidecar: TranslateSidecar = { start: vi.fn(), translate, stop: vi.fn() }
    const t = createLocalNllbTranslator(sidecar)
    const signal = new AbortController().signal
    const out = await t.translate('你好', 'ja', signal)
    expect(out).toBe('こんにちは')
    expect(translate).toHaveBeenCalledWith({ text: '你好', source: 'zh', target: 'ja' }, signal)
  })

  it('源语言检测为日语(含假名)时正确传给 sidecar', async () => {
    const translate = vi.fn(async () => 'hello')
    const sidecar: TranslateSidecar = { start: vi.fn(), translate, stop: vi.fn() }
    const t = createLocalNllbTranslator(sidecar)
    await t.translate('こんにちは', 'en', new AbortController().signal)
    expect(translate).toHaveBeenCalledWith({ text: 'こんにちは', source: 'ja', target: 'en' }, expect.anything())
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: FAIL，`createLocalNllbTranslator` 未导出。

- [ ] **Step 3: 实现**

在 `src/main/voice/translate.ts` 顶部 import 区加：

```ts
import type { TranslateSidecar } from './translateSidecar'
import { detectSourceLanguage } from './languageDetect'
```

文件末尾追加：

```ts
export function createLocalNllbTranslator(sidecar: TranslateSidecar): Translator {
  return {
    translate(text, target, signal) {
      const source = detectSourceLanguage(text)
      return sidecar.translate({ text, source, target }, signal)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/translate.ts src/main/voice/translate.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增本地 NLLB Translator 实现,自动检测源语言

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `translate_server.py` —— NLLB 本地翻译 sidecar

**Files:**
- Create: `resources/voice/translate_server.py`

**Interfaces:**
- Produces: 一个监听 `--port` 的 HTTP 服务，POST `/translate`，请求体 `{text, source, target}`（`source`/`target` ∈ `zh`/`ja`/`en`），成功返回 `{translation: string}`(200)，出错返回 `{error: string}`(500)。子进程启动后向 stdout 打印 `READY`（与现有两个 sidecar 的约定一致，`spawnAndWaitForReady` 依赖这个信号）。

这个任务没有自动化测试——当前开发环境没有真实 Python 环境跑得动 ctranslate2 + 600MB 模型，无法在 sandbox 里验证推理是否正确。Step 1 直接是实现,Step 2 是**必须移交用户的真机验证清单**，不是自动化测试。

- [ ] **Step 1: 实现**

```python
"""Pet-Agent 本地翻译 sidecar —— NLLB-200-distilled-600M 的最小推理适配层。

只暴露一个 /translate 端点(同步 JSON,非流式——上游已经决定"整句进整句出"不做流式短语,
不需要 SSE)。用标准库 http.server 实现,不引入 fastapi/uvicorn。

分词直接用 sentencepiece,不引入 transformers/torch:NLLB 官方文档给的示例是用
transformers.AutoTokenizer 包一层,但那样会把 transformers 整个装进来。这里改用
CTranslate2 生态里常见的"纯 sentencepiece + 手工拼语言标记"写法(源语言 token 序列末尾
拼 </s> 加源语言标记,目标语言标记作为 target_prefix 传给 translate_batch,解码时去掉
回显的第一个 token)——这个写法参考自开源项目 ovos-translate-plugin-nllb 的实现,尚未在
真实 ctranslate2/sentencepiece 环境里跑过,需要真机验证(见本文件底部清单),如果目标模型的
sentencepiece 版本要求用 decode_pieces 而非 decode,或 hypotheses 的下标切法不一致,以真实
报错为准调整。
"""
import sys
import json
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctranslate2
import sentencepiece as spm

translator: "ctranslate2.Translator | None" = None
sp: "spm.SentencePieceProcessor | None" = None

# NLLB 官方语言码约定,项目语言范围固定为 zh/ja/en 三者,不扩展。
LANG_CODES = {"zh": "zho_Hans", "ja": "jpn_Jpan", "en": "eng_Latn"}


def _translate(text: str, source: str, target: str) -> str:
    src_tag = LANG_CODES[source]
    tgt_tag = LANG_CODES[target]
    tokens = sp.encode(text, out_type=str)
    source_tokens = tokens + ["</s>", src_tag]
    result = translator.translate_batch(
        [source_tokens], target_prefix=[[tgt_tag]], beam_size=1
    )
    output_tokens = result[0].hypotheses[0][1:]  # 去掉回显的目标语言标记本身
    return sp.decode(output_tokens)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def do_POST(self):
        if self.path != "/translate":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            return

        try:
            text = body["text"]
            source = body["source"]
            target = body["target"]
            if source not in LANG_CODES or target not in LANG_CODES:
                raise ValueError("不支持的语言:%s -> %s" % (source, target))
            translation = _translate(text, source, target) if text.strip() else ""
            payload = json.dumps({"translation": translation})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
        except Exception as e:
            payload = json.dumps({"error": str(e)})
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))


def main():
    global translator, sp

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--model-dir", required=True,
        help="包含 model.bin/config.json/sentencepiece.bpe.model 的目录(见 translateRuntimeInstall 的下载步骤)"
    )
    args = parser.parse_args()

    sp = spm.SentencePieceProcessor()
    sp.load(args.model_dir.rstrip("/\\") + "/sentencepiece.bpe.model")
    translator = ctranslate2.Translator(args.model_dir, device="cpu")

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 真机验证清单(移交用户,不在本任务内自动完成)**

- 用真实安装好的运行时跑一次:`python translate_server.py --port 8861 --model-dir <安装目录>/nllb-model`，确认打印 `READY` 且进程不退出。
- 用 `curl`/Postman 发一次真实请求，比如 `{"text": "你好,今天天气不错。", "source": "zh", "target": "ja"}`，确认返回的 `translation` 是合理的日语译文，不是报错、不是原文回显。
- 确认 `sp.decode(output_tokens)` 这一行在真实 sentencepiece 版本下能正常工作；如果报错或输出明显不对（比如带多余的下划线 `▁`），改用 `sp.decode_pieces(output_tokens)` 或检查 `hypotheses[0]` 的实际结构调整切片。
- 测一句英文原样保留场景（比如 `{"text": "React", "source": "en", "target": "zh"}`）确认单词级短句也能正常出结果，不会因为太短报错。
- 记录一次真实单句推理耗时，确认落在 Task 5 的 5s 超时阈值以内（预期数十到数百毫秒）。

---

## Task 8: `translateRuntimeMarker.ts` —— 安装完成标记文件

**Files:**
- Create: `src/main/voice/translateRuntimeMarker.ts`
- Test: `src/main/voice/translateRuntimeMarker.test.ts`

**Interfaces:**
- Produces: `TRANSLATE_RUNTIME_MARKER_VERSION`、`TranslateRuntimeMarker { markerVersion: number; nllbModelRepo: string }`、`parseTranslateRuntimeMarker`、`isTranslateRuntimeUsable`、`serializeTranslateRuntimeMarker`

- [ ] **Step 1: 写失败测试**

参考 `src/main/voice/genieRuntimeMarker.test.ts` 的结构（若该文件存在就照抄改名字；若没有独立测试文件，按下面写）：

```ts
import { describe, it, expect } from 'vitest'
import {
  TRANSLATE_RUNTIME_MARKER_VERSION,
  parseTranslateRuntimeMarker,
  isTranslateRuntimeUsable,
  serializeTranslateRuntimeMarker
} from './translateRuntimeMarker'

describe('translateRuntimeMarker', () => {
  it('序列化再解析,内容不变', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION, nllbModelRepo: 'JustFrederik/nllb-200-distilled-600M-ct2-int8' }
    expect(parseTranslateRuntimeMarker(serializeTranslateRuntimeMarker(m))).toEqual(m)
  })

  it('版本号不匹配 → 不可用', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION + 1, nllbModelRepo: 'x' }
    expect(isTranslateRuntimeUsable(m)).toBe(false)
  })

  it('null → 不可用', () => {
    expect(isTranslateRuntimeUsable(null)).toBe(false)
  })

  it('版本号匹配 → 可用', () => {
    const m = { markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION, nllbModelRepo: 'x' }
    expect(isTranslateRuntimeUsable(m)).toBe(true)
  })

  it('损坏的 JSON → 解析返回 null', () => {
    expect(parseTranslateRuntimeMarker('not json')).toBeNull()
  })

  it('缺字段 → 解析返回 null', () => {
    expect(parseTranslateRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/translateRuntimeMarker.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
export const TRANSLATE_RUNTIME_MARKER_VERSION = 1

export interface TranslateRuntimeMarker {
  markerVersion: number
  nllbModelRepo: string
}

export function parseTranslateRuntimeMarker(raw: string): TranslateRuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.nllbModelRepo !== 'string') return null
    return { markerVersion: j.markerVersion, nllbModelRepo: j.nllbModelRepo }
  } catch {
    return null
  }
}

export function isTranslateRuntimeUsable(marker: TranslateRuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === TRANSLATE_RUNTIME_MARKER_VERSION
}

export function serializeTranslateRuntimeMarker(m: TranslateRuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/translateRuntimeMarker.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/translateRuntimeMarker.ts src/main/voice/translateRuntimeMarker.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增本地翻译运行时安装标记文件

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `realVoiceTransport.ts` 追加 —— 真实 HTTP 客户端、spawn、模型下载

**Files:**
- Modify: `src/main/voice/realVoiceTransport.ts`

**Interfaces:**
- Consumes: 文件内已有的 `spawnAndWaitForReady`（不改动）
- Produces: `realPostJson`、`realSpawnTranslateProcess`、`realDownloadNllbModel`；`downloadToFile` 从文件内私有函数改为导出（供 `realDownloadNllbModel` 内部调用，也让下个任务可以直接 import 复用同一份下载实现）。

这个文件里已有的 `realPostSse`/`realDownloadEmbeddablePython` 等函数都没有独立的 Vitest（它们是"真实 IO"层，靠真机验证，不是纯逻辑），本任务延续同样的约定，不新增测试文件。

- [ ] **Step 1: 把 `downloadToFile` 改为导出**

把：

```ts
async function downloadToFile(url: string, destPath: string, fetchImpl: typeof fetch): Promise<void> {
```

改成：

```ts
export async function downloadToFile(url: string, destPath: string, fetchImpl: typeof fetch): Promise<void> {
```

- [ ] **Step 2: 追加 `realPostJson`**

放在 `realPostSse` 函数之后：

```ts
/** 发 POST + 收完整 JSON 响应体(非流式,供本地翻译 sidecar 用——它是同步返回,不是 SSE)。 */
export function realPostJson(port: number, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error('翻译请求已取消'))
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { raw += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}')
          if (res.statusCode !== 200) {
            reject(new Error(typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.statusCode}`))
            return
          }
          resolve(parsed)
        } catch (e) {
          reject(e)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')))
    req.write(payload)
    req.end()
  })
}
```

- [ ] **Step 3: 追加 `realSpawnTranslateProcess`**

放在 `realSpawnGenieProcess` 之后：

```ts
/** spawn translate_server.py 处理真实翻译请求。翻译 sidecar 与宠物身份无关,不需要 voice/installDir 这类每个宠物不同的参数。 */
export function realSpawnTranslateProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  modelDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [opts.scriptPath, '--port', String(opts.port), '--model-dir', opts.modelDir]
  return spawnAndWaitForReady(opts.pythonExe, args, '本地翻译 sidecar')
}
```

- [ ] **Step 4: 追加 `realDownloadNllbModel`**

放在 `realDownloadGenieData` 之后：

```ts
const NLLB_MODEL_REPO = 'JustFrederik/nllb-200-distilled-600M-ct2-int8'
const NLLB_MODEL_FILES = ['config.json', 'model.bin', 'sentencepiece.bpe.model']

/** 直接从 huggingface.co 下载推理必需的 3 个文件,不引入 huggingface_hub(Node 侧直接 HTTP GET,
 *  复用 downloadToFile)。不设 HF_ENDPOINT 镜像——参考 realDownloadGenieData 上方注释记录的教训,
 *  镜像曾经跟 huggingface_hub 的元数据校验不兼容、反而制造了后续几轮真机报错,直连 huggingface.co
 *  本身是能成功下载的。这里是纯文件 GET,不经过 huggingface_hub 库,不受那个特定不兼容问题影响,
 *  但同样不主动加镜像,保持跟已验证过的直连路径一致。 */
export async function realDownloadNllbModel(destDir: string, onProgress: (message: string) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  for (let i = 0; i < NLLB_MODEL_FILES.length; i++) {
    const file = NLLB_MODEL_FILES[i]
    onProgress(`下载翻译模型(${i + 1}/${NLLB_MODEL_FILES.length}):${file}`)
    await downloadToFile(`https://huggingface.co/${NLLB_MODEL_REPO}/resolve/main/${file}`, join(destDir, file), fetchImpl)
  }
}
```

- [ ] **Step 5: 跑 typecheck 确认没有类型错误**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/main/voice/realVoiceTransport.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增本地翻译 sidecar 的真实 HTTP/spawn/模型下载实现

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `translateRuntimeInstall.ts` —— 安装流程编排

**Files:**
- Create: `src/main/voice/translateRuntimeInstall.ts`
- Test: `src/main/voice/translateRuntimeInstall.test.ts`

**Interfaces:**
- Produces: `TranslateInstallStage`、`TranslateInstallProgress`、`TranslateInstallStepRunner`、`runTranslateRuntimeInstall(opts): Promise<{ok:true}|{ok:false,error:string,stage:TranslateInstallStage}>`

- [ ] **Step 1: 写失败测试**

照抄 `src/main/voice/genieRuntimeInstall.test.ts` 的结构：

```ts
import { describe, it, expect, vi } from 'vitest'
import { runTranslateRuntimeInstall, type TranslateInstallStepRunner, type TranslateInstallProgress } from './translateRuntimeInstall'

function fakeSteps(overrides?: Partial<TranslateInstallStepRunner>): TranslateInstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    installTranslateDeps: vi.fn(async () => {}),
    downloadNllbModel: vi.fn(async (_dir: string, _onProgress: (message: string) => void) => {}),
    ...overrides
  }
}

describe('runTranslateRuntimeInstall', () => {
  it('按顺序跑完全部步骤', async () => {
    const steps = fakeSteps()
    const progress: TranslateInstallProgress[] = []
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'install-translate-deps', 'download-nllb-model', 'done'
    ])
    expect(steps.downloadEmbeddablePython).toHaveBeenCalledWith('D:/tr')
    expect(steps.downloadNllbModel).toHaveBeenCalledWith('D:/tr', expect.any(Function))
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installTranslateDeps: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-translate-deps' })
    expect(steps.downloadNllbModel).not.toHaveBeenCalled()
  })

  it('子步骤的 onProgress 回调,以当前 stage 转发给顶层 onProgress', async () => {
    const progress: TranslateInstallProgress[] = []
    const steps = fakeSteps({
      downloadNllbModel: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('下载翻译模型(1/3):config.json') })
    })
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress).toContainEqual({ stage: 'download-nllb-model', message: '下载翻译模型(1/3):config.json' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/translateRuntimeInstall.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
export type TranslateInstallStage = 'download-python' | 'enable-pip' | 'install-translate-deps' | 'download-nllb-model' | 'done'

export interface TranslateInstallProgress { stage: TranslateInstallStage; message: string }

export interface TranslateInstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
  installTranslateDeps(destDir: string, onProgress: (message: string) => void): Promise<void>
  downloadNllbModel(destDir: string, onProgress: (message: string) => void): Promise<void>
}

export async function runTranslateRuntimeInstall(opts: {
  destDir: string
  steps: TranslateInstallStepRunner
  onProgress: (p: TranslateInstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: TranslateInstallStage }> {
  let stage: TranslateInstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'install-translate-deps'
    opts.onProgress({ stage, message: '安装 ctranslate2/sentencepiece…' })
    await opts.steps.installTranslateDeps(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'download-nllb-model'
    opts.onProgress({ stage, message: '下载翻译模型(约 630MB)…' })
    await opts.steps.downloadNllbModel(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/translateRuntimeInstall.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/translateRuntimeInstall.ts src/main/voice/translateRuntimeInstall.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 新增本地翻译运行时安装编排

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `SpeakRequest.segments` —— 协议改动 + `voiceProvider.ts` 计算分段

**Files:**
- Modify: `src/main/voice/voiceSidecar.ts`
- Modify: `src/main/voice/voiceProvider.ts`
- Test: `src/main/voice/voiceProvider.test.ts`

**Interfaces:**
- Consumes: `splitByScript`(Task 2)
- Produces: `SpeakRequest.segments: Array<{ lang: 'en' | 'zh' | 'ja'; text: string }>`(新增字段，`text`/`language` 等既有字段不变)

- [ ] **Step 1: 写失败测试**

先读一遍 `src/main/voice/voiceProvider.test.ts` 现有内容，找到构造 `sidecar.speak` fake 并断言调用参数的用例（大概率是校验 `text`/`language`/`isCutText` 等字段的那个测试），在其后追加：

```ts
it('speak 请求带上 segments,按英文/非英文切分,已知目标语言标注非英文片段', async () => {
  const speak = vi.fn(async (_req, onChunk) => { onChunk({ audioBase64: 'QQ==', sampleRate: 32000 }) })
  const sidecar = { start: vi.fn(), speak, stop: vi.fn() }
  const provider = createVoiceProvider({
    sidecar,
    translator: { translate: vi.fn(async (text: string) => `[${text}]`) },
    getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
    onError: vi.fn()
  })
  await provider.synthesize('我觉得 React 框架很好用', () => {})
  const req = speak.mock.calls[0][0]
  // 此时 translate() 还是整段一次性调用(Task 14 才会改成按 segment 分别调用),
  // 所以译文是"[原文整段]"包一层,segments 是对这个包了一层的结果再切分。
  expect(req.segments).toEqual([
    { lang: 'ja', text: '[我觉得 ' },
    { lang: 'en', text: 'React' },
    { lang: 'ja', text: ' 框架很好用]' }
  ])
})
```

（`target='ja'` 而不是 `'zh'`：这句话本身以中文字符为主，若目标语言选 `zh`，`needsTranslation` 会判定"已经是目标语言"直接跳过翻译分支，测试就验证不到 segments 逻辑——`ja` 能保证一定进入翻译分支，因为判定条件是"是否含假名"，这句话不含假名。）

这个用例需要 import `DEFAULT_TTS_SETTINGS`（若文件顶部尚未 import，从 `@shared/llm` 加进去），并且要确认文件里 `createVoiceProvider` 的调用方式、`translator` fake 的形状跟已有用例保持一致（照抄邻近用例的写法，不要凭空发明新的调用签名）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: FAIL，`req.segments` 是 `undefined`。

- [ ] **Step 3: 实现**

在 `src/main/voice/voiceSidecar.ts` 的 `SpeakRequest` 接口里加一行（`text`/`language` 等已有字段不动，`segments` 是新增的并列字段——`text` 仍然是 sidecar 做 `cutMinLen`/`cutMute` 流式分块必需的完整文本，`segments` 只负责告诉 sidecar 每个子串该按什么语言发音，两者互补不是替代关系）：

```ts
export interface SpeakRequest {
  text: string
  language: TtsTargetLanguage
  /** 文本按"英文 / 目标语言"切分后的分段,用于混合语言发音(见 splitByScript)。 */
  segments: Array<{ lang: 'en' | 'zh' | 'ja'; text: string }>
  isCutText: boolean; cutMinLen: number; cutMute: number
  synthesisChunking: 'token' | 'sentence'
  speed: number; noiseScale: number; temperature: number
  topK: number; topP: number; repetitionPenalty: number
}
```

在 `src/main/voice/voiceProvider.ts`：

- import 区加 `import { splitByScript } from './mixedLanguageSplit'`。
- 找到当前构造 `opts.sidecar.speak({...}, ...)` 请求体的地方（`text: toSpeak,` 那一行附近），在对象里加一行：

```ts
segments: splitByScript(toSpeak).map((s) => ({
  lang: s.lang === 'en' ? 'en' : (settings.targetLanguage === 'auto' ? 'en' : settings.targetLanguage),
  text: s.text
})),
```

这里 `settings.targetLanguage === 'auto'` 时非英文片段没有明确目标语言可用——回退标成 `'en'` 只是为了让类型满足（`segments.lang` 不接受 `'auto'`），auto 场景本来就不会触发翻译（`needsTranslation` 对 `auto` 恒为 false），`toSpeak` 此时就是原文，几乎不会真的产出非英文非目标语言的片段被错误标注；如果之后真机测试发现 auto 场景下真的需要更精细的语言标注，再回来调整。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: PASS，包括新用例和文件里所有原有用例(原有用例如果直接对整个请求体做 `toEqual` 精确匹配，会因为多出 `segments` 字段而失败——如果出现这种情况，把那些用例的期望值也加上对应的 `segments`，不要削弱新字段本身)。

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/voiceSidecar.ts src/main/voice/voiceProvider.ts src/main/voice/voiceProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): SpeakRequest 新增 segments 字段,voiceProvider 按英文/目标语言切分

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `gsv_server.py` —— 单次调用内消费 `segments`

**Files:**
- Modify: `resources/voice/gsv_server.py`

**Interfaces:**
- Consumes: 请求体新增的 `segments` 字段(Task 11)

无自动化测试（这个文件本身没有测试基础设施，`_apply_language` 现有实现同样没有测试；行为验证归入下面的真机验证清单）。

- [ ] **Step 1: 实现**

把 `_apply_language(lang)` 函数替换成消费 `segments` 的版本：

```python
def _apply_language(segments):
    """按请求传来的 segments 构造 LangSegment.getTexts 的返回值,替代它自己的语言检测。

    之前的实现监听 language 参数、强制整段按单一语言发音,是为了修复纯汉字、不含假名的
    日语行被自动检测误判成中文的问题,代价是顺带关掉了混合语言能力。现在改成直接用请求方
    (已经知道目标语言、也已经用 splitByScript 切好英文/非英文片段)算好的 segments,不需要
    再让 LangSegment 自己去猜——原问题(不需要猜)和混合语言能力(segments 里天然保留了
    英文片段)可以同时满足。segments 为空(理论上不会,voiceProvider 至少会给一个整段)时
    退化成不合成任何内容,交给上层空文本判断处理。必须在持有 _infer_lock 时调用。
    """
    LangSegment.getTexts = lambda text: [
        {"lang": s["lang"], "text": s["text"]} for s in segments if s["text"]
    ]
```

在 `do_POST` 里，把：

```python
with _infer_lock:
    _apply_language(body.get("language", "auto"))
```

改成：

```python
with _infer_lock:
    _apply_language(body.get("segments") or [{"lang": body.get("language", "auto"), "text": body["text"]}])
```

（`segments` 缺失时兜底成整段单一语言，保持对不带 `segments` 字段的旧请求体的兼容——虽然 Task 11 之后 `voiceProvider.ts` 总会带上它，这个兜底只是防御性的,不依赖任何新行为。）

- [ ] **Step 2: 真机验证清单(移交用户)**

- 目标语言设为 `zh`，朗读一句"我觉得 React 框架很好用"（`segments` 应为 `[{lang:zh,...}, {lang:en,text:'React'}, {lang:zh,...}]`），确认整句发音自然，"React" 读的是英文发音而不是被中文音素强行读出来。
- 目标语言设为 `ja`，朗读一句纯汉字、不含假名的日语行（比如翻译后的天气数据"降水確率86%"），确认仍然按日语发音，不会像改动前那样被错误检测成中文——这是本次改动之前 `_apply_language` 存在的原因，必须确认没有回归。
- 确认现有 `cutMinLen`/`cutMute` 流式分块行为不受影响（听感上句子中间的停顿位置跟改动前一致）。

- [ ] **Step 3: 提交**

```bash
git add resources/voice/gsv_server.py
git commit -m "$(cat <<'EOF'
feat(语音): GSV sidecar 改为消费 segments,单次调用内支持中英/日英混合发音

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `genie_server.py` —— 拆段多次调用拼接

**Files:**
- Modify: `resources/voice/genie_server.py`

**Interfaces:**
- Consumes: 请求体新增的 `segments` 字段(Task 11)

无自动化测试，同 Task 12。这是全新机制（Genie-TTS 架构上没有单次调用内混合语言的能力，只能拆成多次调用），真机验证清单里的拼接听感检查是这个任务里优先级最高的一项。

- [ ] **Step 1: 实现**

把 `do_POST` 里 `async def run():` 这个函数替换成遍历 `segments` 的版本：

```python
async def run():
    segments = body.get("segments") or [{"lang": body.get("language", "auto"), "target": body.get("language", "auto")}]
    requested_lang = body.get("language", "auto")
    default_lang = requested_lang if requested_lang in ("zh", "ja", "en") else BASE_LANGUAGE
    for seg in segments:
        text = seg.get("text", "")
        if not text.strip():
            continue
        seg_lang = seg["lang"] if seg.get("lang") in ("zh", "ja", "en") else default_lang
        with _infer_lock:
            from genie_tts.ModelManager import model_manager
            from genie_tts.Utils.Language import normalize_language
            model_manager.character_to_language[CHARACTER_NAME.lower()] = normalize_language(seg_lang)
            async for chunk in genie.tts_async(
                character_name=CHARACTER_NAME,
                text=text,
                play=False,
                split_sentence=False,
            ):
                pcm_f32 = (np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0)
                audio_b64 = base64.b64encode(pcm_f32.tobytes()).decode("ascii")
                payload = json.dumps({"audio": audio_b64, "sampleRate": 32000})
                self.wfile.write(("event: audio\ndata: %s\n\n" % payload).encode("utf-8"))
                self.wfile.flush()
```

这段替换了原来"整段文本一次调用、`character_to_language` 在调用前设一次"的逻辑——现在是每个 segment 各自设一次语言、各自单独调用一次 `genie.tts_async()`，多次调用产出的 PCM 帧顺序写进同一个 SSE 流。`self.wfile`/`json`/`base64`/`np` 都是文件里已有的模块级引用，不需要新增 import。

原来 `do_POST` 里 `try:` 块下方紧跟着 `requested_lang = body.get("language", "auto")` 和 `with _infer_lock: from genie_tts.ModelManager import model_manager ... asyncio.run(run())` 这段代码（原先在 `run()` 外部、`_infer_lock` 包住 `asyncio.run(run())`），现在这些逻辑已经整体挪进了新的 `run()` 内部（每个 segment 各自持锁一次，而不是整个多段合成期间持一把大锁）——把 `try:` 块里原来那段外层的 `requested_lang`/`with _infer_lock: ... asyncio.run(run())` 精简成只保留：

```python
try:
    asyncio.run(run())
    self.wfile.write(b"event: done\ndata: {}\n\n")
    self.wfile.flush()
except Exception as e:
    err = json.dumps({"error": str(e)})
    self.wfile.write(("event: error\ndata: %s\n\n" % err).encode("utf-8"))
    self.wfile.flush()
```

- [ ] **Step 2: 真机验证清单(移交用户，本任务优先级最高的一项)**

- 目标语言设为 `zh`，用 Genie-TTS 后端朗读"我觉得 React 框架很好用"，**重点听"框架很好用"这几个字与"React"之间的衔接处**——有没有明显的音量突变、不自然的停顿或喀哒声。这是全新机制，代码本身没有先例可参考，必须真机验证。
- 如果衔接处听感明显不自然，记录具体是哪种瑕疵（突然的静音/音量跳变/呼吸声中断），作为后续加淡入淡出或段间静音过渡的依据——这次改动不预先做这个，等真实听感反馈再决定要不要做。
- 确认单 segment（没有混合英文的普通中/日文句子）场景下行为跟改动前完全一致，没有回归。
- 确认 `character_to_language` 在多段之间切换正确生效（比如故意构造一个"中文—英文—中文—英文"四段的句子，确认第二段中文不会被上一次的英文设置污染）。

- [ ] **Step 3: 提交**

```bash
git add resources/voice/genie_server.py
git commit -m "$(cat <<'EOF'
feat(语音): Genie sidecar 改为按 segments 拆段多次调用拼接,支持中英/日英混合发音

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: 翻译预处理接入 —— 拆段分别翻，英文原样保留

**Files:**
- Modify: `src/main/voice/voiceProvider.ts`
- Test: `src/main/voice/voiceProvider.test.ts`

**Interfaces:**
- Consumes: `splitByScript`(Task 2)、`Translator`(现有接口)

这是 spec 5.2 节"拆段分别翻"的落地位置——当前 `synthesize()` 是整段 `speakable` 直接扔给 `opts.translator.translate(...)`，改成先用 `splitByScript` 切出非英文片段各自独立送翻译、英文片段原样保留，再按原顺序拼回。

- [ ] **Step 1: 写失败测试**

在 `src/main/voice/voiceProvider.test.ts` 追加：

```ts
it('翻译时英文片段原样保留,只翻译非英文片段,按原顺序拼回', async () => {
  const translator = { translate: vi.fn(async (text: string) => `[${text}]`) }
  const speak = vi.fn(async (_req, onChunk) => { onChunk({ audioBase64: 'QQ==', sampleRate: 32000 }) })
  const sidecar = { start: vi.fn(), speak, stop: vi.fn() }
  const provider = createVoiceProvider({
    sidecar,
    translator,
    getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
    onError: vi.fn()
  })
  await provider.synthesize('我觉得 React 框架很好用', () => {})
  // 只有非英文片段进了 translate(),英文片段 'React' 不应该出现在调用参数里
  expect(translator.translate).toHaveBeenCalledTimes(2)
  expect(translator.translate.mock.calls.map((c) => c[0])).toEqual(['我觉得 ', ' 框架很好用'])
  // 最终喂给 sidecar 的文本是"译文1 + 原样英文 + 译文2"拼接
  const req = speak.mock.calls[0][0]
  expect(req.text).toBe('[我觉得 ]React[ 框架很好用]')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: FAIL——当前实现是整段文本一次性送 `translate()`，不会按片段拆分调用。

- [ ] **Step 3: 实现**

在 `src/main/voice/voiceProvider.ts` 的 `synthesize` 函数里，找到：

```ts
let toSpeak = speakable
if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
  try {
    toSpeak = await opts.translator.translate(speakable, settings.targetLanguage, ctrl.signal)
  } catch (e) {
    if (ctrl.signal.aborted) return 'skipped'
    opts.onError(`翻译失败,朗读已跳过本段:${String((e as Error)?.message ?? e)}`)
    return 'failed'
  }
}
```

改成：

```ts
let toSpeak = speakable
if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
  try {
    const scriptSegments = splitByScript(speakable)
    const translated = await Promise.all(scriptSegments.map((s) =>
      s.lang === 'en' ? s.text : opts.translator.translate(s.text, settings.targetLanguage, ctrl.signal)
    ))
    toSpeak = translated.join('')
  } catch (e) {
    if (ctrl.signal.aborted) return 'skipped'
    opts.onError(`翻译失败,朗读已跳过本段:${String((e as Error)?.message ?? e)}`)
    return 'failed'
  }
}
```

（`splitByScript` 的 import 已经在 Task 11 加过，这里不用重复加。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: PASS，包括 Task 11 加的用例——但 Task 11 那个用例的期望值是在"`translate()` 整句一次性调用"的行为下算出来的,本任务把调用方式改成"只对非英文片段分别调用",需要同步更新 Task 11 那个用例的期望值(翻译器 fake `vi.fn(async (text) => `[${text}]`)` 本身不用改,变的只是它现在被分别喂进 `'我觉得 '` 和 `' 框架很好用'` 两次,而不是整句 `'我觉得 React 框架很好用'` 一次):

```ts
expect(req.segments).toEqual([
  { lang: 'ja', text: '[我觉得 ]' },
  { lang: 'en', text: 'React' },
  { lang: 'ja', text: '[ 框架很好用]' }
])
```

（对比 Task 11 原来的期望值 `'[我觉得 '`/`' 框架很好用]'`——方括号从"整句包一层、被中间的 React 隔断"变成"'我觉得 '和' 框架很好用'各自单独包一层"，这正是"拆段分别翻"生效的直接证据。）

- [ ] **Step 5: 提交**

```bash
git add src/main/voice/voiceProvider.ts src/main/voice/voiceProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): 翻译预处理拆段分别翻,英文片段原样保留不进翻译器

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `petSession.ts` 接线 —— 翻译器组合 + 翻译 sidecar 不跟宠物切换重启

**Files:**
- Modify: `src/main/shell/petSession.ts`
- Test: `src/main/shell/petSession.test.ts`

**Interfaces:**
- Consumes: `createFallbackTranslator`(Task 3)、`createLocalNllbTranslator`(Task 6)、`TranslateSidecar`(Task 5)
- Produces: `PetSessionDeps` 新增 `translateDeps: TranslateSessionDeps`；`TranslateSessionDeps { translateSidecar: TranslateSidecar; isTranslateAvailable: () => boolean }`

翻译 sidecar 的实际启动(spawn 真实进程)在 Task 16 的 `startShell`/`index.ts` 里完成一次；这里只是把"已经在别处启动好的 sidecar 引用"接到每次 `startVoice()` 都会重建的 translator 组合上——sidecar 进程本身不随这个函数重跑而重启。

- [ ] **Step 1: 写失败测试**

在 `makeDeps()` 函数（`voiceDeps: {...}` 字段之后）加一个默认的 `translateDeps`：

```ts
translateDeps: {
  translateSidecar: { start: async () => {}, translate: async () => '', stop: () => {} },
  isTranslateAvailable: () => false
},
```

在 `describe('createPetSession() voice facade', ...)` 块里，模仿其中 `'becomes ready only after sequencer construction and wires synthesis instead of legacy speak'` 这个用例的前置 mock 写法（`enabledDeps()` + `vi.mocked(loadPet).mockResolvedValue(...)` + `vi.mocked(createVoiceSidecar).mockReturnValue(...)` + `vi.mocked(createVoiceProvider).mockReturnValue(...)` + `vi.mocked(createSpeechSequencer).mockReturnValue(...)`），追加一个新用例：

```ts
it('translator 是 createFallbackTranslator 组合出来的,isTranslateAvailable=true 时优先用本地翻译', async () => {
  vi.mocked(loadPet).mockResolvedValue({
    manifest: { voice: { gptModel: 'gpt.ckpt', sovitsModel: 'sovits.pth', refAudio: 'ref.wav', refText: 'hello' } }
  } as never)
  vi.mocked(createVoiceSidecar).mockReturnValue({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as never)
  vi.mocked(createVoiceProvider).mockReturnValue({ synthesize: vi.fn(async () => 'spoken' as const), stop: vi.fn() } as never)
  vi.mocked(createSpeechSequencer).mockReturnValue({ speak: vi.fn(async () => {}), stop: vi.fn() } as never)

  const localTranslate = vi.fn(async () => '本地译文')
  const deps: PetSessionDeps = {
    ...enabledDeps(),
    translateDeps: {
      translateSidecar: { start: vi.fn(async () => {}), translate: localTranslate, stop: vi.fn() },
      isTranslateAvailable: () => true
    }
  }
  const session = createPetSession('fake-pet-id', deps)
  await (session.startVoice as () => Promise<void>)()

  const translatorArg = vi.mocked(createVoiceProvider).mock.calls[0][0].translator
  const out = await translatorArg.translate('你好', 'ja', new AbortController().signal)
  expect(out).toBe('本地译文')
  expect(localTranslate).toHaveBeenCalledOnce()

  await session.dispose()
})
```

- [ ] **Step 1b: 校验 `PetSessionDeps` 字面量构造点没有遗漏**

`grep -rn "translateDeps" src/main/shell` 目前应该只匹配到 Step 1 刚加的这一处——如果 `petSession.test.ts` 里还有其他地方直接手写 `PetSessionDeps` 字面量（不经过 `makeDeps()`），同样需要补上 `translateDeps` 字段，否则 Step 2 会先卡在类型错误而不是预期的断言失败。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/shell/petSession.test.ts`
Expected: FAIL（此时 `translator` 还是裸的 `createLlmTranslator(translatorProvider)`）。

- [ ] **Step 3: 实现**

在 `src/main/shell/petSession.ts` 顶部 import 区：

```ts
import { createLlmTranslator, createFallbackTranslator, createLocalNllbTranslator } from '../voice/translate'
import type { TranslateSidecar } from '../voice/translateSidecar'
```

（`createLlmTranslator` 已经 import 过，只需要在同一行加 `createFallbackTranslator, createLocalNllbTranslator`。）

在 `VoiceSessionDeps` 接口定义之后，新增一个并列接口：

```ts
/** 翻译 sidecar 与宠物身份无关,生命周期不跟着切宠物重启——由 startShell 建一次、启动一次,
 *  这里只持有引用。isTranslateAvailable 反映"这次应用运行期间 sidecar 有没有成功启动过"。 */
export interface TranslateSessionDeps {
  translateSidecar: TranslateSidecar
  isTranslateAvailable: () => boolean
}
```

`PetSessionDeps` 接口里 `voiceDeps: VoiceSessionDeps` 后面加一行：

```ts
translateDeps: TranslateSessionDeps
```

找到 `startVoice()` 里原来的：

```ts
const translatorProvider = createProviderForVoice()
const provider = createVoiceProvider({
  sidecar,
  translator: createLlmTranslator(translatorProvider),
  getSettings: () => deps.loadSettings().tts,
  onError: (m) => deps.voiceDeps.onAudioError(m)
})
```

改成：

```ts
const translatorProvider = createProviderForVoice()
const translator = createFallbackTranslator({
  primary: createLocalNllbTranslator(deps.translateDeps.translateSidecar),
  fallback: createLlmTranslator(translatorProvider),
  isPrimaryAvailable: deps.translateDeps.isTranslateAvailable
})
const provider = createVoiceProvider({
  sidecar,
  translator,
  getSettings: () => deps.loadSettings().tts,
  onError: (m) => deps.voiceDeps.onAudioError(m)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/shell/petSession.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑一次全量 typecheck**

Run: `pnpm typecheck`
Expected: 无错误。若报错，大概率是 `petSession.test.ts` 里 `makeDeps()` 构造 `PetSessionDeps` 字面量的地方缺 `translateDeps` 字段——按报错位置补上一个假的 `{ translateSidecar: { start: async () => {}, translate: async () => '', stop: () => {} }, isTranslateAvailable: () => false }`。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/petSession.ts src/main/shell/petSession.test.ts
git commit -m "$(cat <<'EOF'
feat(语音): petSession 接入本地翻译回退组合,sidecar 生命周期与宠物切换解耦

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: 主进程接线 —— IPC 通道、应用级 sidecar 单例、安装入口

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: 前面所有 Task 产出的类型/函数
- Produces: IPC 通道 `TRANSLATE_GET_STATE`/`TRANSLATE_START_INSTALL`/`TRANSLATE_INSTALL_PROGRESS`；`window.translateVoiceApi`(渲染进程可调用的安装接口)

这是纯接线任务，没有独立的自动化测试——`index.ts` 里现有的 IPC 处理器、真实 sidecar 启动逻辑同样没有单元测试(靠真机验证)，本任务延续同样的约定。安装路径固定为 `join(app.getPath('userData'), 'translate-runtime')`，不提供路径选择器（不同于 GSV/Genie 的"用户可选安装位置"，因为翻译运行时体积小(~650MB)且明确不需要用户感知，参考 spec 6.1/6.2 节）。

- [ ] **Step 1: `shared/ipc.ts` 新增 IPC 通道常量**

找到 `GENIE_GET_STATE`/`GENIE_START_INSTALL`/`GENIE_INSTALL_PROGRESS` 三个常量定义的位置，在附近加：

```ts
TRANSLATE_GET_STATE: 'translate:get-state',
TRANSLATE_START_INSTALL: 'translate:start-install',
TRANSLATE_INSTALL_PROGRESS: 'translate:install-progress',
```

同时找到 `GenieRuntimeState`/`GenieInstallProgress` 之类的共享类型定义（大概率也在 `src/shared/ipc.ts` 或紧邻的文件里），新增对应的：

```ts
export interface TranslateRuntimeState { installed: boolean; nllbModelRepo?: string }
export interface TranslateInstallProgressMsg { stage: string; message: string }
```

- [ ] **Step 2: `preload/index.ts` 新增 `translateVoiceApi`**

参考文件里已有的 `genieVoiceApi`（大概率是 `contextBridge.exposeInMainWorld('genieVoiceApi', {...})` 这种形式），紧邻着加一个结构类似但更简单的（没有 `pickInstallPath`/`importArchive`/`exportArchive`，因为翻译运行时不需要用户选路径、也不做归档导入导出）：

```ts
contextBridge.exposeInMainWorld('translateVoiceApi', {
  getState: () => ipcRenderer.invoke(IPC.TRANSLATE_GET_STATE),
  startInstall: () => ipcRenderer.send(IPC.TRANSLATE_START_INSTALL),
  onInstallProgress: (cb: (p: TranslateInstallProgressMsg) => void) => {
    ipcRenderer.removeAllListeners(IPC.TRANSLATE_INSTALL_PROGRESS)
    ipcRenderer.on(IPC.TRANSLATE_INSTALL_PROGRESS, (_e, p) => cb(p))
  }
})
```

具体挂载位置、`PetApi`/全局类型声明怎么补（文件顶部大概率有一个 `declare global { interface Window { genieVoiceApi: GenieVoiceApi } }` 之类的块），照抄 `genieVoiceApi` 现有的写法处理，新增一个 `TranslateVoiceApi` 类型定义与对应的 `Window` 接口扩展。

- [ ] **Step 3: `main/shell/index.ts` —— 应用级 sidecar 单例启动**

在文件里能拿到 `app.getPath('userData')`、`settingsFile`、`petWin` 的作用域（大概率是 `startShell` 函数顶部，`petWin` 创建之后、各 pet session 创建之前的位置——参照 `GENIE_GET_STATE` 等 IPC handler 注册的上下文），加：

```ts
import { createTranslateSidecar } from '../voice/translateSidecar'
import { realSpawnTranslateProcess, realPostJson, realDownloadNllbModel } from '../voice/realVoiceTransport'
import { runTranslateRuntimeInstall } from '../voice/translateRuntimeInstall'
import {
  TRANSLATE_RUNTIME_MARKER_VERSION, parseTranslateRuntimeMarker, isTranslateRuntimeUsable,
  serializeTranslateRuntimeMarker
} from '../voice/translateRuntimeMarker'

const TRANSLATE_PORT = 8861 // 与现有 gsv/genie 端口(需要确认实际值,取相邻未占用端口)不冲突即可
const translateInstallDir = join(app.getPath('userData'), 'translate-runtime')
const translatePythonExe = join(translateInstallDir, 'python.exe')
const translateModelDir = join(translateInstallDir, 'nllb-model')
const translateMarkerFile = join(translateInstallDir, 'runtime-marker.json')
const translateScriptPath = join(/* 与 voiceScriptPath/genieScriptPath 相同的打包资源根目录 */ resourcesVoiceDir, 'translate_server.py')

function getTranslateRuntimeState(): { installed: boolean } {
  try {
    const marker = parseTranslateRuntimeMarker(readFileSync(translateMarkerFile, 'utf-8'))
    return { installed: isTranslateRuntimeUsable(marker) }
  } catch {
    return { installed: false }
  }
}

const translateSidecar = createTranslateSidecar({
  port: TRANSLATE_PORT,
  spawnProcess: () => realSpawnTranslateProcess({
    pythonExe: translatePythonExe,
    scriptPath: translateScriptPath,
    port: TRANSLATE_PORT,
    modelDir: translateModelDir
  }),
  postJson: realPostJson
})
let translateAvailable = false

// 应用启动时尝试一次,不像 GSV/Genie 那样每次切宠物重试——失败就整个会话期固定用 LLM 翻译。
if (getTranslateRuntimeState().installed) {
  translateSidecar.start().then(() => { translateAvailable = true }).catch((e) => {
    console.warn('[translate] 本地翻译 sidecar 启动失败,本次运行固定使用 LLM 翻译', e)
  })
}
```

`resourcesVoiceDir`/端口号具体取值要跟文件里 `voiceScriptPath`/`genieScriptPath`/`ports.gsv`/`ports.genie` 的实际定义对齐（读一遍文件顶部/`startShell` 参数里这几个值是怎么来的，照同样的方式派生 `translateScriptPath` 和一个新端口号，不要引入第二套路径解析逻辑）。

在构造每个 `PetSessionDeps`(`createPetSession(...)` 调用处)的地方，`voiceDeps: {...}` 后面加：

```ts
translateDeps: { translateSidecar, isTranslateAvailable: () => translateAvailable }
```

- [ ] **Step 4: `main/shell/index.ts` —— 安装 IPC handler**

参照 `GENIE_GET_STATE`/`GENIE_START_INSTALL` 的写法（本文件 Task 编写前已读过的那段），加：

```ts
ipcMain.handle(IPC.TRANSLATE_GET_STATE, async () => getTranslateRuntimeState())

ipcMain.on(IPC.TRANSLATE_START_INSTALL, () => {
  const win = settings.window()
  void runTranslateRuntimeInstall({
    destDir: translateInstallDir,
    steps: {
      downloadEmbeddablePython: (dir) => realDownloadEmbeddablePython(dir, 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'),
      enablePip: async (dir, onProgress) => {
        const candidates: MirrorCandidate[] = [
          { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
          { indexUrl: undefined, label: '官方源', fastFail: false }
        ]
        await installWithMirrorFallback(
          candidates,
          (c) => realPipInstall(dir, ['--upgrade', 'pip'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
          onProgress
        )
      },
      installTranslateDeps: async (dir, onProgress) => {
        const candidates: MirrorCandidate[] = [
          { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
          { indexUrl: undefined, label: '官方源', fastFail: false }
        ]
        await installWithMirrorFallback(
          candidates,
          (c) => realPipInstall(dir, ['ctranslate2', 'sentencepiece'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
          onProgress
        )
      },
      downloadNllbModel: async (dir, onProgress) => {
        await realDownloadNllbModel(translateModelDir, onProgress)
      }
    },
    onProgress: (p) => { win?.webContents.send(IPC.TRANSLATE_INSTALL_PROGRESS, p); petWin.webContents.send(IPC.TRANSLATE_INSTALL_PROGRESS, p) }
  }).then((r) => {
    if (r.ok) {
      mkdirSync(translateInstallDir, { recursive: true })
      writeFileSync(translateMarkerFile, serializeTranslateRuntimeMarker({ markerVersion: TRANSLATE_RUNTIME_MARKER_VERSION, nllbModelRepo: 'JustFrederik/nllb-200-distilled-600M-ct2-int8' }))
      // 安装刚完成,尝试立即启动一次,不用等下次重启应用才生效。
      void translateSidecar.start().then(() => { translateAvailable = true }).catch((e) => {
        console.warn('[translate] 安装完成但启动失败', e)
      })
    } else {
      const p = { stage: r.stage, message: `安装失败:${r.error}` }
      win?.webContents.send(IPC.TRANSLATE_INSTALL_PROGRESS, p)
      petWin.webContents.send(IPC.TRANSLATE_INSTALL_PROGRESS, p)
    }
  })
})
```

`downloadNllbModel` 步骤里 `dir` 参数（等于 `translateInstallDir`）没有直接用来下载，而是下到 `translateModelDir`(`<installDir>/nllb-model`)子目录——跟 `translate_server.py --model-dir` 期望的目录、以及 GSV 的 `modelsDir` 子目录约定保持一致，模型文件不与 python.exe/site-packages 混在一个目录里。

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 无错误。这一步大概率会暴露几个需要对齐的细节（实际的 `resourcesVoiceDir`/端口变量名、`MirrorCandidate`/`installWithMirrorFallback`/`PYPI_MIRROR_TUNA` 等的实际 import 路径、`settings.window()` 的实际可用性）——按报错逐一对照 `GENIE_START_INSTALL` 那段现有代码修正，不要引入新的辅助抽象。

- [ ] **Step 6: 真机验证清单(移交用户)**

- 设置页触发一次完整安装（Python 下载 → pip 装 ctranslate2/sentencepiece → 下载 NLLB 模型），确认进度条/日志正常滚动，最终标记文件写入成功。
- 安装完成后不重启应用，确认 `translateAvailable` 变 true（可以通过朗读一句需要翻译的话、观察是不是走本地路径而非 LLM 来间接验证——比如临时断网让 LLM 调用必然失败，如果朗读仍然正常出声，说明走的是本地翻译）。
- 重启应用，确认已安装状态下 sidecar 在启动时自动拉起，不需要重新点安装。
- 故意让本地翻译 sidecar 启动失败（比如临时改错端口占用），确认整个应用运行期间朗读功能仍然可用（走 LLM 翻译回退），没有因为本地翻译失败导致语音完全不可用。

- [ ] **Step 7: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts
git commit -m "$(cat <<'EOF'
feat(语音): 接入本地翻译运行时安装 IPC 与应用级 sidecar 单例启动

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: 设置页 UI —— 安装提示条

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `window.translateVoiceApi`(Task 16)

无自动化测试（`settings.ts` 里现有的 genie 安装 UI 逻辑同样没有测试，靠真机点击验证）。

- [ ] **Step 1: `settings.html` 新增提示条元素**

在 TTS 区块里、`targetLanguage` 下拉框附近（照抄 genie 安装区块的 HTML 结构，简化掉路径输入框/选择按钮/导入导出按钮，只留状态文字+安装按钮+日志区）加：

```html
<div id="translateInstallBanner" style="display:none">
  <span id="translateRuntimeStatus"></span>
  <button id="translateInstall" type="button">安装本地翻译运行时</button>
  <pre id="translateInstallLog" style="display:none"></pre>
</div>
```

- [ ] **Step 2: `settings.ts` 接线**

参照文件里 `genieRuntimeStatus`/`genieInstall`/`appendGenieInstallLog`/`geniePickPath` 等现有代码的写法（Task 16 之前已读过的那段），加：

```ts
const translateInstallBanner = $<HTMLElement>('translateInstallBanner')
const translateRuntimeStatus = $<HTMLElement>('translateRuntimeStatus')
const translateInstall = $<HTMLButtonElement>('translateInstall')
const translateInstallLog = $<HTMLPreElement>('translateInstallLog')

function appendTranslateInstallLog(line: string): void {
  translateInstallLog.style.display = ''
  translateInstallLog.textContent += `${line}\n`
  translateInstallLog.scrollTop = translateInstallLog.scrollHeight
}

async function refreshTranslateBanner(): Promise<void> {
  const targetLanguage = /* 读取当前 TTS 目标语言下拉框的值,照抄文件里已有的读取方式 */
  if (targetLanguage === 'auto') { translateInstallBanner.style.display = 'none'; return }
  const state = await window.translateVoiceApi.getState()
  translateInstallBanner.style.display = state.installed ? 'none' : ''
  translateRuntimeStatus.textContent = state.installed ? '本地翻译运行时已安装' : '未安装本地翻译运行时,朗读翻译将使用聊天模型(较慢)'
}

translateInstall.addEventListener('click', () => {
  translateInstallLog.textContent = ''
  appendTranslateInstallLog('开始安装…')
  window.translateVoiceApi.startInstall()
})

window.translateVoiceApi.onInstallProgress((p) => {
  appendTranslateInstallLog(`[${p.stage}] ${p.message}`)
  if (p.stage === 'done') void refreshTranslateBanner()
})
```

把 `refreshTranslateBanner()` 接到文件里"目标语言下拉框 change 事件"和"设置页初次打开/加载完成"这两个现有钩子上（照抄 `formatGenieRuntimeState`/`genieRuntimeStatus.textContent = ...` 那一处初始化调用的位置和方式，新增一行调用 `void refreshTranslateBanner()`）。

- [ ] **Step 3: 真机验证清单(移交用户)**

- 目标语言从 `auto` 切到 `zh`/`ja`/`en`，确认未安装时提示条出现；切回 `auto`，确认提示条隐藏。
- 点击安装按钮，确认日志区实时滚动进度，安装完成后提示条自动隐藏。
- 已安装状态下重新打开设置页，确认不显示提示条（除非目标语言仍是 auto 之外的值且状态查询判定未安装）。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "$(cat <<'EOF'
feat(语音): 设置页新增本地翻译运行时安装提示条

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review 记录

- **Spec 覆盖检查**：spec 第 3 节(模型/运行时)→ Task 7/9/10；第 4 节(sidecar/生命周期/组合/语言检测)→ Task 5/6/8/9/10/15/16；第 5 节(中英混合)→ Task 2/11/12/13/14；第 6 节(设置/安装 UX)→ Task 4/16/17；第 7 节(测试范围)→ 每个 Task 的自动化测试 + 明确标注的真机验证清单；第 8 节(不做的事)→ Global Constraints 逐条对应。没有遗漏的 spec 章节。
- **占位符扫描**：Python/index.ts 两个任务里标了"真机验证清单(移交用户)"的地方是有意的、明确交代了具体检查项的清单，不是"TODO 待补"占位符；`resourcesVoiceDir`/端口号等少数几处写了"需要对照文件里已有的实际定义"，是因为这些值在当前未读到的代码位置，已明确指出去哪里核对、核对什么，不是空泛的"加适当处理"。
- **类型一致性检查**：`Translator`/`TranslateSidecar`/`ScriptSegment`/`SpeakRequest.segments` 在 Task 3/5/6/2/11/14/15 之间的字段名、方法签名逐一核对一致（`translate(text, target, signal)` 全文统一；`splitByScript` 返回 `{lang,text}[]` 在 Task 2/11/14 里用法一致；`isPrimaryAvailable`/`isTranslateAvailable` 命名在 Task 3/15 里保持区分——前者是 `createFallbackTranslator` 的通用参数名，后者是 `petSession.ts` 里具体的业务字段名，两者不是同一个标识符，写代码时不要混用）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-local-nllb-translation.md`. Two execution options:

1. **Subagent-Driven (recommended)** - 逐任务派一个新 subagent 实现，任务间做审查，快速迭代
2. **Inline Execution** - 在当前会话按批次执行任务，设检查点

选哪种？
