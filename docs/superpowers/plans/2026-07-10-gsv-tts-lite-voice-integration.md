# GSV-TTS-Lite 配音集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让宠物用 GSV-TTS-Lite(GPT-SoVITS 高性能推理引擎)朗读 LLM 回复,配音随宠物包切换,支持中/日/英/混合、目标朗读语言与回复语言不同(经翻译)、按字数/按标点两种合成切分、流式跟随/等完整回复两种播放触发,且最终用户不需要自己装 conda/建虚拟环境/跑 pip——语音运行时是自包含的可移植 Python 环境,可现场自动安装或从压缩包导入。

**Architecture:** 主进程 spawn 一个 Python sidecar(`resources/voice/gsv_server.py`,跑在可移植 Python 运行时里,启动时绑定当前宠物的 GPT+SoVITS+参考音频/文本),用 Node 内置 `http` 发 POST、手写解析 `text/event-stream` 帧(纯文本协议,不引入 `ws` 包,规避上次的 binaryType 丢帧 bug 类),把解析出的 PCM 块经既有 `contextBridge` IPC 转给渲染层用 Web Audio API 播放。语音运行时(embeddable Python + pip 装好的 torch/gsv-tts-lite + 已下载的基础模型)落在用户可自选的安装位置,现场安装(下载+pip+模型预热一次性做完)或从预先打好的压缩包导入二选一。

**Tech Stack:** TypeScript(主进程/渲染层,既有 electron-vite/Vitest 工具链)、Python 3.10+(sidecar,跑在独立的可移植运行时里,不是本仓库的 node_modules 依赖)、`adm-zip`(新增,运行时压缩包导入导出)。

## Global Constraints

- 不移植 GSV-TTS-Lite 的 WebUI/ASR/批量推理/`api_v2` 兼容层——只要最小的"给文本、吐音频"能力。
- 不做 GPT/SoVITS 模型运行时热切换——切换宠物本身要求重启应用(既有约定),sidecar 随应用启动按 active 宠物绑定一次即可。
- 不支持非 Windows 平台(沿用项目现有约定)。
- 不做预录配音片段(`lines.json` 的 `audio` 字段)——继续保持"仅读入未播放"的现状。
- 不暴露 `gpt_cache`/`sovits_cache` CUDA graph 形状参数——维持库默认值。
- 不做语音运行时自动更新检测——版本不匹配时用户手动点"重新安装/重新导入"。
- 传输层用 HTTP + 手写 SSE 帧解析,不引入 `ws` 包或任何新的二进制帧解析依赖。
- 渲染层零网络/文件访问,只经既有 `contextBridge`/`voiceApi` 模式接收主进程数据。
- 提交粒度:每个任务一提交;纯逻辑先写失败测试(TDD);Electron/GUI 接线由 `pnpm dev`/`preview` 真机验证,不苛求 Vitest 覆盖。
- 设计文档:`docs/superpowers/specs/2026-07-09-gsv-tts-lite-voice-integration-design.md`(本计划的每个任务对应其中某一节,任务描述里会引用)。

---

## Task 1: 宠物包 `voice` 字段(`src/shared/petPackage.ts`)

对应设计文档 §4。`pet.json` 新增可选 `voice` 块;缺失时该宠物 TTS 永远不可用。

**Files:**
- Modify: `src/shared/petPackage.ts`
- Test: `src/shared/petPackage.test.ts`(已存在,追加用例)

**Interfaces:**
- Produces: `export interface PetVoice { gptModel: string; sovitsModel: string; refAudio: string; refText: string }`;`PetManifest.voice?: PetVoice`

- [ ] **Step 1: 追加失败测试**

在 `src/shared/petPackage.test.ts` 里追加(先看一眼现有文件顶部的 import/辅助函数,沿用同样的 `parsePetManifest` 调用风格):

```ts
describe('parsePetManifest voice 字段(可选)', () => {
  const base = {
    id: 'alice', displayName: 'Alice', description: 'd', spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 1, fps: 1, loop: true } }
  }

  it('缺失 voice 字段 → 解析成功,voice 为 undefined', () => {
    const m = parsePetManifest(base)
    expect(m.voice).toBeUndefined()
  })

  it('完整 voice 字段 → 原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })
    expect(m.voice).toEqual({ gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' })
  })

  it('voice 字段存在但缺子字段 → 抛错', () => {
    expect(() => parsePetManifest({ ...base, voice: { gptModel: 'x' } })).toThrow()
  })

  it('voice 子字段为空字符串 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: '', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: 新增的 4 个用例中至少"缺失字段解析成功"与"完整字段保留"失败(`voice` 尚不存在于类型/解析逻辑里)。

- [ ] **Step 3: 实现**

在 `src/shared/petPackage.ts` 里,`PetManifest` 接口旁新增:

```ts
export interface PetVoice { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
```

修改 `PetManifest` 接口末尾加 `voice?: PetVoice`:

```ts
export interface PetManifest {
  id: string; displayName: string; description: string; spritesheetPath: string
  sheet: PetSheet; animations: Record<string, PetAnimation>
  voice?: PetVoice
}
```

在 `parsePetManifest` 函数里,`return m as PetManifest` 之前插入:

```ts
  if (m.voice !== undefined) {
    const v = m.voice
    assert(v && typeof v === 'object', 'manifest.voice must be an object when present')
    for (const k of ['gptModel', 'sovitsModel', 'refAudio', 'refText']) {
      assert(typeof v[k] === 'string' && v[k].length > 0, `manifest.voice.${k} must be a non-empty string`)
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/petPackage.ts src/shared/petPackage.test.ts
git commit -m "feat(voice): pet.json 新增可选 voice 字段(GPT/SoVITS/参考音频文本)"
```

---

## Task 2: 设置类型 `TtsSettings`(`src/shared/llm.ts`)

对应设计文档 §5。`schemaVersion` 8→9。

**Files:**
- Modify: `src/shared/llm.ts`

**Interfaces:**
- Produces: `TtsDevice`, `TtsTargetLanguage`, `TtsPlaybackTrigger`, `TtsSynthesisChunking`, `TtsSettings`, `DEFAULT_TTS_SETTINGS`, `AppSettings.tts: TtsSettings`, `SETTINGS_SCHEMA_VERSION = 9`

这是纯类型改动,没有独立单测(由 Task 3 的迁移测试覆盖)。

- [ ] **Step 1: 修改 `src/shared/llm.ts`**

在 `BrowserControlSettings` 定义之后、`SETTINGS_SCHEMA_VERSION` 之前插入:

```ts
export type TtsDevice = 'auto' | 'cuda' | 'cpu'
export type TtsTargetLanguage = 'auto' | 'zh' | 'ja' | 'en'
export type TtsPlaybackTrigger = 'batch' | 'stream'
export type TtsSynthesisChunking = 'token' | 'sentence'

export interface TtsSettings {
  enabled: boolean
  /** 语音运行时(可移植 Python + 依赖)安装位置;空字符串 = 未配置 */
  runtimeInstallPath: string
  device: TtsDevice
  useFlashAttn: boolean
  targetLanguage: TtsTargetLanguage
  playbackTrigger: TtsPlaybackTrigger
  synthesisChunking: TtsSynthesisChunking
  isCutText: boolean
  cutMinLen: number
  cutMute: number
  speed: number
  noiseScale: number
  temperature: number
  topK: number
  topP: number
  repetitionPenalty: number
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  runtimeInstallPath: '',
  device: 'auto',
  useFlashAttn: false,
  targetLanguage: 'auto',
  playbackTrigger: 'batch',
  synthesisChunking: 'sentence',
  isCutText: true,
  cutMinLen: 10,
  cutMute: 0.3,
  speed: 1,
  noiseScale: 0.5,
  temperature: 1,
  topK: 15,
  topP: 1,
  repetitionPenalty: 1.35
}
```

修改 `SETTINGS_SCHEMA_VERSION`:

```ts
export const SETTINGS_SCHEMA_VERSION = 9
```

修改 `AppSettings` 接口,末尾加 `tts: TtsSettings`:

```ts
export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; tts: TtsSettings }
```

修改 `DEFAULT_SETTINGS`,末尾加 `tts: DEFAULT_TTS_SETTINGS`:

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
  tts: DEFAULT_TTS_SETTINGS
}
```

- [ ] **Step 2: 编译检查(此时其余引用 AppSettings 字面量的地方会报缺 tts 字段的 TS 错,属预期,Task 3 会修 settings.ts,其余测试 fixture 在后续任务逐个修)**

Run: `pnpm typecheck`
Expected: 报错集中在 `src/main/config/settings.ts`(缺 tts 归一化)和各 `*.test.ts` 里手写的 `AppSettings` 字面量(如 `chat.test.ts` 顶部的 `settings` 常量)——这些在 Task 3 与后续任务里逐个处理,先确认没有意料之外的报错位置。

- [ ] **Step 3: Commit**

```bash
git add src/shared/llm.ts
git commit -m "feat(voice): 新增 TtsSettings 类型,schemaVersion 8→9"
```

---

## Task 3: 设置迁移(`src/main/config/settings.ts`)

对应设计文档 §5 表格。让 `normalizeSettings` 补全 `tts` 默认值/校验非法值,并修掉 Task 2 引入的编译错误。

**Files:**
- Modify: `src/main/config/settings.ts`
- Modify: `src/main/shell/chat.test.ts:12-22`(顶部 `settings` 常量补 `tts` 字段)
- Modify: `src/main/config/settings.test.ts:26`(手写的 `AppSettings` 字面量补 `tts` 字段)
- Modify: `src/main/providers/embedder.test.ts:55-65`(`base()` 辅助函数返回的 `AppSettings` 字面量补 `tts` 字段)
- Test: `src/main/config/settingsMigration.test.ts`(追加)

**Interfaces:**
- Consumes: `TtsSettings`, `DEFAULT_TTS_SETTINGS`, `TtsDevice`, `TtsTargetLanguage`, `TtsPlaybackTrigger`, `TtsSynthesisChunking`(Task 2)
- Produces: `normalizeSettings` 归一化后的 `AppSettings.tts` 字段(下游 Task 15/17/20 依赖这个已归一化的值,不需要再自行校验)

- [ ] **Step 1: 追加失败测试**

在 `src/main/config/settingsMigration.test.ts` 末尾追加:

```ts
describe('tts 迁移', () => {
  it('缺失 tts 时补齐 DEFAULT_TTS_SETTINGS 且 schemaVersion 升到 9', () => {
    const out = normalizeSettings({
      schemaVersion: 8,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false },
      firecrawl: { enabled: false },
      desktopControl: { enabled: false },
      browserControl: { enabled: false, mode: 'isolated' }
    })
    expect(out.schemaVersion).toBe(9)
    expect(out.tts).toEqual({
      enabled: false, runtimeInstallPath: '', device: 'auto', useFlashAttn: false,
      targetLanguage: 'auto', playbackTrigger: 'batch', synthesisChunking: 'sentence',
      isCutText: true, cutMinLen: 10, cutMute: 0.3,
      speed: 1, noiseScale: 0.5, temperature: 1, topK: 15, topP: 1, repetitionPenalty: 1.35
    })
  })

  it('保留已存的合法 tts 配置', () => {
    const out = normalizeSettings({
      tts: {
        enabled: true, runtimeInstallPath: 'D:\\voice-runtime', device: 'cuda', useFlashAttn: true,
        targetLanguage: 'ja', playbackTrigger: 'stream', synthesisChunking: 'token',
        isCutText: false, cutMinLen: 20, cutMute: 0.5,
        speed: 1.2, noiseScale: 0.4, temperature: 0.9, topK: 10, topP: 0.9, repetitionPenalty: 1.2
      }
    })
    expect(out.tts.enabled).toBe(true)
    expect(out.tts.runtimeInstallPath).toBe('D:\\voice-runtime')
    expect(out.tts.device).toBe('cuda')
    expect(out.tts.targetLanguage).toBe('ja')
    expect(out.tts.playbackTrigger).toBe('stream')
    expect(out.tts.synthesisChunking).toBe('token')
    expect(out.tts.speed).toBe(1.2)
  })

  it('非法枚举值退化为默认;非法数字退化为默认', () => {
    const out = normalizeSettings({
      tts: { device: 'quantum', targetLanguage: 'klingon', playbackTrigger: 'teleport', synthesisChunking: 'vibe', speed: 'fast', topK: -1 }
    })
    expect(out.tts.device).toBe('auto')
    expect(out.tts.targetLanguage).toBe('auto')
    expect(out.tts.playbackTrigger).toBe('batch')
    expect(out.tts.synthesisChunking).toBe('sentence')
    expect(out.tts.speed).toBe(1)
    expect(out.tts.topK).toBe(15)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/config/settingsMigration.test.ts`
Expected: FAIL(`out.tts` undefined 或 `normalizeSettings` 报类型错误)

- [ ] **Step 3: 实现**

在 `src/main/config/settings.ts` 顶部 import 里补上新类型:

```ts
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking } from '@shared/llm'
```

在文件顶部常量区(`BACKENDS` 旁)新增枚举白名单:

```ts
const TTS_DEVICES: TtsDevice[] = ['auto', 'cuda', 'cpu']
const TTS_TARGET_LANGUAGES: TtsTargetLanguage[] = ['auto', 'zh', 'ja', 'en']
const TTS_PLAYBACK_TRIGGERS: TtsPlaybackTrigger[] = ['batch', 'stream']
const TTS_SYNTHESIS_CHUNKINGS: TtsSynthesisChunking[] = ['token', 'sentence']

function normalizeNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}
```

在 `normalizeSettings` 函数体内,`browserControl` 归一化之后、`return` 之前插入:

```ts
  const tt2 = (r.tts ?? {}) as Record<string, unknown>
  const tts = {
    enabled: tt2.enabled === true,
    runtimeInstallPath: typeof tt2.runtimeInstallPath === 'string' ? tt2.runtimeInstallPath : DEFAULT_SETTINGS.tts.runtimeInstallPath,
    device: TTS_DEVICES.includes(tt2.device as TtsDevice) ? (tt2.device as TtsDevice) : DEFAULT_SETTINGS.tts.device,
    useFlashAttn: tt2.useFlashAttn === true,
    targetLanguage: TTS_TARGET_LANGUAGES.includes(tt2.targetLanguage as TtsTargetLanguage) ? (tt2.targetLanguage as TtsTargetLanguage) : DEFAULT_SETTINGS.tts.targetLanguage,
    playbackTrigger: TTS_PLAYBACK_TRIGGERS.includes(tt2.playbackTrigger as TtsPlaybackTrigger) ? (tt2.playbackTrigger as TtsPlaybackTrigger) : DEFAULT_SETTINGS.tts.playbackTrigger,
    synthesisChunking: TTS_SYNTHESIS_CHUNKINGS.includes(tt2.synthesisChunking as TtsSynthesisChunking) ? (tt2.synthesisChunking as TtsSynthesisChunking) : DEFAULT_SETTINGS.tts.synthesisChunking,
    isCutText: tt2.isCutText === undefined ? DEFAULT_SETTINGS.tts.isCutText : tt2.isCutText === true,
    cutMinLen: normalizeNumber(tt2.cutMinLen, DEFAULT_SETTINGS.tts.cutMinLen),
    cutMute: normalizeNumber(tt2.cutMute, DEFAULT_SETTINGS.tts.cutMute),
    speed: normalizeNumber(tt2.speed, DEFAULT_SETTINGS.tts.speed),
    noiseScale: normalizeNumber(tt2.noiseScale, DEFAULT_SETTINGS.tts.noiseScale),
    temperature: normalizeNumber(tt2.temperature, DEFAULT_SETTINGS.tts.temperature),
    topK: tt2.topK !== undefined && typeof tt2.topK === 'number' && Number.isFinite(tt2.topK) && tt2.topK >= 0 ? tt2.topK : DEFAULT_SETTINGS.tts.topK,
    topP: normalizeNumber(tt2.topP, DEFAULT_SETTINGS.tts.topP),
    repetitionPenalty: normalizeNumber(tt2.repetitionPenalty, DEFAULT_SETTINGS.tts.repetitionPenalty)
  }
```

修改 `return` 语句,末尾加 `tts`:

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

- [ ] **Step 4: 修复 `chat.test.ts` 顶部的字面量类型错误**

在 `src/main/shell/chat.test.ts:12-22` 的 `settings` 常量末尾加 `tts` 字段(引入 `DEFAULT_TTS_SETTINGS` import):

```ts
import type { AppSettings, StreamChunk } from '@shared/llm'
import { DEFAULT_TTS_SETTINGS } from '@shared/llm'
```

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
  tts: DEFAULT_TTS_SETTINGS
}
```

- [ ] **Step 5: 修复另外两处手写 `AppSettings` 字面量**

在 `src/main/config/settings.test.ts:26` 的 `s` 字面量末尾加 `tts: DEFAULT_SETTINGS.tts`(顶部已有的 `DEFAULT_SETTINGS` import 若没有则补上 `import { DEFAULT_SETTINGS } from '@shared/llm'` 之类的等价写法,与文件里已有的 import 风格保持一致)。

在 `src/main/providers/embedder.test.ts:55-65` 的 `base()` 函数返回对象末尾加 `tts: DEFAULT_TTS_SETTINGS`(顶部 import 补 `import { DEFAULT_TTS_SETTINGS } from '@shared/llm'`,或复用文件里已有的 `AppSettings` type-only import 语句旁新增一行值导入)。

- [ ] **Step 6: 运行测试与全量 typecheck 确认通过**

Run: `pnpm vitest run src/main/config/settingsMigration.test.ts src/main/config/settings.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts && pnpm typecheck`
Expected: 全部 PASS,typecheck 无残留 tts 相关报错。

- [ ] **Step 7: Commit**

```bash
git add src/main/config/settings.ts src/main/config/settingsMigration.test.ts src/main/config/settings.test.ts src/main/providers/embedder.test.ts src/main/shell/chat.test.ts
git commit -m "feat(voice): 设置迁移补 tts 默认值(schemaVersion 8→9)"
```

---

## Task 4: 语言检测启发式(`src/main/voice/languageDetect.ts`)

对应设计文档 §6。判断朗读文本是否已经以目标语言为主(跳过翻译)。

**Files:**
- Create: `src/main/voice/languageDetect.ts`
- Test: `src/main/voice/languageDetect.test.ts`

**Interfaces:**
- Produces: `export function needsTranslation(text: string, target: TtsTargetLanguage): boolean`(Task 11 的 `voiceProvider.ts` 会调用)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { needsTranslation } from './languageDetect'

describe('needsTranslation', () => {
  it('target 为 auto 时永远不需要翻译', () => {
    expect(needsTranslation('Hello world', 'auto')).toBe(false)
    expect(needsTranslation('你好世界', 'auto')).toBe(false)
  })

  it('target=zh,文本已经以中文为主 → 不需要翻译', () => {
    expect(needsTranslation('你好,今天天气不错。', 'zh')).toBe(false)
  })

  it('target=zh,文本是纯英文 → 需要翻译', () => {
    expect(needsTranslation('Hello, nice weather today.', 'zh')).toBe(true)
  })

  it('target=ja,文本含假名 → 不需要翻译(即便混了英文,GSV 自动分段处理混合)', () => {
    expect(needsTranslation('こんにちは、Nice to meet you.', 'ja')).toBe(false)
  })

  it('target=ja,文本不含任何假名(纯中文或纯英文)→ 需要翻译', () => {
    expect(needsTranslation('你好,很高兴认识你。', 'ja')).toBe(true)
    expect(needsTranslation('Hello, nice to meet you.', 'ja')).toBe(true)
  })

  it('target=en,文本已经以英文为主 → 不需要翻译', () => {
    expect(needsTranslation('Hello, nice to meet you.', 'en')).toBe(false)
  })

  it('target=en,文本是纯中文 → 需要翻译', () => {
    expect(needsTranslation('你好,很高兴认识你。', 'en')).toBe(true)
  })

  it('空文本(或全空白)→ 不需要翻译', () => {
    expect(needsTranslation('   ', 'zh')).toBe(false)
    expect(needsTranslation('', 'ja')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/languageDetect.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import type { TtsTargetLanguage } from '@shared/llm'

const CJK = /[一-鿿]/
const KANA = /[぀-ゟ゠-ヿ]/
const LATIN = /[A-Za-z]/

/** 粗略判断:朗读文本是否已经以 target 语言为主,若是则可跳过翻译直接送去合成。 */
export function needsTranslation(text: string, target: TtsTargetLanguage): boolean {
  if (target === 'auto') return false
  const chars = [...text].filter((c) => !/\s/.test(c))
  if (chars.length === 0) return false

  if (target === 'ja') return !chars.some((c) => KANA.test(c))

  if (target === 'zh') {
    const cjk = chars.filter((c) => CJK.test(c)).length
    return cjk / chars.length < 0.5
  }

  // target === 'en'
  const latin = chars.filter((c) => LATIN.test(c)).length
  return latin / chars.length < 0.5
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/languageDetect.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/languageDetect.ts src/main/voice/languageDetect.test.ts
git commit -m "feat(voice): 目标朗读语言检测启发式(是否需要翻译)"
```

---

## Task 5: 流式句子切分器(`src/main/voice/sentenceSplitter.ts`)

对应设计文档 §6。`stream` 播放触发模式下,把 LLM 增量输出的文本切成一个个完整句子。

**Files:**
- Create: `src/main/voice/sentenceSplitter.ts`
- Test: `src/main/voice/sentenceSplitter.test.ts`

**Interfaces:**
- Produces: `export interface SentenceSplitter { push(delta: string): string[]; flush(): string | null }`、`export function createSentenceSplitter(): SentenceSplitter`(Task 17 的 `chat.ts` 接线会用)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createSentenceSplitter } from './sentenceSplitter'

describe('createSentenceSplitter', () => {
  it('单次 push 完整一句 → 立即吐出该句', () => {
    const s = createSentenceSplitter()
    expect(s.push('你好。')).toEqual(['你好。'])
  })

  it('跨多次 push 拼出一句 → 只在句子边界吐出', () => {
    const s = createSentenceSplitter()
    expect(s.push('你')).toEqual([])
    expect(s.push('好')).toEqual([])
    expect(s.push('。')).toEqual(['你好。'])
  })

  it('一次 push 含多句 → 全部吐出,按序', () => {
    const s = createSentenceSplitter()
    expect(s.push('第一句。第二句!第三句?')).toEqual(['第一句。', '第二句!', '第三句?'])
  })

  it('英文标点、省略号、混合标点均能切分', () => {
    const s = createSentenceSplitter()
    expect(s.push('Hello world. こんにちは!你好…')).toEqual(['Hello world.', ' こんにちは!', '你好…'])
  })

  it('flush 吐出尾部不完整的句子;若尾部为空则返回 null', () => {
    const s = createSentenceSplitter()
    s.push('完整句子。剩下没说完')
    expect(s.flush()).toBe('剩下没说完')
    expect(s.flush()).toBeNull()
  })

  it('flush 后再 push 不会带出旧内容', () => {
    const s = createSentenceSplitter()
    s.push('第一句。剩余')
    s.flush()
    expect(s.push('新内容。')).toEqual(['新内容。'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/sentenceSplitter.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
const SENTENCE_END = /[。！？.!?…]/

export interface SentenceSplitter {
  /** 喂入一段新的增量文本,返回本次新增的、已经凑齐的完整句子(可能为空数组)。 */
  push(delta: string): string[]
  /** 回复结束时调用:吐出缓冲区里剩下的不完整尾巴(无则返回 null)并清空缓冲区。 */
  flush(): string | null
}

function findBoundary(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (SENTENCE_END.test(s[i])) return i
  }
  return -1
}

export function createSentenceSplitter(): SentenceSplitter {
  let buf = ''
  return {
    push(delta: string): string[] {
      buf += delta
      const out: string[] = []
      let start = 0
      while (start < buf.length) {
        const idx = findBoundary(buf, start)
        if (idx === -1) break
        out.push(buf.slice(start, idx + 1))
        start = idx + 1
      }
      buf = buf.slice(start)
      return out
    },
    flush(): string | null {
      const rest = buf
      buf = ''
      return rest.trim().length > 0 ? rest : null
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/sentenceSplitter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/sentenceSplitter.ts src/main/voice/sentenceSplitter.test.ts
git commit -m "feat(voice): 流式句子切分器(stream 播放触发模式用)"
```

---

## Task 6: SSE 帧解析器(`src/main/voice/sseParser.ts`)

对应设计文档 §2/§8。手写解析 sidecar `/speak` 端点吐出的 `text/event-stream` 帧,替代 `ws` 包。

**Files:**
- Create: `src/main/voice/sseParser.ts`
- Test: `src/main/voice/sseParser.test.ts`

**Interfaces:**
- Produces: `export interface SseFrame { event: string; data: string }`、`export function createSseParser(): { push(chunk: string): SseFrame[] }`(Task 9 的 `voiceSidecar.ts` 真实传输层会用)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createSseParser } from './sseParser'

describe('createSseParser', () => {
  it('单个完整帧', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: {"a":1}\n\n')
    expect(frames).toEqual([{ event: 'audio', data: '{"a":1}' }])
  })

  it('一次 push 含多个帧', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n')
    expect(frames).toEqual([{ event: 'audio', data: '{"a":1}' }, { event: 'done', data: '{}' }])
  })

  it('帧跨多次 push(网络分片)→ 缓冲到完整帧再吐出', () => {
    const p = createSseParser()
    expect(p.push('event: audio\nda')).toEqual([])
    expect(p.push('ta: {"a":1}\n\n')).toEqual([{ event: 'audio', data: '{"a":1}' }])
  })

  it('data 跨多行 → 按 \\n 拼接', () => {
    const p = createSseParser()
    const frames = p.push('event: audio\ndata: line1\ndata: line2\n\n')
    expect(frames).toEqual([{ event: 'audio', data: 'line1\nline2' }])
  })

  it('缺失 event 行 → 默认 event 为 message', () => {
    const p = createSseParser()
    const frames = p.push('data: hi\n\n')
    expect(frames).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('没有 data 行的帧 → 不产出(避免空帧误判为音频结束)', () => {
    const p = createSseParser()
    const frames = p.push('event: ping\n\n')
    expect(frames).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/sseParser.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
export interface SseFrame { event: string; data: string }

export interface SseParser {
  /** 喂入一段原始响应体文本(可能是不完整的网络分片),返回本次新解析出的完整帧。 */
  push(chunk: string): SseFrame[]
}

export function createSseParser(): SseParser {
  let buf = ''
  return {
    push(chunk: string): SseFrame[] {
      buf += chunk
      const frames: SseFrame[] = []
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
        }
        if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
      }
      return frames
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/sseParser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/sseParser.ts src/main/voice/sseParser.test.ts
git commit -m "feat(voice): 手写 SSE 帧解析器(替代 ws 包,规避 binaryType 丢帧类 bug)"
```

---

## Task 7: 运行时标记文件(`src/main/voice/runtimeMarker.ts`)

对应设计文档 §3。判断"语音运行时是否已安装且可用"。

**Files:**
- Create: `src/main/voice/runtimeMarker.ts`
- Test: `src/main/voice/runtimeMarker.test.ts`

**Interfaces:**
- Produces: `VOICE_RUNTIME_MARKER_VERSION`、`RuntimeMarker`、`parseRuntimeMarker(raw: string): RuntimeMarker | null`、`isRuntimeUsable(marker: RuntimeMarker | null): boolean`、`serializeRuntimeMarker(m: RuntimeMarker): string`(Task 12/13/15 会用来读写安装位置下的标记文件)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseRuntimeMarker, isRuntimeUsable, serializeRuntimeMarker, VOICE_RUNTIME_MARKER_VERSION } from './runtimeMarker'

describe('runtimeMarker', () => {
  it('序列化后能原样解析回来', () => {
    const m = { markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: 'cuda' as const }
    expect(parseRuntimeMarker(serializeRuntimeMarker(m))).toEqual(m)
  })

  it('非法 JSON → 返回 null', () => {
    expect(parseRuntimeMarker('not json')).toBeNull()
  })

  it('缺字段 → 返回 null', () => {
    expect(parseRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })

  it('device 不是 cuda/cpu → 返回 null', () => {
    expect(parseRuntimeMarker(JSON.stringify({ markerVersion: 1, gsvTtsLiteVersion: '0.4.6', device: 'quantum' }))).toBeNull()
  })

  it('isRuntimeUsable:null → false', () => {
    expect(isRuntimeUsable(null)).toBe(false)
  })

  it('isRuntimeUsable:markerVersion 与当前版本不符 → false(需要重新安装)', () => {
    expect(isRuntimeUsable({ markerVersion: VOICE_RUNTIME_MARKER_VERSION + 1, gsvTtsLiteVersion: '0.4.6', device: 'cpu' })).toBe(false)
  })

  it('isRuntimeUsable:版本匹配 → true', () => {
    expect(isRuntimeUsable({ markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: 'cpu' })).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/runtimeMarker.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
export const VOICE_RUNTIME_MARKER_VERSION = 1

export interface RuntimeMarker {
  markerVersion: number
  gsvTtsLiteVersion: string
  device: 'cuda' | 'cpu'
}

export function parseRuntimeMarker(raw: string): RuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.gsvTtsLiteVersion !== 'string') return null
    if (j.device !== 'cuda' && j.device !== 'cpu') return null
    return { markerVersion: j.markerVersion, gsvTtsLiteVersion: j.gsvTtsLiteVersion, device: j.device }
  } catch {
    return null
  }
}

export function isRuntimeUsable(marker: RuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === VOICE_RUNTIME_MARKER_VERSION
}

export function serializeRuntimeMarker(m: RuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/runtimeMarker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/runtimeMarker.ts src/main/voice/runtimeMarker.test.ts
git commit -m "feat(voice): 语音运行时安装标记文件的解析/校验"
```

---

## Task 8: Python sidecar 适配脚本(`resources/voice/gsv_server.py`)

对应设计文档 §2/§8。精简的 `/speak` SSE 端点,stdlib `http.server` 实现,不引入 `fastapi`/`uvicorn`。启动时一次性绑定一个 GPT+SoVITS 模型与参考音频/文本。这是本计划里唯一不走 Vitest 的任务——用用户已经建好的 `GSV-TTS-Lite` conda 环境手动跑一次验证。

**Files:**
- Create: `resources/voice/gsv_server.py`

**Interfaces:**
- Produces:CLI `python gsv_server.py --port <p> --gpt-model <path> --sovits-model <path> --ref-audio <path> --ref-text-file <path> [--device cuda|cpu] [--use-flash-attn]`,启动后 stdout 打印一行 `READY`,随后监听 `POST /speak`(SSE 响应体,`event: audio`/`event: done`/`event: error` 三种帧,`audio` 帧的 `data` 是 `{"audio": "<base64 float32 PCM>", "sampleRate": 32000}`)。Task 9 的 `voiceSidecar.ts` 依赖这个 CLI 与协议形状。

- [ ] **Step 1: 写脚本**

```python
"""Pet-Agent 语音 sidecar —— GSV-TTS-Lite 的最小推理适配层。

不含 GSV-TTS-Lite 自带的 WebUI / ASR 自动识别 / 批量推理 / api_v2 兼容层——
只暴露一个 /speak 端点(SSE),启动时一次性绑定单个 GPT+SoVITS 模型与参考音频/
文本(随 Pet-Agent 的宠物包走,见 pet.json 的 voice 字段)。

用 Python 标准库 http.server 实现,不引入 fastapi/uvicorn/pydantic/starlette——
唯一的调用方是 Pet-Agent 自己的主进程,请求形状固定,用不上那些库的路由/校验/
文档机制,少一环安装失败点。
"""
import sys
import json
import base64
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gsv_tts import TTS

tts: "TTS | None" = None
REF_AUDIO = ""
REF_TEXT = ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def do_POST(self):
        if self.path != "/speak":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            stream_mode = "sentence" if body.get("synthesisChunking") == "sentence" else "token"
            for clip in tts.infer_stream(
                spk_audio_path=REF_AUDIO,
                prompt_audio_path=REF_AUDIO,
                prompt_audio_text=REF_TEXT,
                text=body["text"],
                is_cut_text=bool(body.get("isCutText", True)),
                cut_minlen=int(body.get("cutMinLen", 10)),
                cut_mute=float(body.get("cutMute", 0.3)),
                stream_mode=stream_mode,
                top_k=int(body.get("topK", 15)),
                top_p=float(body.get("topP", 1.0)),
                temperature=float(body.get("temperature", 1.0)),
                repetition_penalty=float(body.get("repetitionPenalty", 1.35)),
                noise_scale=float(body.get("noiseScale", 0.5)),
                speed=float(body.get("speed", 1.0)),
                debug=False,
            ):
                audio_b64 = base64.b64encode(clip.audio_data.tobytes()).decode("ascii")
                payload = json.dumps({"audio": audio_b64, "sampleRate": clip.samplerate})
                self.wfile.write(("event: audio\ndata: %s\n\n" % payload).encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b"event: done\ndata: {}\n\n")
            self.wfile.flush()
        except Exception as e:
            err = json.dumps({"error": str(e)})
            self.wfile.write(("event: error\ndata: %s\n\n" % err).encode("utf-8"))
            self.wfile.flush()


def main():
    global tts, REF_AUDIO, REF_TEXT

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--gpt-model", required=True)
    parser.add_argument("--sovits-model", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text-file", required=True)
    parser.add_argument("--device", default=None)
    parser.add_argument("--use-flash-attn", action="store_true")
    args = parser.parse_args()

    REF_AUDIO = args.ref_audio
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        REF_TEXT = f.read().strip()

    tts = TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn)
    tts.load_gpt_model(args.gpt_model)
    tts.load_sovits_model(args.sovits_model)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 用用户已建好的 conda 环境手动验证(非 Vitest)**

Run(把路径换成用户给的真实路径):

```bash
"D:\miniconda3\envs\GSV-TTS-Lite\python.exe" resources/voice/gsv_server.py ^
  --port 8850 ^
  --gpt-model "E:\GST\GPT-SoVITS-v2pro-20250604\GPT_weights_v2Pro\Alice_v2pro-e15.ckpt" ^
  --sovits-model "E:\GST\GPT-SoVITS-v2pro-20250604\SoVITS_weights_v2Pro\Alice_v2pro_e8_s1032.pth" ^
  --ref-audio "pets/alice/voice/ailisi_4.wav" ^
  --ref-text-file "pets/alice/voice/ailisi_4.txt"
```

Expected: 控制台打印一行 `READY`(模型加载完成后)。另开一个终端跑:

```bash
curl -N -X POST http://127.0.0.1:8850/speak -H "Content-Type: application/json" -d "{\"text\":\"你好,这是一次测试。\",\"synthesisChunking\":\"sentence\"}"
```

Expected: 看到若干 `event: audio` 帧(`data` 里有 base64 字符串),最后一帧是 `event: done`。若报错,先确认 `pets/alice/voice/ailisi_4.wav`/`ailisi_4.txt` 已经就位(Task 21 才会正式挪进去;此处手动验证可以先临时指向仓库根 `Reference/ailisi_4.wav`/`Reference/Alice_reference_content.txt`)。

- [ ] **Step 3: Commit**

```bash
git add resources/voice/gsv_server.py
git commit -m "feat(voice): GSV-TTS-Lite 最小 sidecar 适配脚本(stdlib SSE /speak 端点)"
```

---

## Task 9: Sidecar 客户端编排(`src/main/voice/voiceSidecar.ts`)

对应设计文档 §2/§7。注入式 spawn + HTTP 传输(仿 `automationControl.ts` 的 `execFile` 注入风格),真实的 `child_process`/`http` 实现留到 Task 15 在 `shell/index.ts` 里接线。

**Files:**
- Create: `src/main/voice/voiceSidecar.ts`
- Test: `src/main/voice/voiceSidecar.test.ts`

**Interfaces:**
- Consumes: `SseFrame`(Task 6)
- Produces:
  ```ts
  export interface SpeakRequest {
    text: string
    isCutText: boolean; cutMinLen: number; cutMute: number
    synthesisChunking: 'token' | 'sentence'
    speed: number; noiseScale: number; temperature: number
    topK: number; topP: number; repetitionPenalty: number
  }
  export interface PcmChunk { audioBase64: string; sampleRate: number }
  export interface VoiceSidecar {
    start(): Promise<void>
    speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void>
    stop(): void
  }
  export function createVoiceSidecar(opts: {
    port: number
    spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
    postSse: (port: number, path: string, body: unknown, onFrame: (f: import('./sseParser').SseFrame) => void, signal: AbortSignal) => Promise<void>
  }): VoiceSidecar
  ```
  (Task 11 的 `voiceProvider.ts`、Task 15 的真实接线都依赖这些名字)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createVoiceSidecar, type SpeakRequest } from './voiceSidecar'
import type { SseFrame } from './sseParser'

const req: SpeakRequest = {
  text: '你好', isCutText: true, cutMinLen: 10, cutMute: 0.3,
  synthesisChunking: 'sentence', speed: 1, noiseScale: 0.5, temperature: 1,
  topK: 15, topP: 1, repetitionPenalty: 1.35
}

describe('createVoiceSidecar', () => {
  it('start() 调用 spawnProcess 并等待 waitReady', async () => {
    const kill = vi.fn()
    const waitReady = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => ({ kill, waitReady }))
    const postSse = vi.fn(async () => {})
    const sc = createVoiceSidecar({ port: 8850, spawnProcess, postSse })
    await sc.start()
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(waitReady).toHaveBeenCalledTimes(1)
  })

  it('speak():把 audio 帧转成 PcmChunk 逐个回调,done 帧后 resolve', async () => {
    const postSse = vi.fn(async (_port, _path, _body, onFrame: (f: SseFrame) => void) => {
      onFrame({ event: 'audio', data: JSON.stringify({ audio: 'QUJD', sampleRate: 32000 }) })
      onFrame({ event: 'audio', data: JSON.stringify({ audio: 'REVG', sampleRate: 32000 }) })
      onFrame({ event: 'done', data: '{}' })
    })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    const chunks: { audioBase64: string; sampleRate: number }[] = []
    await sc.speak(req, (c) => chunks.push(c), new AbortController().signal)
    expect(chunks).toEqual([{ audioBase64: 'QUJD', sampleRate: 32000 }, { audioBase64: 'REVG', sampleRate: 32000 }])
  })

  it('speak():收到 error 帧 → 抛错,携带错误信息', async () => {
    const postSse = vi.fn(async (_port, _path, _body, onFrame: (f: SseFrame) => void) => {
      onFrame({ event: 'error', data: JSON.stringify({ error: '模型未加载' }) })
    })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    await expect(sc.speak(req, () => {}, new AbortController().signal)).rejects.toThrow('模型未加载')
  })

  it('speak():postSse 本身拒绝(连接失败等)→ 原样向上抛', async () => {
    const postSse = vi.fn(async () => { throw new Error('连接被拒绝') })
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill: vi.fn(), waitReady: vi.fn(async () => {}) }),
      postSse
    })
    await expect(sc.speak(req, () => {}, new AbortController().signal)).rejects.toThrow('连接被拒绝')
  })

  it('stop():调用 spawnProcess 返回对象的 kill()', async () => {
    const kill = vi.fn()
    const sc = createVoiceSidecar({
      port: 8850,
      spawnProcess: () => ({ kill, waitReady: vi.fn(async () => {}) }),
      postSse: vi.fn(async () => {})
    })
    await sc.start()
    sc.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/voiceSidecar.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import type { SseFrame } from './sseParser'

export interface SpeakRequest {
  text: string
  isCutText: boolean; cutMinLen: number; cutMute: number
  synthesisChunking: 'token' | 'sentence'
  speed: number; noiseScale: number; temperature: number
  topK: number; topP: number; repetitionPenalty: number
}

export interface PcmChunk { audioBase64: string; sampleRate: number }

export interface VoiceSidecar {
  start(): Promise<void>
  speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void>
  stop(): void
}

export function createVoiceSidecar(opts: {
  port: number
  spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
  postSse: (port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal) => Promise<void>
}): VoiceSidecar {
  let proc: { kill(): void } | null = null

  return {
    async start(): Promise<void> {
      const p = opts.spawnProcess()
      proc = p
      await p.waitReady()
    },
    async speak(req: SpeakRequest, onChunk: (c: PcmChunk) => void, signal: AbortSignal): Promise<void> {
      let sseError: string | null = null
      await opts.postSse(opts.port, '/speak', req, (frame) => {
        if (frame.event === 'audio') {
          const parsed = JSON.parse(frame.data) as { audio: string; sampleRate: number }
          onChunk({ audioBase64: parsed.audio, sampleRate: parsed.sampleRate })
        } else if (frame.event === 'error') {
          const parsed = JSON.parse(frame.data) as { error: string }
          sseError = parsed.error
        }
      }, signal)
      if (sseError) throw new Error(sseError)
    },
    stop(): void {
      proc?.kill()
      proc = null
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/voiceSidecar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/voiceSidecar.ts src/main/voice/voiceSidecar.test.ts
git commit -m "feat(voice): sidecar 客户端编排(注入式 spawn/HTTP,不引入 ws 包)"
```

---

## Task 10: LLM 翻译辅助(`src/main/voice/translate.ts`)

对应设计文档 §6。仅在 `targetLanguage != 'auto'` 且 `needsTranslation` 为真时被调用。

**Files:**
- Create: `src/main/voice/translate.ts`
- Test: `src/main/voice/translate.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`(既有,`src/main/providers/llmProvider.ts`)
- Produces: `export interface Translator { translate(text: string, target: 'zh'|'ja'|'en', signal: AbortSignal): Promise<string> }`、`export function createLlmTranslator(provider: LlmProvider): Translator`(Task 11 依赖)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createLlmTranslator } from './translate'
import { createFakeProvider } from '../providers/fakeProvider'

describe('createLlmTranslator', () => {
  it('把 provider 的流式文本拼成完整译文', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'こんにちは' }))
    const out = await translator.translate('你好', 'ja', new AbortController().signal)
    expect(out).toBe('こんにちは')
  })

  it('provider 报错 → 向上抛出', async () => {
    const translator = createLlmTranslator(createFakeProvider({ failWith: '模型不可用' }))
    await expect(translator.translate('你好', 'en', new AbortController().signal)).rejects.toThrow('模型不可用')
  })

  it('已取消的 signal → fakeProvider 立即结束,返回空字符串', async () => {
    const translator = createLlmTranslator(createFakeProvider({ reply: 'hello', delayMs: 50 }))
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await translator.translate('你好', 'en', ctrl.signal)
    expect(out).toBe('')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import type { LlmProvider } from '../providers/llmProvider'

export interface Translator {
  translate(text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal): Promise<string>
}

const LANG_NAME: Record<'zh' | 'ja' | 'en', string> = { zh: '中文', ja: '日语', en: '英语' }

export function createLlmTranslator(provider: LlmProvider): Translator {
  return {
    async translate(text, target, signal) {
      const system = `你是翻译引擎。把用户给的文本整体翻译成${LANG_NAME[target]},只输出翻译结果本身,不要解释、不要加引号、不要保留原文。`
      let acc = ''
      for await (const chunk of provider.streamChat({ system, messages: [{ role: 'user', content: text }], maxOutputTokens: 1024, signal })) {
        if (chunk.type === 'text') acc += chunk.text
        else if (chunk.type === 'error') throw new Error(chunk.message)
      }
      return acc.trim()
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/translate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/translate.ts src/main/voice/translate.test.ts
git commit -m "feat(voice): 目标朗读语言的 LLM 整句翻译辅助"
```

---

## Task 11: 语音编排层(`src/main/voice/voiceProvider.ts`)

对应设计文档 §6。串联"是否需要翻译 → 调 sidecar 合成 → 回调 PCM 块",供 Task 17 的 `chat.ts` 接线调用。

**Files:**
- Create: `src/main/voice/voiceProvider.ts`
- Test: `src/main/voice/voiceProvider.test.ts`

**Interfaces:**
- Consumes: `VoiceSidecar`, `PcmChunk`(Task 9)、`Translator`(Task 10)、`needsTranslation`(Task 4)、`TtsSettings`(Task 2)
- Produces:
  ```ts
  export interface VoiceProvider {
    speak(text: string): Promise<void>
    stop(): void
  }
  export function createVoiceProvider(opts: {
    sidecar: VoiceSidecar
    translator: Translator
    getSettings: () => TtsSettings
    onChunk: (c: PcmChunk) => void
    onError: (message: string) => void
  }): VoiceProvider
  ```
  (Task 17 的 `chat.ts` 用同一个 `voiceProvider.speak(text)` 处理 batch 模式的完整回复和 stream 模式的单句;`stop()` 打断正在进行的翻译/合成)

- [ ] **Step 1: 写失败测试**

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
      onChunk: (c) => chunks.push(c), onError: () => {}
    })
    await vp.speak('你好')
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
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('你好')
    expect(translate).toHaveBeenCalledWith('你好', 'ja', expect.any(Object))
    expect(sidecar.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'こんにちは' }), expect.any(Function), expect.any(Object))
  })

  it('targetLanguage=ja 且文本已含假名 → 跳过翻译', async () => {
    const translate = vi.fn()
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('こんにちは')
    expect(translate).not.toHaveBeenCalled()
  })

  it('翻译失败 → onError 收到消息,不调用 sidecar.speak', async () => {
    const translate = vi.fn(async () => { throw new Error('翻译服务不可用') })
    const sidecar = fakeSidecar()
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate },
      getSettings: () => ({ ...DEFAULT_TTS_SETTINGS, targetLanguage: 'ja' }),
      onChunk: () => {}, onError: (m) => errors.push(m)
    })
    await vp.speak('你好')
    expect(sidecar.speak).not.toHaveBeenCalled()
    expect(errors[0]).toContain('翻译服务不可用')
  })

  it('sidecar.speak 失败 → onError 收到消息', async () => {
    const sidecar = fakeSidecar({ speak: vi.fn(async () => { throw new Error('合成失败') }) })
    const errors: string[] = []
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: (m) => errors.push(m)
    })
    await vp.speak('你好')
    expect(errors[0]).toContain('合成失败')
  })

  it('空文本/纯空白 → 直接跳过,不调用 sidecar', async () => {
    const sidecar = fakeSidecar()
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: () => {}
    })
    await vp.speak('   ')
    expect(sidecar.speak).not.toHaveBeenCalled()
  })

  it('stop() 让正在进行的 speak() 的 signal 被 abort', async () => {
    let capturedSignal: AbortSignal | null = null
    const sidecar = fakeSidecar({
      speak: vi.fn(async (_req, _onChunk, signal: AbortSignal) => { capturedSignal = signal })
    })
    const vp = createVoiceProvider({
      sidecar, translator: { translate: vi.fn() },
      getSettings: () => DEFAULT_TTS_SETTINGS,
      onChunk: () => {}, onError: () => {}
    })
    const p = vp.speak('你好')
    vp.stop()
    await p
    expect(capturedSignal?.aborted).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import type { TtsSettings } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'
import { needsTranslation } from './languageDetect'

export interface VoiceProvider {
  speak(text: string): Promise<void>
  stop(): void
}

export function createVoiceProvider(opts: {
  sidecar: VoiceSidecar
  translator: Translator
  getSettings: () => TtsSettings
  onChunk: (c: PcmChunk) => void
  onError: (message: string) => void
}): VoiceProvider {
  let current: AbortController | null = null

  return {
    async speak(text: string): Promise<void> {
      if (!text.trim()) return
      const settings = opts.getSettings()
      const ctrl = new AbortController()
      current = ctrl

      let toSpeak = text
      if (settings.targetLanguage !== 'auto' && needsTranslation(text, settings.targetLanguage)) {
        try {
          toSpeak = await opts.translator.translate(text, settings.targetLanguage, ctrl.signal)
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
        }, opts.onChunk, ctrl.signal)
      } catch (e) {
        opts.onError(`语音合成失败:${String((e as Error)?.message ?? e)}`)
      }
    },
    stop(): void {
      current?.abort()
      current = null
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/voiceProvider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/voiceProvider.ts src/main/voice/voiceProvider.test.ts
git commit -m "feat(voice): 语音编排层(翻译判断→合成→PCM回调,支持 stop 打断)"
```

---

## Task 12: 现场安装步骤编排(`src/main/voice/voiceRuntimeInstall.ts`)

对应设计文档 §3.2。注入式步骤函数(仿 Task 9 风格),真实的下载/`pip install`/GPU 检测实现留到 Task 15。

**Files:**
- Create: `src/main/voice/voiceRuntimeInstall.ts`
- Test: `src/main/voice/voiceRuntimeInstall.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type InstallStage = 'download-python' | 'enable-pip' | 'detect-gpu' | 'install-torch' | 'install-gsv-tts-lite' | 'warm-start-models' | 'done'
  export interface InstallProgress { stage: InstallStage; message: string }
  export interface InstallStepRunner {
    downloadEmbeddablePython(destDir: string): Promise<void>
    enablePip(destDir: string): Promise<void>
    detectGpu(): Promise<boolean>
    installTorch(destDir: string, useCuda: boolean): Promise<void>
    installGsvTtsLite(destDir: string): Promise<void>
    warmStartModels(destDir: string): Promise<void>
  }
  export function runVoiceRuntimeInstall(opts: {
    destDir: string
    device: 'auto' | 'cuda' | 'cpu'
    steps: InstallStepRunner
    onProgress: (p: InstallProgress) => void
  }): Promise<{ ok: true } | { ok: false; error: string; stage: InstallStage }>
  ```
  (Task 15 用真实的 `InstallStepRunner` 实现接线到 IPC)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runVoiceRuntimeInstall, type InstallStepRunner, type InstallProgress } from './voiceRuntimeInstall'

function fakeSteps(overrides?: Partial<InstallStepRunner>): InstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    detectGpu: vi.fn(async () => true),
    installTorch: vi.fn(async () => {}),
    installGsvTtsLite: vi.fn(async () => {}),
    warmStartModels: vi.fn(async () => {}),
    ...overrides
  }
}

describe('runVoiceRuntimeInstall', () => {
  it('device=auto 且检测到 GPU → 按顺序跑完全部步骤,installTorch 收到 useCuda:true', async () => {
    const steps = fakeSteps()
    const progress: InstallProgress[] = []
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'auto', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true)
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'detect-gpu', 'install-torch', 'install-gsv-tts-lite', 'warm-start-models', 'done'
    ])
  })

  it('device=cpu → 不调用 detectGpu,installTorch 收到 useCuda:false', async () => {
    const steps = fakeSteps()
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: true })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', false)
  })

  it('device=cuda → 不调用 detectGpu,installTorch 收到 useCuda:true', async () => {
    const steps = fakeSteps()
    await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cuda', steps, onProgress: () => {} })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true)
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installTorch: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-torch' })
    expect(steps.installGsvTtsLite).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/voice/voiceRuntimeInstall.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
export type InstallStage =
  | 'download-python' | 'enable-pip' | 'detect-gpu'
  | 'install-torch' | 'install-gsv-tts-lite' | 'warm-start-models' | 'done'

export interface InstallProgress { stage: InstallStage; message: string }

export interface InstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string): Promise<void>
  detectGpu(): Promise<boolean>
  installTorch(destDir: string, useCuda: boolean): Promise<void>
  installGsvTtsLite(destDir: string): Promise<void>
  warmStartModels(destDir: string): Promise<void>
}

export async function runVoiceRuntimeInstall(opts: {
  destDir: string
  device: 'auto' | 'cuda' | 'cpu'
  steps: InstallStepRunner
  onProgress: (p: InstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: InstallStage }> {
  let stage: InstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir)

    let useCuda = opts.device === 'cuda'
    if (opts.device === 'auto') {
      stage = 'detect-gpu'
      opts.onProgress({ stage, message: '检测 GPU…' })
      useCuda = await opts.steps.detectGpu()
    }

    stage = 'install-torch'
    opts.onProgress({ stage, message: useCuda ? '安装 PyTorch (CUDA)…' : '安装 PyTorch (CPU)…' })
    await opts.steps.installTorch(opts.destDir, useCuda)

    stage = 'install-gsv-tts-lite'
    opts.onProgress({ stage, message: '安装 GSV-TTS-Lite…' })
    await opts.steps.installGsvTtsLite(opts.destDir)

    stage = 'warm-start-models'
    opts.onProgress({ stage, message: '下载基础模型(首次)…' })
    await opts.steps.warmStartModels(opts.destDir)

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/voice/voiceRuntimeInstall.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/voiceRuntimeInstall.ts src/main/voice/voiceRuntimeInstall.test.ts
git commit -m "feat(voice): 现场安装步骤编排(下载→pip→GPU检测→模型预热)"
```

---

## Task 13: 运行时压缩包导入导出(`src/main/voice/voiceRuntimeArchive.ts`)

对应设计文档 §3.3。新增依赖 `adm-zip`(纯 JS,无原生依赖)。

**Files:**
- Modify: `package.json`(新增 `dependencies.adm-zip` 与 `devDependencies.@types/adm-zip`)
- Create: `src/main/voice/voiceRuntimeArchive.ts`
- Test: `src/main/voice/voiceRuntimeArchive.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ArchiveIO { extractZip(zipPath: string, destDir: string): Promise<void>; createZip(srcDir: string, zipPath: string): Promise<void> }
  export function importVoiceRuntimeArchive(opts: { zipPath: string; destDir: string; io: ArchiveIO }): Promise<{ ok: true } | { ok: false; error: string }>
  export function exportVoiceRuntimeArchive(opts: { srcDir: string; zipPath: string; io: ArchiveIO }): Promise<{ ok: true } | { ok: false; error: string }>
  export function createAdmZipArchiveIO(): ArchiveIO
  ```
  (Task 15 用 `createAdmZipArchiveIO()` 接线到真实文件系统;测试只覆盖 `import`/`export` 的错误处理逻辑,不测 `adm-zip` 本身)

- [ ] **Step 1: 安装依赖**

```bash
pnpm add adm-zip
pnpm add -D @types/adm-zip
```

- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { importVoiceRuntimeArchive, exportVoiceRuntimeArchive, type ArchiveIO } from './voiceRuntimeArchive'

describe('importVoiceRuntimeArchive', () => {
  it('extractZip 成功 → ok:true', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(async () => {}), createZip: vi.fn() }
    const r = await importVoiceRuntimeArchive({ zipPath: 'a.zip', destDir: 'D:/vr', io })
    expect(r).toEqual({ ok: true })
    expect(io.extractZip).toHaveBeenCalledWith('a.zip', 'D:/vr')
  })

  it('extractZip 失败 → ok:false 带错误信息', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(async () => { throw new Error('压缩包损坏') }), createZip: vi.fn() }
    const r = await importVoiceRuntimeArchive({ zipPath: 'a.zip', destDir: 'D:/vr', io })
    expect(r).toEqual({ ok: false, error: '压缩包损坏' })
  })
})

describe('exportVoiceRuntimeArchive', () => {
  it('createZip 成功 → ok:true', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(), createZip: vi.fn(async () => {}) }
    const r = await exportVoiceRuntimeArchive({ srcDir: 'D:/vr', zipPath: 'out.zip', io })
    expect(r).toEqual({ ok: true })
    expect(io.createZip).toHaveBeenCalledWith('D:/vr', 'out.zip')
  })

  it('createZip 失败 → ok:false 带错误信息', async () => {
    const io: ArchiveIO = { extractZip: vi.fn(), createZip: vi.fn(async () => { throw new Error('磁盘空间不足') }) }
    const r = await exportVoiceRuntimeArchive({ srcDir: 'D:/vr', zipPath: 'out.zip', io })
    expect(r).toEqual({ ok: false, error: '磁盘空间不足' })
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run src/main/voice/voiceRuntimeArchive.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 4: 实现**

```ts
import AdmZip from 'adm-zip'

export interface ArchiveIO {
  extractZip(zipPath: string, destDir: string): Promise<void>
  createZip(srcDir: string, zipPath: string): Promise<void>
}

export async function importVoiceRuntimeArchive(opts: {
  zipPath: string
  destDir: string
  io: ArchiveIO
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await opts.io.extractZip(opts.zipPath, opts.destDir)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export async function exportVoiceRuntimeArchive(opts: {
  srcDir: string
  zipPath: string
  io: ArchiveIO
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await opts.io.createZip(opts.srcDir, opts.zipPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export function createAdmZipArchiveIO(): ArchiveIO {
  return {
    async extractZip(zipPath: string, destDir: string): Promise<void> {
      const zip = new AdmZip(zipPath)
      zip.extractAllTo(destDir, true)
    },
    async createZip(srcDir: string, zipPath: string): Promise<void> {
      const zip = new AdmZip()
      zip.addLocalFolder(srcDir)
      zip.writeZip(zipPath)
    }
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/main/voice/voiceRuntimeArchive.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/voice/voiceRuntimeArchive.ts src/main/voice/voiceRuntimeArchive.test.ts
git commit -m "feat(voice): 运行时压缩包导入导出(adm-zip)"
```

---

## Task 14: IPC 通道与类型(`src/shared/ipc.ts`)

对应设计文档 §2/§5。新增语音相关 IPC 常量、类型、`VoiceApi`,并声明到全局 `Window`。

**Files:**
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Produces: `IPC.VOICE_*` 常量、`VoiceRuntimeState`、`VoiceInstallProgress`、`VoiceArchiveResult`、`VoicePcmChunk`、`VoiceApi`、`Window.voiceApi: VoiceApi`(Task 15/16/19/20 依赖)

这是纯类型改动,没有独立单测(下游任务的接线会验证)。

- [ ] **Step 1: 修改 `src/shared/ipc.ts`**

在 `IPC` 常量对象里,`CONTEXT_SIGNAL: 'context:signal'` 之后追加:

```ts
  VOICE_GET_STATE: 'voice:get-state',
  VOICE_PICK_INSTALL_PATH: 'voice:pick-install-path',
  VOICE_START_INSTALL: 'voice:start-install',
  VOICE_INSTALL_PROGRESS: 'voice:install-progress',
  VOICE_IMPORT_ARCHIVE: 'voice:import-archive',
  VOICE_EXPORT_ARCHIVE: 'voice:export-archive',
  VOICE_AUDIO_CHUNK: 'voice:audio-chunk',
  VOICE_AUDIO_DONE: 'voice:audio-done',
  VOICE_AUDIO_ERROR: 'voice:audio-error',
  VOICE_STOP: 'voice:stop'
```

（记得给上一行 `CONTEXT_SIGNAL: 'context:signal'` 补逗号）

在文件末尾(`BubbleApi`/`declare global` 之前)新增：

```ts
export interface VoiceRuntimeState { installed: boolean; installPath: string; gsvTtsLiteVersion?: string; device?: 'cuda' | 'cpu' }
export interface VoiceInstallProgress { stage: string; message: string }
export interface VoiceArchiveResult { ok: boolean; error?: string }
export interface VoicePcmChunk { audioBase64: string; sampleRate: number }

export interface VoiceApi {
  getState(): Promise<VoiceRuntimeState>
  pickInstallPath(): Promise<string | null>
  startInstall(): void
  onInstallProgress(cb: (p: VoiceInstallProgress) => void): void
  importArchive(): Promise<VoiceArchiveResult>
  exportArchive(): Promise<VoiceArchiveResult>
  onAudioChunk(cb: (c: VoicePcmChunk) => void): void
  onAudioDone(cb: () => void): void
  onAudioError(cb: (message: string) => void): void
  stop(): void
}
```

修改 `declare global` 块,加入 `voiceApi`:

```ts
declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi; voiceApi: VoiceApi }
}
```

- [ ] **Step 2: 编译检查**

Run: `pnpm typecheck`
Expected: 无新增报错(`voiceApi` 尚未被任何地方实现/使用,类型定义本身不会报错)。

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(voice): 新增语音相关 IPC 通道与 VoiceApi 类型"
```

---

## Task 15: 主进程接线(`src/main/shell/index.ts` + 真实传输层)

对应设计文档全篇。这是最大的一个任务:把 Task 9/12/13 的注入式模块接上真实的 `child_process`/`http`/GPU 检测/`dialog`,注册全部 `VOICE_*` IPC handler,并让 sidecar 随应用启动按 active 宠物绑定。

**Files:**
- Create: `src/main/voice/realVoiceTransport.ts`(真实 `spawnProcess`/`postSse`/`InstallStepRunner` 实现,不写 Vitest——纯 I/O 胶水,行为由 Task 8 的手动验证 + 本任务的真机验证覆盖)
- Modify: `src/main/shell/settingsWindow.ts`(`SettingsController` 补 `window()`,与 `DialogController` 的既有 `window(): BrowserWindow | null` 同款写法——安装进度需要推送给设置窗口,当前 `SettingsController` 只有 `open()`,拿不到窗口引用)
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: 全部 Task 1-14 的产出
- Produces: 应用启动时若 `settings.tts.enabled` 且 active 宠物有 `voice` 字段且运行时已安装 → 起 sidecar;新增 IPC handler 对应 Task 14 的全部 `VOICE_*` 常量

- [ ] **Step 1: 给 `SettingsController` 补 `window()`,让安装进度能推送给设置窗口**

修改 `src/main/shell/settingsWindow.ts`:

```ts
export interface SettingsController { open(): void; window(): BrowserWindow | null }
```

在 `return { open(): void {...} }` 里加一个方法(与 `dialogWindow.ts` 的 `window()` 实现完全一致的写法):

```ts
  return {
    open(): void {
      if (!win) win = build()
      win.show()
      win.focus()
    },
    window(): BrowserWindow | null { return win }
  }
```

- [ ] **Step 2: 写 `src/main/voice/realVoiceTransport.ts`**

```ts
import { spawn, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createWriteStream, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createSseParser, type SseFrame } from './sseParser'

const execFileP = promisify(execFileCb)

/** spawn gsv_server.py,监听 stdout 直到看到 "READY" 才算就绪;进程提前退出则拒绝。 */
export function realSpawnProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
  device: 'auto' | 'cuda' | 'cpu'
  useFlashAttn: boolean
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--gpt-model', opts.voice.gptModel,
    '--sovits-model', opts.voice.sovitsModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText
  ]
  if (opts.device !== 'auto') args.push('--device', opts.device)
  if (opts.useFlashAttn) args.push('--use-flash-attn')

  const child = spawn(opts.pythonExe, args, { windowsHide: true })

  return {
    kill(): void { child.kill() },
    waitReady(): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false
        child.stdout?.on('data', (buf: Buffer) => {
          if (!settled && buf.toString('utf-8').includes('READY')) { settled = true; resolve() }
        })
        child.once('exit', (code) => {
          if (!settled) { settled = true; reject(new Error(`语音 sidecar 提前退出(code=${code})`)) }
        })
        child.once('error', (err) => {
          if (!settled) { settled = true; reject(err) }
        })
      })
    }
  }
}

/** 发 POST + 手动解析 text/event-stream 响应体(纯文本协议,不引入 ws 包)。 */
export function realPostSse(port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      const parser = createSseParser()
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { for (const f of parser.push(chunk)) onFrame(f) })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')))
    req.write(payload)
    req.end()
  })
}

export async function realDownloadEmbeddablePython(destDir: string, downloadUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const res = await fetchImpl(downloadUrl)
  if (!res.ok || !res.body) throw new Error(`下载失败:HTTP ${res.status}`)
  const zipPath = join(destDir, 'python-embed.zip')
  // Node 18+ 的 fetch body 是 web ReadableStream,转成 node stream 再落盘
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath))
}

export async function realDetectGpu(): Promise<boolean> {
  try {
    await execFileP('nvidia-smi', [])
    return true
  } catch {
    return false
  }
}

export async function realPipInstall(pythonDir: string, args: string[]): Promise<void> {
  const pythonExe = join(pythonDir, 'python.exe')
  await execFileP(pythonExe, ['-m', 'pip', 'install', ...args], { maxBuffer: 1024 * 1024 * 64 })
}
```

- [ ] **Step 3: 在 `src/main/shell/index.ts` 里接线**

在顶部 import 区新增:

```ts
import { existsSync, writeFileSync } from 'node:fs'
import { createVoiceSidecar } from '../voice/voiceSidecar'
import { createVoiceProvider } from '../voice/voiceProvider'
import { createLlmTranslator } from '../voice/translate'
import { runVoiceRuntimeInstall } from '../voice/voiceRuntimeInstall'
import { importVoiceRuntimeArchive, exportVoiceRuntimeArchive, createAdmZipArchiveIO } from '../voice/voiceRuntimeArchive'
import { parseRuntimeMarker, isRuntimeUsable, serializeRuntimeMarker, VOICE_RUNTIME_MARKER_VERSION } from '../voice/runtimeMarker'
import { realSpawnProcess, realPostSse, realDownloadEmbeddablePython, realDetectGpu, realPipInstall } from '../voice/realVoiceTransport'
import type { VoiceRuntimeState, VoiceInstallProgress, VoiceArchiveResult, VoicePcmChunk } from '@shared/ipc'
```

`join`/`mkdirSync`/`readFileSync` 已在文件顶部原有 import 里存在,不要重复 import——上面这块只新增 `existsSync`/`writeFileSync` 两个此前没有的绑定。

在 `startShell()` 函数体内,`const chat = createChatStore({...})` 定义**之前**插入语音模块初始化(需要 `petDir`、`memory`(实际不需要)、`loadSettings`、已加载的 `petHome`/`loadPet` 结果里的 `voice` 字段——复用已有的 `loadPet(petDir)` 调用点):

```ts
  // ---- 语音(GSV-TTS-Lite)----
  const VOICE_PORT = 8850
  const voiceScriptPath = join(appRoot, 'resources/voice/gsv_server.py')
  const voiceMarkerFile = (installPath: string): string => join(installPath, 'voice-runtime-marker.json')
  const voicePythonExe = (installPath: string): string => join(installPath, 'python.exe')

  function getVoiceRuntimeState(): VoiceRuntimeState {
    const s = loadSettings(settingsFile)
    const installPath = s.tts.runtimeInstallPath
    if (!installPath || !existsSync(voiceMarkerFile(installPath))) return { installed: false, installPath }
    const marker = parseRuntimeMarker(readFileSync(voiceMarkerFile(installPath), 'utf-8'))
    if (!isRuntimeUsable(marker)) return { installed: false, installPath }
    return { installed: true, installPath, gsvTtsLiteVersion: marker!.gsvTtsLiteVersion, device: marker!.device }
  }

  let voiceProviderInstance: ReturnType<typeof createVoiceProvider> | null = null
  let voiceSidecarInstance: ReturnType<typeof createVoiceSidecar> | null = null

  async function startVoiceIfConfigured(): Promise<void> {
    const s = loadSettings(settingsFile)
    if (!s.tts.enabled) return
    const state = getVoiceRuntimeState()
    if (!state.installed) return
    let petVoice: import('@shared/petPackage').PetVoice | undefined
    try {
      petVoice = (await loadPet(petDir)).manifest.voice
    } catch {
      return
    }
    if (!petVoice) return

    const sidecar = createVoiceSidecar({
      port: VOICE_PORT,
      spawnProcess: () => realSpawnProcess({
        pythonExe: voicePythonExe(state.installPath),
        scriptPath: voiceScriptPath,
        port: VOICE_PORT,
        voice: {
          gptModel: join(petDir, petVoice!.gptModel),
          sovitsModel: join(petDir, petVoice!.sovitsModel),
          refAudio: join(petDir, petVoice!.refAudio),
          refText: join(petDir, petVoice!.refText)
        },
        device: s.tts.device,
        useFlashAttn: s.tts.useFlashAttn
      }),
      postSse: realPostSse
    })
    try {
      await sidecar.start()
    } catch (e) {
      console.warn('[voice] sidecar 启动失败,本次运行语音功能不可用', e)
      return
    }
    voiceSidecarInstance = sidecar

    const translatorProvider = createProviderForVoice() // 见下方辅助函数
    voiceProviderInstance = createVoiceProvider({
      sidecar,
      translator: createLlmTranslator(translatorProvider),
      getSettings: () => loadSettings(settingsFile).tts,
      onChunk: (c: VoicePcmChunk) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
      onError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
    })
  }

  function createProviderForVoice() {
    const s = loadSettings(settingsFile)
    const key = secrets.getKey()
    return createProvider(s.provider, key ?? '')
  }

  void startVoiceIfConfigured()
```

> 注:`chat.ts` 内部把 provider 构造函数包在 `opts.makeProvider ?? createProvider` 里、不对外暴露,所以这里不依赖 `chat` 变量,直接单独调用一次 `createProvider`(与 `chat.ts` 用的是同一个函数,只是各自独立调用,避免额外抽象/跨模块共享一个 provider 实例)。在顶部 import 区确认已有 `import { createProvider } from '../providers/createProvider'`(没有则新增)。

在 `chat.ts` 尚未定义前插入以上代码块——由于 `createChatStore` 目前不需要感知语音,Task 17 会再改一次 `chat.ts` 的调用处传入 `voiceProviderInstance`。这里先只保证 sidecar/provider 能被构造出来。

在文件里(`ipcMain.handle(IPC.RELAUNCH_APP, ...)` 附近)新增全部语音 IPC handler:

```ts
  ipcMain.handle(IPC.VOICE_GET_STATE, async () => getVoiceRuntimeState())

  ipcMain.handle(IPC.VOICE_PICK_INSTALL_PATH, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  ipcMain.on(IPC.VOICE_START_INSTALL, () => {
    const s = loadSettings(settingsFile)
    const destDir = s.tts.runtimeInstallPath
    if (!destDir) { petWin.webContents.send(IPC.VOICE_INSTALL_PROGRESS, { stage: 'done', message: '请先选择安装位置' }); return }
    const win = settings.window()
    void runVoiceRuntimeInstall({
      destDir,
      device: s.tts.device,
      steps: {
        downloadEmbeddablePython: (dir) => realDownloadEmbeddablePython(dir, 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'),
        enablePip: async (dir) => { await realPipInstall(dir, ['--upgrade', 'pip']) },
        detectGpu: realDetectGpu,
        installTorch: async (dir, useCuda) => {
          await realPipInstall(dir, useCuda
            ? ['torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128']
            : ['torch', 'torchvision', 'torchaudio'])
        },
        installGsvTtsLite: async (dir) => { await realPipInstall(dir, ['gsv-tts-lite']) },
        warmStartModels: async (dir) => {
          // 起一次 sidecar 触发 gsv_tts 自身的基础模型下载,READY 后立即关闭
          const probe = realSpawnProcess({
            pythonExe: voicePythonExe(dir),
            scriptPath: voiceScriptPath,
            port: VOICE_PORT + 1,
            voice: { gptModel: '__probe__', sovitsModel: '__probe__', refAudio: '__probe__', refText: '__probe__' },
            device: s.tts.device,
            useFlashAttn: false
          })
          try { await probe.waitReady() } finally { probe.kill() }
        }
      },
      onProgress: (p) => { win?.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p); petWin.webContents.send(IPC.VOICE_INSTALL_PROGRESS, p) }
    }).then((r) => {
      if (r.ok) {
        mkdirSync(destDir, { recursive: true })
        writeFileSync(voiceMarkerFile(destDir), serializeRuntimeMarker({ markerVersion: VOICE_RUNTIME_MARKER_VERSION, gsvTtsLiteVersion: '0.4.6', device: s.tts.device === 'cpu' ? 'cpu' : 'cuda' }))
      }
    })
  })

  ipcMain.handle(IPC.VOICE_IMPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.tts.runtimeInstallPath) return { ok: false, error: '请先选择安装位置' }
    const r = await electronDialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: '已取消' }
    return importVoiceRuntimeArchive({ zipPath: r.filePaths[0], destDir: s.tts.runtimeInstallPath, io: createAdmZipArchiveIO() })
  })

  ipcMain.handle(IPC.VOICE_EXPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.tts.runtimeInstallPath) return { ok: false, error: '尚未安装,无法导出' }
    const r = await electronDialog.showSaveDialog({ defaultPath: 'voice-runtime.zip', filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' }
    return exportVoiceRuntimeArchive({ srcDir: s.tts.runtimeInstallPath, zipPath: r.filePath, io: createAdmZipArchiveIO() })
  })

  ipcMain.on(IPC.VOICE_STOP, () => voiceProviderInstance?.stop())
```

- [ ] **Step 4: 应用退出时终止 sidecar**

修改文件末尾的 `app.on('will-quit', ...)`:

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop(); idleWatcher.stop(); void browserControl.close(); voiceSidecarInstance?.stop() })
```

- [ ] **Step 5: `pnpm typecheck` 确认无报错**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 真机冒烟(不苛求 Vitest 覆盖此任务的 Electron 接线)**

Run: `pnpm build && pnpm preview`
Expected: 应用正常启动、无崩溃(此时 `tts.enabled` 默认 `false`,`startVoiceIfConfigured` 应直接跳过、不产生任何副作用)。

- [ ] **Step 7: Commit**

```bash
git add src/main/voice/realVoiceTransport.ts src/main/shell/index.ts src/main/shell/settingsWindow.ts
git commit -m "feat(voice): 主进程接线——真实 sidecar 传输层 + 全部语音 IPC handler"
```

---

## Task 16: Preload 暴露 `voiceApi`(`src/preload/index.ts`)

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `VoiceApi`(Task 14)

- [ ] **Step 1: 查看现有文件里 `bubbleApi`/`todoApi` 的暴露写法,照同样风格新增**

在 `src/preload/index.ts` 里(参照文件里已有的 `contextBridge.exposeInMainWorld('bubbleApi', {...})` 写法)新增:

```ts
contextBridge.exposeInMainWorld('voiceApi', {
  getState: () => ipcRenderer.invoke(IPC.VOICE_GET_STATE),
  pickInstallPath: () => ipcRenderer.invoke(IPC.VOICE_PICK_INSTALL_PATH),
  startInstall: () => ipcRenderer.send(IPC.VOICE_START_INSTALL),
  onInstallProgress: (cb: (p: VoiceInstallProgress) => void) => ipcRenderer.on(IPC.VOICE_INSTALL_PROGRESS, (_e, p) => cb(p)),
  importArchive: () => ipcRenderer.invoke(IPC.VOICE_IMPORT_ARCHIVE),
  exportArchive: () => ipcRenderer.invoke(IPC.VOICE_EXPORT_ARCHIVE),
  onAudioChunk: (cb: (c: VoicePcmChunk) => void) => ipcRenderer.on(IPC.VOICE_AUDIO_CHUNK, (_e, c) => cb(c)),
  onAudioDone: (cb: () => void) => ipcRenderer.on(IPC.VOICE_AUDIO_DONE, () => cb()),
  onAudioError: (cb: (message: string) => void) => ipcRenderer.on(IPC.VOICE_AUDIO_ERROR, (_e, m) => cb(m)),
  stop: () => ipcRenderer.send(IPC.VOICE_STOP)
} satisfies VoiceApi)
```

在顶部 import 区补上类型:

```ts
import type { VoiceApi, VoiceInstallProgress, VoicePcmChunk } from '@shared/ipc'
```

- [ ] **Step 2: `pnpm typecheck` 确认通过**

Run: `pnpm typecheck`
Expected: 通过(`satisfies VoiceApi` 会捕获任何签名不匹配)。

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(voice): preload 暴露 voiceApi"
```

---

## Task 17: `chat.ts` 接线播放触发(batch/stream 两种模式)

对应设计文档 §6。

**Files:**
- Modify: `src/main/shell/chat.ts`
- Modify: `src/main/shell/index.ts`(把 Task 15 构造的 `voiceProviderInstance` 传给 `createChatStore`)
- Test: `src/main/shell/chat.test.ts`(追加)

**Interfaces:**
- Consumes: `VoiceProvider`(Task 11)、`createSentenceSplitter`(Task 5)
- Produces: `createChatStore` 新增可选依赖 `voice?: { getSettings: () => TtsSettings; speak: (text: string) => void; stop: () => void }`

- [ ] **Step 1: 追加失败测试**

在 `src/main/shell/chat.test.ts` 里新增一段:

```ts
describe('语音接线', () => {
  it('batch 模式:回复完整生成后调用一次 voice.speak(完整文本)', async () => {
    const seen: StreamChatRequest[] = []
    const spoken: string[] = []
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    let done: () => void = () => {}
    const finished = new Promise<void>((r) => { done = r })
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => recording(createFakeProvider({ reply: '你好呀' }), seen),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => done(),
      pushError: () => done(),
      openSettings: () => {},
      voice: { getSettings: () => ({ ...settings.tts, playbackTrigger: 'batch' }), speak: (t) => spoken.push(t), stop: () => {} }
    })
    store.handleSend({ text: '你好' })
    await finished
    expect(spoken).toEqual(['你好呀'])
  })

  it('stream 模式:每凑齐一个完整句子就调用一次 voice.speak', async () => {
    const seen: StreamChatRequest[] = []
    const spoken: string[] = []
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    let done: () => void = () => {}
    const finished = new Promise<void>((r) => { done = r })
    const provider = createFakeProvider({ script: [[{ type: 'text', text: '第一句。第二句!' }, { type: 'text', text: '第三句剩余' }, { type: 'done' }]] })
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => recording(provider, seen),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => done(),
      pushError: () => done(),
      openSettings: () => {},
      voice: { getSettings: () => ({ ...settings.tts, playbackTrigger: 'stream' }), speak: (t) => spoken.push(t), stop: () => {} }
    })
    store.handleSend({ text: '你好' })
    await finished
    expect(spoken).toEqual(['第一句。', '第二句!', '第三句剩余'])
  })

  it('取消(cancel)时调用 voice.stop()', () => {
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    const stopped: boolean[] = []
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => createFakeProvider({ reply: 'x', delayMs: 1000 }),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => {},
      pushError: () => {},
      openSettings: () => {},
      voice: { getSettings: () => settings.tts, speak: () => {}, stop: () => stopped.push(true) }
    })
    store.handleSend({ text: '你好' })
    store.cancel()
    expect(stopped).toEqual([true])
  })
})
```

在文件顶部 import 区补:

```ts
import { createSentenceSplitter } from '../voice/sentenceSplitter'
import type { TtsSettings } from '@shared/llm'
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: FAIL(`createChatStore` 尚不接受 `voice` 选项,或行为不符)。

- [ ] **Step 3: 实现——修改 `src/main/shell/chat.ts`**

在 `createChatStore` 的 `opts` 参数类型里新增(紧挨着 `openSettings: () => void` 之后):

```ts
  /** 语音(GSV-TTS-Lite)朗读接线;未注入则该功能整体不存在,与 settings.tts.enabled 无关(同 desktopControl 的注入式惯例) */
  voice?: { getSettings: () => TtsSettings; speak: (text: string) => void; stop: () => void }
```

修改 `cancel` 函数,加入语音打断:

```ts
  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
    opts.voice?.stop()
  }
```

在 `handleSend` 内部,`let acc = ''` 之后新增句子切分器实例:

```ts
      let acc = ''
      const sentenceSplitter = createSentenceSplitter()
```

修改 `onText` 回调,在 `stream` 模式下同步喂给切分器:

```ts
          onText: (t) => {
            acc += t
            opts.pushStream(t)
            if (opts.voice && opts.voice.getSettings().playbackTrigger === 'stream') {
              for (const sentence of sentenceSplitter.push(t)) opts.voice.speak(sentence)
            }
          },
```

在成功路径(`opts.memory.appendMessage({ role: 'pet', text: acc })` 那一支,`else` 分支里)结尾追加:

```ts
        } else {
          opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushDone()
          opts.emitPetEvent('replyDone')
          if (opts.voice) {
            const vs = opts.voice.getSettings()
            if (vs.playbackTrigger === 'batch') opts.voice.speak(acc)
            else {
              const rest = sentenceSplitter.flush()
              if (rest) opts.voice.speak(rest)
            }
          }
        }
```

（原有 `else` 分支内容保留,只是在末尾追加 `if (opts.voice) {...}` 这一段;`res.error` 分支不追加朗读逻辑——出错的部分回复不朗读,维持现状。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: PASS(含此前已有的全部用例)

- [ ] **Step 5: 在 `src/main/shell/index.ts` 里把 Task 15 构造的 `voiceProviderInstance` 传给 `createChatStore`**

修改 `createChatStore({...})` 调用,`openSettings: () => openSettings()` 之后追加:

```ts
    openSettings: () => openSettings(),
    voice: {
      getSettings: () => loadSettings(settingsFile).tts,
      speak: (text) => voiceProviderInstance?.speak(text),
      stop: () => voiceProviderInstance?.stop()
    }
```

- [ ] **Step 6: 全量测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/chat.test.ts src/main/shell/index.ts
git commit -m "feat(voice): chat.ts 接线 batch/stream 两种播放触发 + 取消时打断朗读"
```

---

## Task 18: 播放调度纯逻辑(`src/renderer/voice/playbackScheduler.ts`)

对应设计文档 §2。渲染层用 Web Audio API 播放 PCM 块前,先把"怎么排队保证无缝衔接"的时间计算抽成纯函数(参照 `spritePlayer.ts` 的 `nextFrameIndex` 惯例——纯数学部分测试,真实 canvas/AudioContext 手动验证)。

**Files:**
- Create: `src/renderer/voice/playbackScheduler.ts`
- Test: `src/renderer/voice/playbackScheduler.test.ts`

**Interfaces:**
- Produces: `export interface PlaybackScheduler { scheduleNext(now: number, chunkDurationS: number): number }`、`export function createPlaybackScheduler(): PlaybackScheduler`(Task 19 的 `pcmPlayer.ts` 依赖)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createPlaybackScheduler } from './playbackScheduler'

describe('createPlaybackScheduler', () => {
  it('第一个块:调度到 now 之后(空闲状态)', () => {
    const s = createPlaybackScheduler()
    expect(s.scheduleNext(10, 2)).toBe(10)
  })

  it('第二个块紧跟第一个块结束时间,不管 now 是多少', () => {
    const s = createPlaybackScheduler()
    s.scheduleNext(10, 2) // 占用 [10, 12)
    expect(s.scheduleNext(10.5, 3)).toBe(12) // 即便 now=10.5,也要等前一块播完
  })

  it('如果 now 已经超过前一块结束时间(播放卡顿追上了),从 now 重新开始,不留空档倒退', () => {
    const s = createPlaybackScheduler()
    s.scheduleNext(10, 1) // 占用 [10, 11)
    expect(s.scheduleNext(15, 2)).toBe(15) // now(15) 远超上次结束(11),从 now 重新排
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/renderer/voice/playbackScheduler.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
export interface PlaybackScheduler {
  /** 给定当前时刻与本块时长,返回本块应该开始播放的时刻,保证与前一块无缝衔接(不重叠、不留空档)。 */
  scheduleNext(now: number, chunkDurationS: number): number
}

export function createPlaybackScheduler(): PlaybackScheduler {
  let nextStart = 0
  return {
    scheduleNext(now: number, chunkDurationS: number): number {
      const startAt = Math.max(now, nextStart)
      nextStart = startAt + chunkDurationS
      return startAt
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/renderer/voice/playbackScheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/voice/playbackScheduler.ts src/renderer/voice/playbackScheduler.test.ts
git commit -m "feat(voice): 渲染层无缝播放调度的纯逻辑"
```

---

## Task 19: 渲染层 PCM 播放器(`src/renderer/voice/pcmPlayer.ts`)+ `main.ts` 接线

对应设计文档 §2。用 Web Audio API 播放 float32 单声道 PCM;真实播放行为由 `pnpm dev`/`preview` 真机验证(Web Audio API 在 Vitest/jsdom 环境下不可用,同项目里 `imagePrep.ts`/`screenCapture.ts` 等 native 模块的既有惯例)。

**Files:**
- Create: `src/renderer/voice/pcmPlayer.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `createPlaybackScheduler`(Task 18)、`window.voiceApi`(Task 16)
- Produces: `export function createPcmPlayer(): { play(audioBase64: string, sampleRate: number): void; stop(): void }`

- [ ] **Step 1: 实现 `pcmPlayer.ts`**

```ts
import { createPlaybackScheduler } from './playbackScheduler'

export interface PcmPlayer {
  /** 解码一段 base64 float32 PCM 并排队播放,与之前的块无缝衔接。 */
  play(audioBase64: string, sampleRate: number): void
  /** 立即停止所有已排队/正在播放的音频。 */
  stop(): void
}

export function createPcmPlayer(): PcmPlayer {
  const ctx = new AudioContext()
  const scheduler = createPlaybackScheduler()
  let sources: AudioBufferSourceNode[] = []

  function decode(audioBase64: string, sampleRate: number): AudioBuffer {
    const raw = atob(audioBase64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const floats = new Float32Array(bytes.buffer)
    const buffer = ctx.createBuffer(1, floats.length, sampleRate)
    buffer.copyToChannel(floats, 0)
    return buffer
  }

  return {
    play(audioBase64: string, sampleRate: number): void {
      const buffer = decode(audioBase64, sampleRate)
      const startAt = scheduler.scheduleNext(ctx.currentTime, buffer.duration)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(startAt)
      sources.push(src)
      src.onended = () => { sources = sources.filter((s) => s !== src) }
    },
    stop(): void {
      for (const s of sources) { try { s.stop() } catch { /* 已经播完的节点 stop() 会抛,忽略 */ } }
      sources = []
    }
  }
}
```

- [ ] **Step 2: 在 `src/renderer/main.ts` 里接线**

查看 `main.ts` 现有结构(启动加载宠物 + 播 idle + `petApi.onPetEvent` 等注册点),在同一区域新增:

```ts
import { createPcmPlayer } from './voice/pcmPlayer'

const pcmPlayer = createPcmPlayer()
window.voiceApi.onAudioChunk((c) => pcmPlayer.play(c.audioBase64, c.sampleRate))
window.voiceApi.onAudioError((message) => console.warn('[voice]', message))
```

在既有的"新消息发送即打断朗读"处(参照 `emitPetEvent('messageSent')` 对应的渲染层清理逻辑,若 `main.ts` 里没有直接监听这个事件,就在 `chatApi`/`petApi` 已有的取消交互点,如发送新消息或用户手动取消按钮的处理函数里)追加 `pcmPlayer.stop()`——具体插入位置以 `main.ts` 当前处理"新消息取消"逻辑的函数为准,保持一次 `stop()` 调用即可,不重复监听。

- [ ] **Step 3: 真机验证**

Run: `pnpm build && pnpm preview`
Expected: 应用正常启动无崩溃(此时 `tts.enabled` 仍为默认 `false`,不会真的收到音频块;这一步只验证接线不报错,真实出声验证留到 Task 22 之后的整体真机验收)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/voice/pcmPlayer.ts src/renderer/main.ts
git commit -m "feat(voice): 渲染层 Web Audio PCM 播放器接线"
```

---

## Task 20: 设置窗口「语音」页(`src/renderer/settings.ts` + `settings.html`)

对应设计文档 §3/§5。运行时安装位置选择 + 安装/导入/导出按钮 + 进度展示 + 开关/设备/FlashAttn/目标语言/播放触发/切分方式下拉 + 生成参数面板(对应截图)。这是纯 UI 接线任务,不写 Vitest(与项目里其余设置页新增惯例一致),用 `pnpm dev` 真机走查。

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `window.voiceApi`(Task 16)、`window.settingsApi.getSettings()/setSettings()`(既有,新增的 `tts` 字段已经在 `AppSettings` 里,不需要新增 IPC)

- [ ] **Step 1: 查看现有 `settings.html`/`settings.ts` 的分节结构**

先读一遍现有文件,确认既有分节(如"搜索"/"工具能力")用的是什么 HTML 结构模式(`<section>` + `<h3>` + 表单控件 + JS 里的 `getElementById`/事件绑定),新增内容严格照抄这个模式,不引入新的 CSS 框架/结构范式。

- [ ] **Step 2: 在 `settings.html` 里新增「语音」分节**

在既有最后一个分节(工具能力/桌面控制等,以现有文件实际顺序为准)之后追加一个新 `<section>`,内容包括:

- 运行时状态展示(只读文本,如"未安装"/"已安装 · 0.4.6 · cuda") + "选择安装位置"按钮(触发 `voiceApi.pickInstallPath()`,回填一个只读输入框) + "现场安装"按钮 + 一段可展开的进度日志区域(`<pre>` 或类似) + "导入压缩包"/"导出压缩包"两个按钮。
- 开关:`启用配音`(checkbox)。
- 下拉:`设备`(auto/cuda/cpu)、`Flash Attention`(checkbox,旁边一行小字注明需自行满足 README 的 Windows wheel 安装前提)、`目标朗读语言`(auto/zh/ja/en)、`播放触发方式`(batch/stream)、`合成切分方式`(token/sentence)。
- 可折叠的"生成参数"面板(默认折叠,点击展开),内含滑杆/输入框:语速(speed)、噪声比例(noiseScale)、温度(temperature)、Top K(topK)、Top P(topP)、重复惩罚(repetitionPenalty)、是否切分文本(isCutText,checkbox)、最小切分长度(cutMinLen)、切分静音时长(cutMute)——每个控件的取值范围参照设计文档 §5 表格与用户提供的截图(speed/noiseScale/temperature/topP:0.1-2 或 0.1-1 步进 0.1;topK:1-50 整数;repetitionPenalty:1-2;cutMinLen:整数;cutMute:0-2 步进 0.1)。

- [ ] **Step 3: 在 `settings.ts` 里接线**

- 页面加载时:`voiceApi.getState()` 填充运行时状态只读文本;`settingsApi.getSettings()` 里的 `settings.tts` 回填全部控件初始值(照抄现有分节"回填"写法)。
- "选择安装位置"按钮:`onclick` 调 `voiceApi.pickInstallPath()`,拿到路径后写回本地一个 `currentTts.runtimeInstallPath` 状态变量(不立即调 `setSettings`,和其余设置项一样等用户点总的"保存"按钮时一并提交——查看现有 Save 按钮的处理函数,把 `tts` 整个对象加进它组装的 `AppSettings` 里,复用 Task 3 已确认的字段名)。
- "现场安装"按钮:`onclick` 先确认 `runtimeInstallPath` 非空(否则提示"请先选择安装位置"),调 `voiceApi.startInstall()`;`voiceApi.onInstallProgress(cb)` 把每次进度追加到日志区域文本末尾。
- "导入压缩包"/"导出压缩包"按钮:`onclick` 分别调 `voiceApi.importArchive()`/`voiceApi.exportArchive()`,返回后按 `ok` 展示成功或错误提示(参照现有"测试连接"按钮的成功/失败提示写法)。
- 全部开关/下拉/数值控件:变更时更新本地状态对象,交给现有 Save 流程一并写入 `setSettings`。

- [ ] **Step 4: 真机走查**

Run: `pnpm dev`(或 `pnpm build && pnpm preview`),打开设置窗口。
Expected:
- 「语音」分节可见,各控件能正常展示/折叠。
- 点"选择安装位置"能弹出真实文件夹选择框。
- 保存后重新打开设置窗口,各项配置(含生成参数面板里的数值)原样保留。
- 由于运行时尚未真正安装,"现场安装"点击后应看到进度日志开始滚动(即便最终因为真实网络/pip 环境因素成功与否未知,至少不能整个应用卡死或崩溃)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(voice): 设置窗口新增「语音」页(运行时安装/导入导出 + 开关 + 生成参数)"
```

---

## Task 21: 宠物包资产落地(`pets/alice/voice/`)

对应设计文档 §4。把仓库根 `Reference/*` 与 `E:\GST\...` 的模型文件挪进 `pets/alice/voice/`,更新 `pets/alice/pet.json` 与 README。这一步涉及用户机器上的真实大文件,由用户手动确认路径,agent 负责编辑 `pet.json`/README 与给出复制命令。

**Files:**
- Modify: `pets/alice/pet.json`
- Modify: `pets/alice/README.md`
- (用户在磁盘上手动执行)把大文件放进 `pets/alice/voice/`

- [ ] **Step 1: 给用户提供复制命令(agent 执行前先确认路径仍然有效)**

```bash
cp "Reference/ailisi_4.wav" "pets/alice/voice/ailisi_4.wav"
cp "Reference/Alice_reference_content.txt" "pets/alice/voice/ailisi_4.txt"
cp "/e/GST/GPT-SoVITS-v2pro-20250604/GPT_weights_v2Pro/Alice_v2pro-e15.ckpt" "pets/alice/voice/Alice_v2pro-e15.ckpt"
cp "/e/GST/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2Pro/Alice_v2pro_e8_s1032.pth" "pets/alice/voice/Alice_v2pro_e8_s1032.pth"
```

(Windows 路径在 Git Bash 下用 `/e/...` 形式;若在 PowerShell 里执行,改用 `Copy-Item` 与原始 `E:\...` 路径。大文件复制可能耗时较久,尤其是模型文件。)

- [ ] **Step 2: 修改 `pets/alice/pet.json`**

在 JSON 顶层(`animations` 块之后)新增:

```json
  "voice": {
    "gptModel": "voice/Alice_v2pro-e15.ckpt",
    "sovitsModel": "voice/Alice_v2pro_e8_s1032.pth",
    "refAudio": "voice/ailisi_4.wav",
    "refText": "voice/ailisi_4.txt"
  }
```

- [ ] **Step 3: 用 Task 1 的 `parsePetManifest` 手动验证解析不报错**

Run: `pnpm vitest run src/shared/petPackage.test.ts`(确认既有测试仍然通过,不因为改了真实 `pets/alice/pet.json` 而受影响——这个文件本身不在 Vitest 覆盖范围内,这一步只是保险检查改动没有破坏共享逻辑)

也可以手写一次性验证脚本确认真实文件能解析(跑完即删,不提交):

```bash
node -e "const {parsePetManifest}=require('./src/shared/petPackage.ts'); console.log('ok')" 2>/dev/null || echo "(仅 TS,通过 pnpm build 阶段的 petLoader 单测间接覆盖即可,不必强行跑这条)"
```

- [ ] **Step 4: 更新 `pets/alice/README.md` 的「6. 角色语言」小节**

在 README 现有的 "### 6.2 配音 `voice/`" 段落里,补充说明现在有了真实 TTS 配置(而不只是预录占位),例如追加一段:

```markdown
### 6.3 TTS 配音(GSV-TTS-Lite)

`pet.json` 的 `voice` 字段绑定了本宠物专属的 GPT/SoVITS 模型与参考音频/文本(`voice/` 目录下),
供 VoiceProvider 的 `tts` 档使用——见设计文档 `docs/superpowers/specs/2026-07-09-gsv-tts-lite-voice-integration-design.md`。
模型来源:基于 GPT-SoVITS v2Pro 微调,推理引擎为开源项目
[GSV-TTS-Lite](https://github.com/chinokikiss/GSV-TTS-Lite)。
```

- [ ] **Step 5: 核对 `.gitignore` 是否已把 `pets/alice` 整个目录当作磁盘化宠物包处理**

**执行期间发现的计划纠错**(原计划这一步曾写"commit pet.json/README.md",是错的):`pets/alice` 与
`pets/luluka`/`youka`/`shiraishi-mio`/`juwang` 同等对待——整个宠物包目录磁盘化、不入库(见
`.gitignore` 里那几行既有条目),`pet.json`/`README.md` 也不例外,不要单独把它们从整包忽略规则里
摘出来 commit。

检查 `.gitignore` 是否已有 `pets/alice` 一行(以及 `Reference` 一行,因为参考音频/文本的暂存副本
`Reference/` 也不该入库)。如果没有,补上:

```gitignore
Reference
pets/alice
```

`git status --short` 确认此时 `pets/alice/*`(含刚编辑的 `pet.json`/`README.md` 与刚拷入的模型文件)
不再出现在待暂存列表里,只有 `.gitignore` 自身显示为改动。

- [ ] **Step 6: Commit(仅 `.gitignore`)**

```bash
git add .gitignore
git commit -m "chore(voice): .gitignore 补 Reference/ 与 pets/alice(随宠物包磁盘化处理)"
```

`pets/alice/pet.json`/`README.md`/`voice/*` 均不进这次或任何一次 commit——它们是磁盘化宠物包的一部分,
与 `pets/luluka` 的处理方式完全一致。

---

## Task 22: 打包核对 + 全量回归

对应设计文档 §4/§7。核对 `resources/voice/gsv_server.py` 会随现有 `extraResources` 规则(`electron-builder.yml` 里 `from: resources, to: resources`)自动打进安装包,不需要新增打包配置;跑一次全量测试/typecheck/build 收尾。

**Files:**
- (无代码改动,仅核对 + 验证)

- [ ] **Step 1: 核对 `electron-builder.yml` 的既有 `extraResources` 规则覆盖到新文件**

打开 `electron-builder.yml`,确认 `extraResources` 列表里已有:

```yaml
extraResources:
  - from: resources
    to: resources
```

这条规则会把整个 `resources/` 目录(含新增的 `resources/voice/gsv_server.py`)原样复制进打包产物的 `resources/resources/`?——**注意核对实际落地路径**:现有代码里 `join(appRoot, 'resources/tray.png')` 说明 `appRoot` 打包后就是 `process.resourcesPath`,而这条 `extraResources` 规则是 `from: resources, to: resources`,意味着打包后的路径是 `process.resourcesPath/resources/tray.png`——与 Task 15 里 `join(appRoot, 'resources/voice/gsv_server.py')` 的写法一致,不需要改动 `electron-builder.yml`。跑一次 `pnpm dist`(若用户环境允许,见 README「打包构建说明」的 winCodeSign 坑)后解压产物确认 `resources/resources/voice/gsv_server.py` 确实存在,不需要则跳过、留给真机验收阶段一并做。

- [ ] **Step 2: 核对 `pets` 的 `extraResources` 规则会不会因为 alice 的语音大文件显著增大安装包**

`electron-builder.yml` 里 `from: pets, to: pets` 目前只过滤 `!**/memory/**`,意味着 `pets/alice/voice/*.ckpt`/`*.pth` 这些大文件会被每次打包一起带上——这是既有"每个宠物包资产都随包分发"惯例的自然延伸(同 `pets/luluka` 的精灵图),**不是本次需要修的 bug**,只是提醒:若后续用户觉得安装包因此过大,可以在 `filter` 里加一条 `!**/voice/*.ckpt` / `!**/voice/*.pth` 之类的排除规则,把语音模型改成运行时按需从别处加载——这属于设计文档 §9 遗留项,本任务不处理,只记录在这里避免遗忘。

- [ ] **Step 3: 全量回归**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全部通过,三个产物(main/preload/renderer)构建成功。

- [ ] **Step 4: `pnpm preview` 冒烟**

Run: `pnpm preview`
Expected: 应用正常启动,无崩溃、无控制台报错。默认 `tts.enabled=false`,语音相关代码路径不应产生任何可见副作用。

- [ ] **Step 5: Commit(若 Step 1/2 的核对导致 `electron-builder.yml` 有改动才提交;否则跳过此步)**

```bash
git add electron-builder.yml
git commit -m "chore(voice): 核对语音资源打包路径"
```

---

## 真机验收清单(不是代码任务,留给用户在真实机器上走查)

对应设计文档 §8。以下需要真实 GPU/网络/GSV-TTS-Lite 环境,不在本计划的自动化任务范围内:

- 现场安装全流程(下载 embeddable Python → pip 装 torch/gsv-tts-lite → 基础模型预热)真的能跑完,进度文案与实际耗时匹配。
- 导入/导出运行时压缩包:导出一份、在另一个安装位置导入,确认能正常识别为"已安装"。
- 中文/日语/英语/中英混合/日英混合五种朗读文本,确认发音正确、无异常卡顿。
- `targetLanguage` 设为非 auto 时确实触发翻译(且已经是目标语言时确实跳过翻译,省下一次 LLM 调用延迟)。
- `playbackTrigger=batch` 与 `stream` 两种手感对比(尤其 stream 模式下确认不会复现上次"逐 token 喂给 TTS"的卡顿——这次是按完整句子边界喂,不是按 token)。
- `synthesisChunking=token` 与 `sentence` 两种切分方式的实际听感差异。
- Flash Attention 开启后确实生效(对照设计文档引用的 README 性能对比数据,首包延迟应明显下降)。
- v2ProPlus 模型(而不只是本次用的 v2Pro)可以正常加载与推理。
- 断网/GPU 驱动缺失时,"现场安装"步骤的报错文案是否清晰可读。
- 应用退出/切换宠物(触发重启)时 sidecar 进程被正确终止,不留孤儿进程。
- 新消息发送/手动取消时,正在播放的语音确实被打断,不会与新回复的语音重叠。
