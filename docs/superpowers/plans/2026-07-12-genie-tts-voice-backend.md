# Genie-TTS 第二语音后端接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Genie-TTS(ONNX Runtime 推理,不需要 torch)作为第二个可选 TTS 后端,与现有 GSV-TTS-Lite
并存、独立安装/卸载、按宠物包(`voice.onnxModel` vs `voice.gptModel`/`sovitsModel`)自动选择,解决
GSV-TTS-Lite 运行时体积大(几个 G)的问题,并把 `pets/alice` 转换为端到端验收用例。

**Architecture:** 复用现有 SSE 上层管线(`voiceProvider`/`sentenceSplitter`/`speechSequencer`/
`translate`/`sseParser`/渲染层 `pcmPlayer`)完全不动,只新增一个后端专属的 sidecar Python 脚本
(`resources/voice/genie_server.py`)和一套独立的、更简单的运行时安装编排(`genieRuntimeInstall.ts`),
两套后端的运行时安装位置/安装状态/导入导出压缩包各自独立管理。设置数据结构选择**加法式扩展**——不改
动现有 `AppSettings.tts`(GSV 专属字段原样保留),新增一个平级的 `AppSettings.ttsGenie` 字段,这比
把两套后端字段嵌套进同一个 `tts` 对象里改动面小得多,且完全不触碰任何现有测试断言的 `tts.*` 字段名。

**Tech Stack:** TypeScript(Electron 主进程/渲染层)、Python 3.10+(`genie-tts` PyPI 包,ONNX Runtime
CPU 推理)、Vitest。

## Global Constraints

- 不要给 `package.json` 加 `"type": "module"`(CLAUDE.md 明确禁止,会导致 Electron 主进程崩溃)。
- 每个改动 TS 文件的任务都要跑 `pnpm typecheck` 和相关 Vitest,确认通过再提交。
- Genie-TTS 后端只用 CPU,不做 GPU/CUDA 检测(设计文档 §1 非目标)。
- Genie-TTS 后端不暴露 speed/noiseScale/temperature/topK/topP/repetitionPenalty 生成参数(它的
  Python API 根本不支持这些)。
- `genie_tts` 包在 `import` 时,如果它认为的资源目录(`./GenieData`,相对于进程 **cwd**)不存在,会
  同步执行阻塞的 `input()` 交互式 prompt,在无 TTY 的子进程里会抛 `EOFError` 崩溃退出——任何 spawn
  `genie_server.py`(不论是 `--download-data` 模式还是正常服务模式)之前,Node 侧必须先
  `mkdirSync(join(destDir, 'GenieData'), { recursive: true })`,并且 spawn 时必须把 `cwd` 设成
  `destDir`(`genie_tts.download_genie_data()` 内部用 `snapshot_download(local_dir=".")`,永远下载到
  "当前工作目录/GenieData",不读 `GENIE_DATA_DIR` 环境变量——这是本计划在设计文档 §3.1 基础上,读源码
  (`Core/Resources.py`)后修正的更精确结论)。同时也要设置 `GENIE_DATA_DIR` 环境变量指向同一个绝对
  路径,双重保险,避免依赖"永远等于 cwd 拼接"这一个单点假设。
- `genie_tts.load_character()`/`set_reference_audio()` 的 `language` 参数直接接受小写 `'zh'`/
  `'ja'`/`'en'`(`Utils/Language.py` 的 `normalize_language()` 内置了这个映射),不需要额外转换。

---

## 参考:Genie-TTS 本地源码

用户已把仓库克隆到 `D:\LProject\claude_Project\Genie-TTS`(`src/genie_tts/` 下)。以下文件是本计划
代码依据的原始出处,任务执行者如遇到本计划未覆盖的细节,应优先去读这些文件而不是猜测:
- `src/genie_tts/Internal.py`——`load_character`/`set_reference_audio`/`tts_async`/`tts`/
  `convert_to_onnx` 的公开签名与 docstring。
- `src/genie_tts/Core/TTSPlayer.py`——`tts_async` 内部回调给的音频块格式(16-bit PCM int16,
  `sample_rate=32000`,单声道)。
- `src/genie_tts/Core/Resources.py`——`GENIE_DATA_DIR`/`download_genie_data`/模块级交互式 prompt。
- `src/genie_tts/Utils/Language.py`——`normalize_language` 接受的字符串。

---

### Task 1: `PetVoice` 类型扩展(共享层)

**Files:**
- Modify: `src/shared/petPackage.ts:3` (interface), `src/shared/petPackage.ts:45-51` (validation in `parsePetManifest`)
- Test: `src/shared/petPackage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PetVoice {
    refAudio: string; refText: string
    gptModel?: string; sovitsModel?: string
    onnxModel?: string
    /** Genie-TTS 后端专用:该角色模型/参考音频本身的语言,load_character 需要;GSV-TTS-Lite 后端不用这个字段(它按请求自动检测/强制)。onnxModel 存在时必填。 */
    language?: 'zh' | 'ja' | 'en'
  }
  ```

- [ ] **Step 1: 写失败的测试(追加到 `src/shared/petPackage.test.ts` 的 `parsePetManifest voice 字段(可选)` describe 块末尾)**

```ts
  it('只提供 onnxModel(Genie-TTS 后端)→ 解析成功,原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' }
    })
    expect(m.voice).toEqual({ onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' })
  })

  it('gptModel/sovitsModel 与 onnxModel 都提供 → 都保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: {
        gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', onnxModel: 'voice/a-onnx',
        refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja'
      }
    })
    expect(m.voice?.onnxModel).toBe('voice/a-onnx')
    expect(m.voice?.gptModel).toBe('voice/a.ckpt')
  })

  it('既没有 onnxModel 也没有 gptModel/sovitsModel → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/onnxModel|gptModel/)
  })

  it('只给 gptModel 不给 sovitsModel(反之亦然)→ 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
    expect(() => parsePetManifest({
      ...base,
      voice: { sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })

  it('onnxModel 存在但 language 缺失/非法 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/language/)
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'fr' }
    })).toThrow(/language/)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: 新增的用例 FAIL(现有校验逻辑不认识 `onnxModel`/`language`,且旧逻辑强制要求
`gptModel`/`sovitsModel` 必填,会在"只提供 onnxModel"用例上抛错导致测试失败)。

- [ ] **Step 3: 实现**

把 `src/shared/petPackage.ts` 第 3 行:
```ts
export interface PetVoice { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
```
改成:
```ts
export interface PetVoice {
  refAudio: string; refText: string
  gptModel?: string; sovitsModel?: string
  onnxModel?: string
  language?: 'zh' | 'ja' | 'en'
}
```

把第 45-51 行的校验块:
```ts
  if (m.voice !== undefined) {
    const v = m.voice
    assert(v && typeof v === 'object', 'manifest.voice must be an object when present')
    for (const k of ['gptModel', 'sovitsModel', 'refAudio', 'refText']) {
      assert(typeof v[k] === 'string' && v[k].length > 0, `manifest.voice.${k} must be a non-empty string`)
    }
  }
```
改成:
```ts
  if (m.voice !== undefined) {
    const v = m.voice
    assert(v && typeof v === 'object', 'manifest.voice must be an object when present')
    for (const k of ['refAudio', 'refText']) {
      assert(typeof v[k] === 'string' && v[k].length > 0, `manifest.voice.${k} must be a non-empty string`)
    }
    const hasGpt = typeof v.gptModel === 'string' && v.gptModel.length > 0
    const hasSovits = typeof v.sovitsModel === 'string' && v.sovitsModel.length > 0
    assert(hasGpt === hasSovits, 'manifest.voice.gptModel and sovitsModel must both be present or both be absent')
    const hasOnnx = typeof v.onnxModel === 'string' && v.onnxModel.length > 0
    assert(hasGpt || hasOnnx, 'manifest.voice must provide either onnxModel or both gptModel/sovitsModel')
    if (hasOnnx) {
      assert(v.language === 'zh' || v.language === 'ja' || v.language === 'en', 'manifest.voice.language must be zh/ja/en when onnxModel is present')
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: 全部 PASS(含之前已有的用例——注意现有"完整 voice 字段"用例传的是
`{ gptModel, sovitsModel, refAudio, refText }` 不含 `language`,新校验逻辑下 `hasOnnx=false` 时不会
检查 `language`,应仍然通过)。

- [ ] **Step 5: Commit**

```bash
git add src/shared/petPackage.ts src/shared/petPackage.test.ts
git commit -m "feat(voice): PetVoice 支持 onnxModel(Genie-TTS 后端)字段"
```

---

### Task 2: `AppSettings.ttsGenie` 字段

**Files:**
- Modify: `src/shared/llm.ts:60-117` (add `GenieTtsSettings` + `DEFAULT_GENIE_TTS_SETTINGS`, extend `AppSettings`/`DEFAULT_SETTINGS`, bump `SETTINGS_SCHEMA_VERSION`)
- Modify: `src/main/config/settings.ts` (normalize `ttsGenie`)
- Test: `src/main/config/settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GenieTtsSettings { runtimeInstallPath: string }
  export const DEFAULT_GENIE_TTS_SETTINGS: GenieTtsSettings
  // AppSettings 新增字段: ttsGenie: GenieTtsSettings
  ```

- [ ] **Step 1: 写失败的测试**

在 `src/main/config/settings.test.ts` 的 `describe('settings', ...)` 块内,`round-trips save then load`
测试后面新增一个 describe:

```ts
describe('ttsGenie', () => {
  it('缺省 → 默认 runtimeInstallPath 空字符串', () => {
    const f = tmpSettingsFile({ schemaVersion: 11, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: '' })
  })
  it('保留合法的 runtimeInstallPath', () => {
    const f = tmpSettingsFile({ ttsGenie: { runtimeInstallPath: 'D:/genie-runtime' } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: 'D:/genie-runtime' })
  })
  it('runtimeInstallPath 非字符串 → 回退空字符串', () => {
    const f = tmpSettingsFile({ ttsGenie: { runtimeInstallPath: 123 } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: '' })
  })
  it('归一化后 schemaVersion 升为 12', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(12)
  })
})
```

再把已有两处硬编码的 `toBe(11)` 断言(第 66 行 `describe('activePetId', ...)` 和第 94 行
`describe('browserControl', ...)` 里各一处 `归一化后 schemaVersion 升为 8` 用例——名字虽然写的是 8,
断言的其实已经是 11,是历史遗留的名字没跟着改)改成 `toBe(12)`,并把它们的 `it(...)` 标题里的数字也
同步改成 12,避免继续挂错数字的名字:
```ts
  it('归一化后 schemaVersion 升为 12', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(12)
  })
```
(两处都改,一处在 `activePetId` describe 里,一处在 `browserControl` describe 里)

再把 `round-trips save then load` 测试(第 24-29 行)里的字面量对象加上 `ttsGenie`:
```ts
  it('round-trips save then load', () => {
    const file = join(tmp(), 'settings.json')
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, tts: DEFAULT_SETTINGS.tts, ttsGenie: DEFAULT_SETTINGS.ttsGenie }
    saveSettings(file, s)
    expect(loadSettings(file)).toEqual(s)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: 新增/改动的用例 FAIL(`AppSettings` 还没有 `ttsGenie` 字段,`round-trips` 用例因为字面量对象
比 `AppSettings` 多一个 TS 不认识的字段——如果先改测试文件再改类型,`pnpm vitest` 在 esbuild-transform
下不会做类型检查,运行时会因为 `loadSettings(file)` 归一化后不含 `ttsGenie` 而 `toEqual` 失败;后续
`pnpm typecheck` 一步会额外验证类型层面的一致性)。

- [ ] **Step 3: 实现**

`src/shared/llm.ts`——在 `TtsSettings` 定义之后(第 79 行 `}` 后面)新增:
```ts
export interface GenieTtsSettings { runtimeInstallPath: string }

export const DEFAULT_GENIE_TTS_SETTINGS: GenieTtsSettings = {
  runtimeInstallPath: ''
}
```

把 `SETTINGS_SCHEMA_VERSION = 11` 改成 `SETTINGS_SCHEMA_VERSION = 12`。

把 `AppSettings` 接口(第 103 行)结尾加上 `; ttsGenie: GenieTtsSettings`:
```ts
export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; appFocusLlmOpener: AppFocusLlmOpenerSettings; tts: TtsSettings; ttsGenie: GenieTtsSettings }
```

`DEFAULT_SETTINGS`(第 105-117 行)加上一行:
```ts
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS
```

`src/main/config/settings.ts`——在 `normalizeSettings` 函数里,`tts` 归一化块(第 56-75 行)之后新增:
```ts
  const tg = (r.ttsGenie ?? {}) as Record<string, unknown>
  const ttsGenie = {
    runtimeInstallPath: typeof tg.runtimeInstallPath === 'string' ? tg.runtimeInstallPath : DEFAULT_SETTINGS.ttsGenie.runtimeInstallPath
  }
```
返回对象(第 76-88 行)加上 `ttsGenie`:
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
    tts,
    ttsGenie
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: 全部 PASS

Run: `pnpm typecheck`
Expected: 无新增类型错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts
git commit -m "feat(voice): AppSettings 新增 ttsGenie 字段(Genie-TTS 独立运行时安装位置)"
```

---

### Task 3: `genieRuntimeMarker.ts`

**Files:**
- Create: `src/main/voice/genieRuntimeMarker.ts`
- Test: `src/main/voice/genieRuntimeMarker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GENIE_RUNTIME_MARKER_VERSION: number
  export interface GenieRuntimeMarker { markerVersion: number; genieTtsVersion: string }
  export function parseGenieRuntimeMarker(raw: string): GenieRuntimeMarker | null
  export function isGenieRuntimeUsable(marker: GenieRuntimeMarker | null): boolean
  export function serializeGenieRuntimeMarker(m: GenieRuntimeMarker): string
  ```

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseGenieRuntimeMarker, isGenieRuntimeUsable, serializeGenieRuntimeMarker, GENIE_RUNTIME_MARKER_VERSION } from './genieRuntimeMarker'

describe('genieRuntimeMarker', () => {
  it('序列化再解析,内容不变', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }
    expect(parseGenieRuntimeMarker(serializeGenieRuntimeMarker(m))).toEqual(m)
  })
  it('非法 JSON → 返回 null', () => {
    expect(parseGenieRuntimeMarker('{ not json')).toBeNull()
  })
  it('缺 genieTtsVersion → 返回 null', () => {
    expect(parseGenieRuntimeMarker(JSON.stringify({ markerVersion: 1 }))).toBeNull()
  })
  it('markerVersion 与当前版本不符 → isGenieRuntimeUsable 为 false', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION + 1, genieTtsVersion: '2.0.2' }
    expect(isGenieRuntimeUsable(m)).toBe(false)
  })
  it('null → isGenieRuntimeUsable 为 false', () => {
    expect(isGenieRuntimeUsable(null)).toBe(false)
  })
  it('版本匹配 → isGenieRuntimeUsable 为 true', () => {
    const m = { markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }
    expect(isGenieRuntimeUsable(m)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/genieRuntimeMarker.test.ts`
Expected: FAIL(`./genieRuntimeMarker` 模块不存在)

- [ ] **Step 3: 实现**

```ts
export const GENIE_RUNTIME_MARKER_VERSION = 1

export interface GenieRuntimeMarker {
  markerVersion: number
  genieTtsVersion: string
}

export function parseGenieRuntimeMarker(raw: string): GenieRuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.genieTtsVersion !== 'string') return null
    return { markerVersion: j.markerVersion, genieTtsVersion: j.genieTtsVersion }
  } catch {
    return null
  }
}

export function isGenieRuntimeUsable(marker: GenieRuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === GENIE_RUNTIME_MARKER_VERSION
}

export function serializeGenieRuntimeMarker(m: GenieRuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/genieRuntimeMarker.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/genieRuntimeMarker.ts src/main/voice/genieRuntimeMarker.test.ts
git commit -m "feat(voice): Genie-TTS 运行时安装标记文件解析/校验"
```

---

### Task 4: `genieRuntimeInstall.ts` 安装编排

**Files:**
- Create: `src/main/voice/genieRuntimeInstall.ts`
- Test: `src/main/voice/genieRuntimeInstall.test.ts`

**Interfaces:**
- Consumes: 无(纯函数 + 依赖注入,不依赖 Task 5 的真实实现)
- Produces:
  ```ts
  export type GenieInstallStage = 'download-python' | 'enable-pip' | 'install-genie-tts' | 'download-genie-data' | 'done'
  export interface GenieInstallProgress { stage: GenieInstallStage; message: string }
  export interface GenieInstallStepRunner {
    downloadEmbeddablePython(destDir: string): Promise<void>
    enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
    installGenieTts(destDir: string, onProgress: (message: string) => void): Promise<void>
    downloadGenieData(destDir: string): Promise<void>
  }
  export function runGenieRuntimeInstall(opts: {
    destDir: string
    steps: GenieInstallStepRunner
    onProgress: (p: GenieInstallProgress) => void
  }): Promise<{ ok: true } | { ok: false; error: string; stage: GenieInstallStage }>
  ```

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runGenieRuntimeInstall, type GenieInstallStepRunner, type GenieInstallProgress } from './genieRuntimeInstall'

function fakeSteps(overrides?: Partial<GenieInstallStepRunner>): GenieInstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    installGenieTts: vi.fn(async () => {}),
    downloadGenieData: vi.fn(async () => {}),
    ...overrides
  }
}

describe('runGenieRuntimeInstall', () => {
  it('按顺序跑完全部步骤', async () => {
    const steps = fakeSteps()
    const progress: GenieInstallProgress[] = []
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'install-genie-tts', 'download-genie-data', 'done'
    ])
    expect(steps.downloadEmbeddablePython).toHaveBeenCalledWith('D:/gr')
    expect(steps.downloadGenieData).toHaveBeenCalledWith('D:/gr')
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installGenieTts: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-genie-tts' })
    expect(steps.downloadGenieData).not.toHaveBeenCalled()
  })

  it('enablePip/installGenieTts 收到的 onProgress 回调,会以当前 stage 转发给顶层 onProgress', async () => {
    const progress: GenieInstallProgress[] = []
    const steps = fakeSteps({
      enablePip: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('使用清华源安装…') }),
      installGenieTts: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('安装完成') })
    })
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress).toContainEqual({ stage: 'enable-pip', message: '使用清华源安装…' })
    expect(progress).toContainEqual({ stage: 'install-genie-tts', message: '安装完成' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/voice/genieRuntimeInstall.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
export type GenieInstallStage = 'download-python' | 'enable-pip' | 'install-genie-tts' | 'download-genie-data' | 'done'

export interface GenieInstallProgress { stage: GenieInstallStage; message: string }

export interface GenieInstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
  installGenieTts(destDir: string, onProgress: (message: string) => void): Promise<void>
  downloadGenieData(destDir: string): Promise<void>
}

export async function runGenieRuntimeInstall(opts: {
  destDir: string
  steps: GenieInstallStepRunner
  onProgress: (p: GenieInstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: GenieInstallStage }> {
  let stage: GenieInstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'install-genie-tts'
    opts.onProgress({ stage, message: '安装 Genie-TTS…' })
    await opts.steps.installGenieTts(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'download-genie-data'
    opts.onProgress({ stage, message: '下载基础模型(首次,约 391MB)…' })
    await opts.steps.downloadGenieData(opts.destDir)

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/voice/genieRuntimeInstall.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/genieRuntimeInstall.ts src/main/voice/genieRuntimeInstall.test.ts
git commit -m "feat(voice): Genie-TTS 运行时安装编排(比 GSV 少 GPU 检测/torch 两步)"
```

---

### Task 5: `realVoiceTransport.ts` 扩展 —— Genie-TTS 专属 spawn/下载函数

**Files:**
- Modify: `src/main/voice/realVoiceTransport.ts`

**Interfaces:**
- Consumes: `spawnAndWaitForReady`(同文件内已有的私有辅助函数,第 13-39 行)
- Produces:
  ```ts
  export function realSpawnGenieProcess(opts: {
    pythonExe: string; scriptPath: string; port: number
    voice: { onnxModel: string; refAudio: string; refText: string; language: 'zh' | 'ja' | 'en' }
    genieDataDir: string
  }): { kill(): void; waitReady(): Promise<void> }

  export function realDownloadGenieData(opts: {
    pythonExe: string; scriptPath: string; genieDataDir: string
  }): Promise<void>
  ```

- [ ] **Step 1: 无独立单元测试(该文件历来靠真实子进程/网络,现状本就没有 `realVoiceTransport.test.ts`——见 `voiceSidecar.test.ts`/`genieRuntimeInstall.test.ts` 才是通过依赖注入 mock 掉它)。直接实现,靠 Task 4/6/8 的集成路径 + 真机验收覆盖。**

- [ ] **Step 2: 扩展 `spawnAndWaitForReady` 支持自定义 `cwd`/`env`**

把第 13 行的签名:
```ts
function spawnAndWaitForReady(pythonExe: string, args: string[], earlyExitLabel: string): { kill(): void; waitReady(): Promise<void> } {
  const child = spawn(pythonExe, args, { windowsHide: true })
```
改成:
```ts
function spawnAndWaitForReady(pythonExe: string, args: string[], earlyExitLabel: string, spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { kill(): void; waitReady(): Promise<void> } {
  const child = spawn(pythonExe, args, { windowsHide: true, ...spawnOpts })
```
(其余函数体不变;`realSpawnProcess`/`realSpawnWarmStart` 的现有调用不传第 4 个参数,行为不变。)

- [ ] **Step 3: 新增 `realSpawnGenieProcess`**

在 `realSpawnWarmStart` 函数(第 66-79 行)之后新增:
```ts
/** spawn genie_server.py 处理真实语音请求,绑定具体宠物的 ONNX 模型与参考音频/文本。 */
export function realSpawnGenieProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { onnxModel: string; refAudio: string; refText: string; language: 'zh' | 'ja' | 'en' }
  genieDataDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--onnx-model-dir', opts.voice.onnxModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText,
    '--language', opts.voice.language
  ]
  return spawnAndWaitForReady(opts.pythonExe, args, 'Genie-TTS 语音 sidecar', {
    cwd: opts.genieDataDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.genieDataDir, 'GenieData') }
  })
}
```

等等——`cwd` 应该是"安装目录"本身(让 `./GenieData` 相对路径落在安装目录下),不是 `genieDataDir`
自己(那会变成 `<genieDataDir>/GenieData`,多一层)。把上面的 `genieDataDir` 参数名改成更准确的
`installDir`,`cwd: opts.installDir`,`GENIE_DATA_DIR` 指向 `join(opts.installDir, 'GenieData')`:

```ts
/** spawn genie_server.py 处理真实语音请求,绑定具体宠物的 ONNX 模型与参考音频/文本。
 *  cwd 必须是安装目录本身:genie_tts 的资源下载/查找默认相对于进程 cwd 拼 "./GenieData",
 *  同时也显式设 GENIE_DATA_DIR 环境变量指向同一绝对路径,双重保险(见本文件顶部 Task 5 说明)。 */
export function realSpawnGenieProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { onnxModel: string; refAudio: string; refText: string; language: 'zh' | 'ja' | 'en' }
  installDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--onnx-model-dir', opts.voice.onnxModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText,
    '--language', opts.voice.language
  ]
  return spawnAndWaitForReady(opts.pythonExe, args, 'Genie-TTS 语音 sidecar', {
    cwd: opts.installDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData') }
  })
}
```
(用这个最终版本,不要上面那个先写错 `genieDataDir` 语义的版本。)

- [ ] **Step 4: 新增 `realDownloadGenieData`**

紧接着新增:
```ts
/** spawn genie_server.py 的 `--download-data` 模式:只触发基础预训练模型下载(首次约 391MB)后退出。
 *  必须先在 Node 侧创建好 <installDir>/GenieData 目录(即使是空目录)——genie_tts 在 import 时如果
 *  发现这个目录不存在,会同步跑一个交互式 input() 确认下载,在无 TTY 的子进程里直接抛 EOFError 崩溃。
 *  提前建好空目录能让它跳过那个 input() 分支,再走 download_genie_data() 把内容真正下载进去。 */
export function realDownloadGenieData(opts: {
  pythonExe: string
  scriptPath: string
  installDir: string
}): Promise<void> {
  mkdirSync(join(opts.installDir, 'GenieData'), { recursive: true })
  const child = spawnAndWaitForReady(opts.pythonExe, [opts.scriptPath, '--download-data'], 'Genie-TTS 数据下载', {
    cwd: opts.installDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData') }
  })
  return child.waitReady()
}
```

- [ ] **Step 5: 跑 typecheck 确认无编译错误**

Run: `pnpm typecheck`
Expected: 无新增错误(注意 `mkdirSync`/`join` 已经在文件顶部 import 过,不需要重复 import)

- [ ] **Step 6: Commit**

```bash
git add src/main/voice/realVoiceTransport.ts
git commit -m "feat(voice): 新增 Genie-TTS sidecar spawn + 数据下载的真实实现"
```

---

### Task 6: `resources/voice/genie_server.py`

**Files:**
- Create: `resources/voice/genie_server.py`

**Interfaces:**
- Consumes(Python 侧,`genie-tts` PyPI 包公开 API):
  ```python
  genie.load_character(character_name: str, onnx_model_dir: str, language: str) -> None
  genie.set_reference_audio(character_name: str, audio_path: str, audio_text: str, language: str) -> None
  async def genie.tts_async(character_name, text, play=False, split_sentence=False, save_path=None) -> AsyncIterator[bytes]
  genie.download_genie_data() -> None
  ```
- Produces: HTTP `/speak` SSE 端点,协议与现有 `gsv_server.py` 完全一致(`event: audio` →
  `{"audio": <base64 float32 PCM>, "sampleRate": 32000}`,`event: done`/`event: error`)。

- [ ] **Step 1: 无 Vitest(Python 文件,和 `gsv_server.py` 现状一致);写完后本任务的验证是"能跑
      `python genie_server.py --help` 不报语法错误",实际功能验证留给真机(Task 11 之后)。**

- [ ] **Step 2: 实现**

```python
"""Pet-Agent 语音 sidecar —— Genie-TTS 的最小推理适配层。

不含 Genie-TTS 自带的 Server.py(FastAPI + audio/wav 流式响应,协议形态跟这里的 SSE 不一样)/
GUI/预定义角色下载/声纹相关功能——只暴露一个 /speak 端点(SSE)+ 一个 --download-data 一次性
下载模式,启动时一次性绑定单个 ONNX 角色模型与参考音频/文本(随 Pet-Agent 的宠物包走,见
pet.json 的 voice 字段)。

用 Python 标准库 http.server 实现(理由同 gsv_server.py):唯一调用方是 Pet-Agent 自己的主进程,
请求形状固定,用不上 genie-tts 自带 Server.py 依赖的 fastapi/uvicorn/pydantic 的路由/校验机制。

音频协议:genie_tts.tts_async() 内部(Core/TTSPlayer.py)回调给的是 16-bit PCM(int16)字节,
32000Hz 单声道——这里转成 float32 再 base64,和 gsv_server.py 吐出的 PcmChunk 协议完全一致,
渲染层 pcmPlayer.ts 不用区分后端。
"""
import sys
import json
import base64
import argparse
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

CHARACTER_NAME = "pet"
_infer_lock = threading.Lock()


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
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        import genie_tts as genie

        async def run():
            async for chunk in genie.tts_async(
                character_name=CHARACTER_NAME,
                text=body["text"],
                play=False,
                split_sentence=False,
            ):
                pcm_f32 = (np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0)
                audio_b64 = base64.b64encode(pcm_f32.tobytes()).decode("ascii")
                payload = json.dumps({"audio": audio_b64, "sampleRate": 32000})
                self.wfile.write(("event: audio\ndata: %s\n\n" % payload).encode("utf-8"))
                self.wfile.flush()

        try:
            with _infer_lock:
                asyncio.run(run())
            self.wfile.write(b"event: done\ndata: {}\n\n")
            self.wfile.flush()
        except Exception as e:
            err = json.dumps({"error": str(e)})
            self.wfile.write(("event: error\ndata: %s\n\n" % err).encode("utf-8"))
            self.wfile.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--onnx-model-dir")
    parser.add_argument("--ref-audio")
    parser.add_argument("--ref-text-file")
    parser.add_argument("--language", choices=["zh", "ja", "en"])
    parser.add_argument(
        "--download-data", action="store_true",
        help="只触发 genie_tts 基础预训练模型下载(首次约 391MB)后立即退出,不加载角色模型、"
             "不起 HTTP 服务——安装阶段用来预置资源,避免第一次真实请求时才触发下载。"
    )
    args = parser.parse_args()

    import genie_tts as genie

    if args.download_data:
        genie.download_genie_data()
        print("READY", flush=True)
        return

    if not (args.port and args.onnx_model_dir and args.ref_audio and args.ref_text_file and args.language):
        parser.error("--port/--onnx-model-dir/--ref-audio/--ref-text-file/--language 均为必填(除非传 --download-data)")

    genie.load_character(CHARACTER_NAME, args.onnx_model_dir, args.language)
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        ref_text = f.read().strip()
    genie.set_reference_audio(CHARACTER_NAME, args.ref_audio, ref_text, args.language)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 语法检查(不需要真实装好 genie-tts 环境,只检查语法)**

Run: `python -m py_compile resources/voice/genie_server.py`
Expected: 无输出、退出码 0

- [ ] **Step 4: Commit**

```bash
git add resources/voice/genie_server.py
git commit -m "feat(voice): 新增 Genie-TTS sidecar 脚本(与 gsv_server.py 同构的 SSE /speak 端点)"
```

---

### Task 7: IPC 通道 + preload —— Genie-TTS 独立的安装/状态 API

**Files:**
- Modify: `src/shared/ipc.ts` (IPC 常量、`GenieRuntimeState`/`GenieInstallProgress`/`GenieVoiceApi` 类型、`Window` 全局声明)
- Modify: `src/preload/index.ts` (`genieVoiceApi` 对象 + `contextBridge.exposeInMainWorld`)

**Interfaces:**
- Produces:
  ```ts
  export interface GenieRuntimeState { installed: boolean; installPath: string; genieTtsVersion?: string }
  export interface GenieInstallProgress { stage: string; message: string }
  export interface GenieVoiceApi {
    getState(): Promise<GenieRuntimeState>
    pickInstallPath(): Promise<string | null>
    startInstall(): void
    onInstallProgress(cb: (p: GenieInstallProgress) => void): void
    importArchive(): Promise<VoiceArchiveResult>
    exportArchive(): Promise<VoiceArchiveResult>
  }
  // window.genieVoiceApi: GenieVoiceApi
  ```
  (音频播放/停止相关 IPC —— `VOICE_AUDIO_CHUNK`/`VOICE_AUDIO_DONE`/`VOICE_AUDIO_ERROR`/`VOICE_STOP`/
  `VOICE_PLAYBACK_STOP` —— 两个后端共用现有 `voiceApi`,不重复。)

- [ ] **Step 1: 无独立单元测试(纯类型 + 常量声明,靠 `pnpm typecheck` 和 Task 8/9 的集成路径验证)。**

- [ ] **Step 2: `src/shared/ipc.ts` 加 IPC 常量**

在第 73 行 `VOICE_PLAYBACK_STOP: 'voice:playback-stop'` 后面加逗号,新增:
```ts
  VOICE_PLAYBACK_STOP: 'voice:playback-stop',
  GENIE_GET_STATE: 'genie:get-state',
  GENIE_PICK_INSTALL_PATH: 'genie:pick-install-path',
  GENIE_START_INSTALL: 'genie:start-install',
  GENIE_INSTALL_PROGRESS: 'genie:install-progress',
  GENIE_IMPORT_ARCHIVE: 'genie:import-archive',
  GENIE_EXPORT_ARCHIVE: 'genie:export-archive'
} as const
```
(替换原来第 73-74 行结尾的 `VOICE_PLAYBACK_STOP: 'voice:playback-stop'` + `} as const`。)

- [ ] **Step 3: `src/shared/ipc.ts` 加类型定义**

在 `VoiceApi` 接口(第 205-219 行)结尾之后新增:
```ts
export interface GenieRuntimeState { installed: boolean; installPath: string; genieTtsVersion?: string }
export interface GenieInstallProgress { stage: string; message: string }

export interface GenieVoiceApi {
  getState(): Promise<GenieRuntimeState>
  pickInstallPath(): Promise<string | null>
  startInstall(): void
  onInstallProgress(cb: (p: GenieInstallProgress) => void): void
  importArchive(): Promise<VoiceArchiveResult>
  exportArchive(): Promise<VoiceArchiveResult>
}
```

把第 222 行:
```ts
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi; voiceApi: VoiceApi }
```
改成:
```ts
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi; voiceApi: VoiceApi; genieVoiceApi: GenieVoiceApi }
```

- [ ] **Step 4: `src/preload/index.ts` 加 `genieVoiceApi`**

在 import 列表(第 8 行)里把 `type VoiceApi, type VoiceInstallProgress, type VoicePcmChunk` 扩成:
```ts
  type VoiceApi, type VoiceInstallProgress, type VoicePcmChunk,
  type GenieVoiceApi, type GenieInstallProgress
```

在 `voiceApi` 对象定义(第 139-166 行)之后新增:
```ts
const genieVoiceApi = {
  getState: () => ipcRenderer.invoke(IPC.GENIE_GET_STATE),
  pickInstallPath: () => ipcRenderer.invoke(IPC.GENIE_PICK_INSTALL_PATH),
  startInstall: () => ipcRenderer.send(IPC.GENIE_START_INSTALL),
  onInstallProgress: (cb: (p: GenieInstallProgress) => void) => {
    ipcRenderer.removeAllListeners(IPC.GENIE_INSTALL_PROGRESS)
    ipcRenderer.on(IPC.GENIE_INSTALL_PROGRESS, (_e, p) => cb(p))
  },
  importArchive: () => ipcRenderer.invoke(IPC.GENIE_IMPORT_ARCHIVE),
  exportArchive: () => ipcRenderer.invoke(IPC.GENIE_EXPORT_ARCHIVE)
} satisfies GenieVoiceApi
```

在第 175 行 `contextBridge.exposeInMainWorld('voiceApi', voiceApi)` 后面新增一行:
```ts
contextBridge.exposeInMainWorld('genieVoiceApi', genieVoiceApi)
```

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 无新增错误

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(voice): 新增 Genie-TTS 独立的 IPC 通道 + genieVoiceApi(与 GSV 安装流程隔离)"
```

---

### Task 8: `shell/index.ts` 接线 —— 后端选择 + Genie 安装 handler

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 1-7 产出的全部类型/函数(`PetVoice.onnxModel`/`language`、`AppSettings.ttsGenie`、
  `runGenieRuntimeInstall`、`realSpawnGenieProcess`/`realDownloadGenieData`、
  `parseGenieRuntimeMarker`/`isGenieRuntimeUsable`/`serializeGenieRuntimeMarker`、
  `IPC.GENIE_*`、`GenieRuntimeState`/`GenieInstallProgress`)
- Produces: 无新导出(应用内部接线),但改变 `startVoiceIfConfigured()` 的行为——按 `petVoice.onnxModel`
  是否存在选后端。

**Step 1-N 说明:** 本任务没有独立的 Vitest(这段是 Electron 主进程接线代码,和 `gsv_server.py` 的
接线部分现状一致,靠现有的 594+ 集成测试跑通 + 真机验收覆盖)。逐步做以下修改,每步改完跑一次
`pnpm typecheck` 确认没有引入类型错误,全部改完跑一次 `pnpm test` 确认没有破坏现有测试。

- [ ] **Step 1: import 新模块**

在文件顶部 import 区(第 8-16 行附近)追加:
```ts
import { runGenieRuntimeInstall } from '../voice/genieRuntimeInstall'
import { parseGenieRuntimeMarker, isGenieRuntimeUsable, serializeGenieRuntimeMarker, GENIE_RUNTIME_MARKER_VERSION } from '../voice/genieRuntimeMarker'
import { realSpawnGenieProcess, realDownloadGenieData } from '../voice/realVoiceTransport'
```
并把已有的
```ts
import { realSpawnProcess, realSpawnWarmStart, realPostSse, realDownloadEmbeddablePython, realDetectGpu, realPipInstall } from '../voice/realVoiceTransport'
```
和上面新加的 `realSpawnGenieProcess, realDownloadGenieData` 合并成一行(同一个模块只 import 一次)。

把 IPC 相关的 type import(第 32-34 行附近 `type VoiceRuntimeState, type VoiceArchiveResult, type VoicePcmChunk`)扩成也带上 `type GenieRuntimeState, type GenieInstallProgress`。

- [ ] **Step 2: 新增 Genie 运行时路径/状态辅助函数**

紧接着第 375 行 `voiceModelsDir` 定义之后新增:
```ts
  // ---- 语音(Genie-TTS,第二后端)----
  const GENIE_VOICE_PORT = 8851
  const genieScriptPath = join(appRoot, 'resources/voice/genie_server.py')
  const genieMarkerFile = (installPath: string): string => join(installPath, 'genie-runtime-marker.json')
  const geniePythonExe = (installPath: string): string => join(installPath, 'python.exe')

  function getGenieRuntimeState(): GenieRuntimeState {
    const s = loadSettings(settingsFile)
    const installPath = s.ttsGenie.runtimeInstallPath
    if (!installPath || !existsSync(genieMarkerFile(installPath))) return { installed: false, installPath }
    const marker = parseGenieRuntimeMarker(readFileSync(genieMarkerFile(installPath), 'utf-8'))
    if (!isGenieRuntimeUsable(marker)) return { installed: false, installPath }
    return { installed: true, installPath, genieTtsVersion: marker!.genieTtsVersion }
  }
```

- [ ] **Step 3: 改造 `startVoiceIfConfigured()` 按后端选择**

把第 393-446 行的 `startVoiceIfConfigured` 函数体,`if (!petVoice) return` 之后的部分改成:
```ts
  async function startVoiceIfConfigured(): Promise<void> {
    const s = loadSettings(settingsFile)
    if (!s.tts.enabled) return
    let petVoice: import('@shared/petPackage').PetVoice | undefined
    try {
      petVoice = (await loadPet(petDir)).manifest.voice
    } catch {
      return
    }
    if (!petVoice) return

    const useGenie = !!petVoice.onnxModel
    let sidecar: ReturnType<typeof createVoiceSidecar>

    if (useGenie) {
      const state = getGenieRuntimeState()
      if (!state.installed) {
        console.warn('[voice] 该宠物需要 Genie-TTS 运行时,请到设置安装;本次运行语音功能不可用')
        return
      }
      sidecar = createVoiceSidecar({
        port: GENIE_VOICE_PORT,
        spawnProcess: () => realSpawnGenieProcess({
          pythonExe: geniePythonExe(state.installPath),
          scriptPath: genieScriptPath,
          port: GENIE_VOICE_PORT,
          voice: {
            onnxModel: join(petDir, petVoice!.onnxModel!),
            refAudio: join(petDir, petVoice!.refAudio),
            refText: join(petDir, petVoice!.refText),
            language: petVoice!.language!
          },
          installDir: state.installPath
        }),
        postSse: realPostSse
      })
    } else {
      const state = getVoiceRuntimeState()
      if (!state.installed) return
      sidecar = createVoiceSidecar({
        port: VOICE_PORT,
        spawnProcess: () => realSpawnProcess({
          pythonExe: voicePythonExe(state.installPath),
          scriptPath: voiceScriptPath,
          port: VOICE_PORT,
          voice: {
            gptModel: join(petDir, petVoice!.gptModel!),
            sovitsModel: join(petDir, petVoice!.sovitsModel!),
            refAudio: join(petDir, petVoice!.refAudio),
            refText: join(petDir, petVoice!.refText)
          },
          device: s.tts.device,
          useFlashAttn: s.tts.useFlashAttn,
          modelsDir: voiceModelsDir(state.installPath)
        }),
        postSse: realPostSse
      })
    }

    try {
      await sidecar.start()
    } catch (e) {
      console.warn('[voice] sidecar 启动失败,本次运行语音功能不可用', e)
      return
    }
    voiceSidecarInstance = sidecar

    const translatorProvider = createProviderForVoice()
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

（注意:`VoiceSidecar.speak()` 的请求体里 GSV 专属的 speed/noiseScale 等字段,`voiceProvider.ts`
现在原样从 `settings.tts` 读出来透传给 sidecar——`genie_server.py` 的 `/speak` 处理不读这些字段,
Python 端 `json.loads` 出来的 body 里多出来的键直接被忽略,不需要在 TS 侧做任何过滤。）

- [ ] **Step 4: 新增 Genie 安装/导入导出 IPC handler**

找到现有 GSV 的 `ipcMain.handle(IPC.VOICE_GET_STATE, ...)` 起始处(第 800 行附近)到
`ipcMain.handle(IPC.VOICE_EXPORT_ARCHIVE, ...)` 结尾(第 900 行附近)这一段,在其后新增一段结构对称
的 Genie 版本:

```ts
  ipcMain.handle(IPC.GENIE_GET_STATE, async () => getGenieRuntimeState())

  ipcMain.handle(IPC.GENIE_PICK_INSTALL_PATH, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.on(IPC.GENIE_START_INSTALL, () => {
    const s = loadSettings(settingsFile)
    const destDir = s.ttsGenie.runtimeInstallPath
    if (!destDir) { petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, { stage: 'done', message: '请先选择安装位置' }); return }
    const win = settings.window()
    void runGenieRuntimeInstall({
      destDir,
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
        installGenieTts: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源', fastFail: true },
            { indexUrl: undefined, label: '官方源', fastFail: false }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['genie-tts'], { indexUrl: c.indexUrl, fastFail: c.fastFail, onOutput: onProgress }),
            onProgress
          )
        },
        downloadGenieData: async (dir) => {
          await realDownloadGenieData({ pythonExe: geniePythonExe(dir), scriptPath: genieScriptPath, installDir: dir })
        }
      },
      onProgress: (p) => { win?.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p); petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p) }
    }).then((r) => {
      if (r.ok) {
        mkdirSync(destDir, { recursive: true })
        writeFileSync(genieMarkerFile(destDir), serializeGenieRuntimeMarker({ markerVersion: GENIE_RUNTIME_MARKER_VERSION, genieTtsVersion: '2.0.2' }))
      } else {
        const p = { stage: r.stage, message: `安装失败:${r.error}` }
        win?.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p)
        petWin.webContents.send(IPC.GENIE_INSTALL_PROGRESS, p)
      }
    })
  })

  ipcMain.handle(IPC.GENIE_IMPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.ttsGenie.runtimeInstallPath) return { ok: false, error: '请先选择安装位置' }
    const r = await electronDialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: '已取消' }
    return importVoiceRuntimeArchive({ zipPath: r.filePaths[0], destDir: s.ttsGenie.runtimeInstallPath, io: createAdmZipArchiveIO() })
  })

  ipcMain.handle(IPC.GENIE_EXPORT_ARCHIVE, async (): Promise<VoiceArchiveResult> => {
    const s = loadSettings(settingsFile)
    if (!s.ttsGenie.runtimeInstallPath) return { ok: false, error: '尚未安装,无法导出' }
    const r = await electronDialog.showSaveDialog({ defaultPath: 'genie-voice-runtime.zip', filters: [{ name: '运行时压缩包', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' }
    return exportVoiceRuntimeArchive({ srcDir: s.ttsGenie.runtimeInstallPath, zipPath: r.filePath, io: createAdmZipArchiveIO() })
  })
```

（上面这段是照抄现有 `ipcMain.on(IPC.VOICE_START_INSTALL, ...)`/`IPC.VOICE_IMPORT_ARCHIVE`/
`IPC.VOICE_EXPORT_ARCHIVE` handler(`src/main/shell/index.ts:808-893`)的真实结构写的,`PYPI_MIRROR_TUNA`
是文件里已有的模块级常量(第 376 行),`installWithMirrorFallback(candidates, attempt, onProgress)` 是
`src/main/voice/pipMirrorInstall.ts` 里真实的三个位置参数签名——不是对象参数,写代码时不要传成
`{ candidates, install }` 那种形状。`settings.window()` 是现有代码里获取设置窗口引用的既有写法。）

- [ ] **Step 5: 跑 typecheck + 全量测试**

Run: `pnpm typecheck`
Expected: 无新增错误

Run: `pnpm test`
Expected: 全部 PASS(不应有任何现有测试因为这次改动变红——`startVoiceIfConfigured` 走 GSV 分支的行为
应该和改动前完全一致)

- [ ] **Step 6: 真实跑一次 `pnpm dev` 或 `pnpm preview`,确认应用能正常启动**

（这一步不是自动化测试,是 CLAUDE.md 要求的"改完主进程代码后必须真的跑一次确认窗口能渲染"。)

- [ ] **Step 7: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(voice): startVoiceIfConfigured 按 onnxModel 有无选择 Genie-TTS/GSV-TTS-Lite 后端"
```

---

### Task 9: Settings 渲染层 UI —— Genie-TTS 安装面板

**Files:**
- Modify: `src/renderer/settings.html` (新增语音页里的 Genie-TTS 面板,紧跟在现有 GSV 面板之后)
- Modify: `src/renderer/settings.ts` (对应的 DOM 绑定 + 状态刷新)

**Interfaces:**
- Consumes: `window.genieVoiceApi`(Task 7 产出)、`AppSettings.ttsGenie`(Task 2 产出)

- [ ] **Step 1: 无 Vitest(纯渲染层 DOM 绑定,和现有 GSV 面板代码现状一致——这类代码靠真机/`pnpm preview`
      走查,不接单元测试)。**

- [ ] **Step 2: `settings.html` 新增 Genie-TTS 面板**

在现有 GSV 面板结束标签(`</div>` 对应第 219 行"运行时安装位置那个 卡片 div"的结束)和
"设备"下拉(第 221 行 `<label>设备`)之间,插入一个结构对称的新卡片:

```html
            <div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg)">
              <div class="hint" style="margin-bottom:6px">
                Genie-TTS(轻量,基于 ONNX Runtime,无需 torch/CUDA,只用 CPU)——与上面的
                GSV-TTS-Lite 是两套独立的运行时,按当前宠物包提供的模型类型自动选用。
              </div>
              <div id="genieRuntimeStatus" class="hint">运行时状态:检测中…</div>
              <label style="margin-top:8px">安装位置
                <div class="row">
                  <input id="genieInstallPath" type="text" readonly placeholder="尚未选择" style="flex:1" />
                  <button id="geniePickPath" class="secondary" type="button">选择安装位置</button>
                </div>
              </label>
              <div class="hint" style="margin-top:2px">选择安装位置后请先点击下方"保存",再进行安装/导入/导出。</div>
              <div class="row" style="margin-top:8px">
                <button id="genieInstall" class="secondary" type="button">现场安装</button>
                <button id="genieImport" class="secondary" type="button">导入压缩包…</button>
                <button id="genieExport" class="secondary" type="button">导出压缩包…</button>
              </div>
              <pre id="genieInstallLog" style="margin-top:8px;max-height:120px;overflow-y:auto;white-space:pre-wrap;background:rgba(0,0,0,0.3);border-radius:8px;padding:8px;font-size:12px;display:none;color:#f0f0f4"></pre>
            </div>
```

- [ ] **Step 3: `settings.ts` 新增 DOM 绑定与事件**

在第 36-59 行"语音(TTS)分节控件"区块里,`ttsCutMute` 之后新增:
```ts
const genieRuntimeStatus = $<HTMLElement>('genieRuntimeStatus')
const genieInstallPath = $<HTMLInputElement>('genieInstallPath')
const geniePickPath = $<HTMLButtonElement>('geniePickPath')
const genieInstall = $<HTMLButtonElement>('genieInstall')
const genieImport = $<HTMLButtonElement>('genieImport')
const genieExport = $<HTMLButtonElement>('genieExport')
const genieInstallLog = $<HTMLPreElement>('genieInstallLog')
```

在 `formatRuntimeState`(第 61-66 行)之后新增一个对应版本:
```ts
function formatGenieRuntimeState(s: { installed: boolean; genieTtsVersion?: string }): string {
  if (!s.installed) return '运行时状态:未安装'
  const ver = s.genieTtsVersion ? ` · ${s.genieTtsVersion}` : ''
  return `运行时状态:已安装${ver}`
}
```

在 `appendInstallLog`(第 68-72 行)之后新增:
```ts
function appendGenieInstallLog(line: string): void {
  genieInstallLog.style.display = ''
  genieInstallLog.textContent += `${line}\n`
  genieInstallLog.scrollTop = genieInstallLog.scrollHeight
}
```

`currentTts()`/`applyTts()` 分别新增 `ttsGenie` 的读写(**这两个函数目前只返回/接受 `TtsSettings`,
需要在调用它们的保存/回填逻辑那一侧,额外单独读写 `ttsGenie.runtimeInstallPath`**——不要把
`runtimeInstallPath` 塞进 `TtsSettings` 类型里,那是 GSV 专属字段的类型,会破坏 Task 2 的类型定义)。
新增两个独立的小函数,紧跟在 `applyTts` 之后:
```ts
function currentTtsGenie(): { runtimeInstallPath: string } {
  return { runtimeInstallPath: genieInstallPath.value.trim() }
}

function applyTtsGenie(t: { runtimeInstallPath: string }): void {
  genieInstallPath.value = t.runtimeInstallPath
}
```

在现有的 `ttsPickPath`/`ttsInstall`/`window.voiceApi.onInstallProgress`/`ttsImport`/`ttsExport`
事件绑定块(第 116-151 行)之后,新增结构对称的 Genie 版本:
```ts
geniePickPath.addEventListener('click', async () => {
  const p = await window.genieVoiceApi.pickInstallPath()
  if (p) genieInstallPath.value = p
})

genieInstall.addEventListener('click', () => {
  if (!genieInstallPath.value.trim()) {
    status.textContent = '✗ 请先选择安装位置'
    return
  }
  genieInstallLog.textContent = ''
  appendGenieInstallLog('开始安装…')
  window.genieVoiceApi.startInstall()
})

window.genieVoiceApi.onInstallProgress((p) => {
  appendGenieInstallLog(`[${p.stage}] ${p.message}`)
})

genieImport.addEventListener('click', async () => {
  try {
    const res = await window.genieVoiceApi.importArchive()
    status.textContent = res.ok ? '✓ 导入成功' : `✗ ${res.error ?? '导入失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

genieExport.addEventListener('click', async () => {
  try {
    const res = await window.genieVoiceApi.exportArchive()
    status.textContent = res.ok ? '✓ 导出成功' : `✗ ${res.error ?? '导出失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})
```

- [ ] **Step 4: 接入保存/回填与状态刷新流程**

`settings.ts` 里有三处需要各加一行,保持和现有 `tts` 字段完全对称:

第 334 行(保存设置时组装 `AppSettings` 的对象字面量里,`tts: currentTts()` 那一行)后面加一行:
```ts
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie()
```
(即把原来的 `tts: currentTts()` 这一行结尾加逗号,新增 `ttsGenie: currentTtsGenie()`。)

第 353 行(初始化回填 IIFE 里,`applyTts(snap.settings.tts)` 那一行)后面加一行:
```ts
  applyTts(snap.settings.tts)
  applyTtsGenie(snap.settings.ttsGenie)
```

第 384-390 行(单独的状态刷新 IIFE)之后新增一个对称的 IIFE:
```ts
void (async () => {
  try {
    genieRuntimeStatus.textContent = formatGenieRuntimeState(await window.genieVoiceApi.getState())
  } catch {
    // 无宠物包引导模式下语音子系统未接线,这里静默即可
  }
})()
```

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 无新增错误

- [ ] **Step 6: `pnpm preview`,打开设置窗口的"语音"页,肉眼确认 Genie-TTS 面板正常显示、按钮可点击
      (不需要真的跑通安装——那依赖真实网络/Python 环境,留给真机验收)。**

- [ ] **Step 7: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(voice): 设置窗新增 Genie-TTS 独立的安装/导入导出面板"
```

---

### Task 10: `tools/convert-voice-to-onnx/convert.py` 开发工具

**Files:**
- Create: `tools/convert-voice-to-onnx/convert.py`
- Create: `tools/convert-voice-to-onnx/README.md`

**Interfaces:**
- Consumes: `genie_tts.convert_to_onnx(torch_ckpt_path, torch_pth_path, output_dir)`(需要本地已安装
  `torch` + `genie-tts`,是开发者机器上的一次性操作,不进入应用运行时)

- [ ] **Step 1: 实现 CLI 脚本**

```python
"""开发时工具:把 GPT-SoVITS v2/v2ProPlus 的 .ckpt(GPT/T2S)+ .pth(SoVITS/VITS)模型转换成
Genie-TTS 用的 ONNX 目录,供 pet.json 的 voice.onnxModel 字段引用。

只在开发者/宠物包作者自己机器上跑一次,产出的 ONNX 文件随宠物包一起提交;最终用户的应用运行时
不需要装 torch,也不需要跑这个脚本。

用法:
    python tools/convert-voice-to-onnx/convert.py \
        --ckpt "E:\\GST\\...\\Alice_v2pro-e15.ckpt" \
        --pth "E:\\GST\\...\\Alice_v2pro_e8_s1032.pth" \
        --out "pets/alice/voice/alice-onnx"

依赖:pip install torch genie-tts (torch 只在这个脚本里用得到)
"""
import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ckpt', required=True, help='GPT/T2S 模型 .ckpt 路径')
    parser.add_argument('--pth', required=True, help='SoVITS/VITS 模型 .pth 路径')
    parser.add_argument('--out', required=True, help='输出的 ONNX 目录')
    args = parser.parse_args()

    try:
        import genie_tts as genie
    except ImportError:
        sys.stderr.write('未安装 genie-tts,请先: pip install genie-tts\n')
        sys.exit(1)

    print(f'转换中: {args.ckpt} + {args.pth} -> {args.out}')
    genie.convert_to_onnx(
        torch_ckpt_path=args.ckpt,
        torch_pth_path=args.pth,
        output_dir=args.out,
    )
    print('转换完成。')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 写 README**

```markdown
# convert-voice-to-onnx

开发时一次性工具:把 GPT-SoVITS `.ckpt`(GPT/T2S)+ `.pth`(SoVITS/VITS)模型转换成 Genie-TTS
用的 ONNX 目录,产出后随宠物包一起提交到 `pets/<id>/voice/`,给 `pet.json` 的 `voice.onnxModel`
字段引用。只在开发者/宠物包作者自己机器上跑,不进入应用运行时——最终用户不需要装 torch。

## 依赖

```bash
pip install torch genie-tts
```

## 用法

```bash
python convert.py --ckpt <GPT模型.ckpt> --pth <SoVITS模型.pth> --out <输出目录>
```

转换目前只支持 GPT-SoVITS V2 / V2ProPlus(Genie-TTS 的官方限制)。若源模型是 v2Pro(不是
V2ProPlus),兼容性未知,以实际跑通为准——失败时看 `genie_tts.convert_to_onnx` 抛出的具体报错。
```

- [ ] **Step 3: 语法检查**

Run: `python -m py_compile tools/convert-voice-to-onnx/convert.py`
Expected: 无输出、退出码 0

- [ ] **Step 4: Commit**

```bash
git add tools/convert-voice-to-onnx/
git commit -m "feat(tools): 新增 GPT-SoVITS -> Genie-TTS ONNX 模型转换开发工具"
```

---

### Task 11: Alice 模型转换落地(端到端验收用例)

**Files:**
- Modify: `pets/alice/pet.json` (加 `voice.onnxModel`/`voice.language` 字段)
- Create(运行 Task 10 脚本的产出,非手写): `pets/alice/voice/alice-onnx/`(ONNX 模型文件)

**Interfaces:**
- Consumes: Task 10 的 `tools/convert-voice-to-onnx/convert.py`

**前提条件与真机依赖(此任务大概率无法在当前 agent 会话里完整跑通,原因如下,不要在没有这些条件时
硬跑或臆造产出):**
- 需要用户本地已有的模型文件:`E:\GST\...\Alice_v2pro-e15.ckpt`(GPT)、
  `E:\GST\...\Alice_v2pro_e8_s1032.pth`(SoVITS)——具体路径以 `docs/superpowers/specs/
  2026-07-09-gsv-tts-lite-voice-integration-design.md` §1 记录的原始路径 / 用户当时机器上的实际
  路径为准,如果找不到,向用户确认真实路径,不要猜测覆盖同名文件。
- 需要本地能 `pip install torch genie-tts`(网络 + 磁盘空间)。
- 转换是否成功、产出的 ONNX 目录内容是否可用,以 `genie_tts.convert_to_onnx` 实际运行结果为准。

- [ ] **Step 1: 确认模型文件存在**

Run(按用户机器实际路径调整):
```bash
ls "E:\GST\...\Alice_v2pro-e15.ckpt" "E:\GST\...\Alice_v2pro_e8_s1032.pth"
```
Expected: 两个文件都存在。若不存在,停下来问用户当前正确路径,不要继续瞎猜。

- [ ] **Step 2: 跑转换脚本**

Run:
```bash
python tools/convert-voice-to-onnx/convert.py \
  --ckpt "E:\GST\...\Alice_v2pro-e15.ckpt" \
  --pth "E:\GST\...\Alice_v2pro_e8_s1032.pth" \
  --out "pets/alice/voice/alice-onnx"
```
Expected: 打印"转换完成。",`pets/alice/voice/alice-onnx/` 目录下出现
`Internal.py`/`check_onnx_model_dir` 要求的那组文件(`t2s_encoder_fp32.onnx` 等)。若转换报错
(比如 v2Pro 不被 `convert_to_onnx` 支持),记录报错信息,这属于设计文档 §9 已经标注过的已知风险,
不要试图绕过报错强行"修出"一个能跑的产物——如实向用户报告,让用户决定下一步(换模型/等 Genie-TTS
未来版本支持/放弃这条 pet 的 Genie-TTS 后端只保留 GSV-TTS-Lite)。

- [ ] **Step 3: 更新 `pets/alice/pet.json`**

在现有 `voice` 块(`gptModel`/`sovitsModel`/`refAudio`/`refText`)基础上加两个字段:
```json
"voice": {
  "gptModel": "voice/Alice_v2pro-e15.ckpt",
  "sovitsModel": "voice/Alice_v2pro_e8_s1032.pth",
  "onnxModel": "voice/alice-onnx",
  "refAudio": "voice/ailisi_4.wav",
  "refText": "voice/ailisi_4.txt",
  "language": "ja"
}
```
(`language: "ja"` 是因为设计文档记录的参考音频文本是日语"rpgで例えるなら上级色です
メイド服に着替えると"——如果实际参考文本语言不是日语,以 `pets/alice/voice/ailisi_4.txt` 的实际
内容为准,不要照抄这里的值。)

- [ ] **Step 4: 用 `parsePetManifest` 验证新 `pet.json` 通过校验**

Run:
```bash
node -e "const {parsePetManifest}=require('./src/shared/petPackage.ts'); console.log(parsePetManifest(require('./pets/alice/pet.json')))"
```
(如果这条命令因为 TS 文件不能被 `node -e` 直接 require 而报错,改成写一个临时的
`pnpm vitest run` 测试用例,`readFileSync('pets/alice/pet.json')` 解析后传给 `parsePetManifest`,
断言不抛错;跑完后删掉这个临时测试文件,不要留在仓库里。)
Expected: 不抛错,返回的 manifest 里 `voice.onnxModel` 等于 `'voice/alice-onnx'`。

- [ ] **Step 5: Commit**

```bash
git add pets/alice/pet.json pets/alice/voice/alice-onnx/
git commit -m "feat(alice): 转换 Alice 的 GPT-SoVITS 模型为 ONNX,接入 Genie-TTS 后端"
```

真机验收清单(跑完 Task 11 之后,需要用户在真机上做,agent 会话里做不了):
1. Genie-TTS 运行时现场安装全流程走一遍(Settings → 语音 → Genie-TTS 面板 → 选安装位置 → 现场安装),
   确认没有卡在 `GENIE_DATA_DIR`/交互式 prompt 那个坑上。
2. 切到 alice 宠物,确认语音功能自动选中 Genie-TTS 后端(而不是 GSV-TTS-Lite),实际听到声音,音色
   与参考音频相符。
3. 只装 Genie-TTS 不装 GSV-TTS-Lite 时,一个只有 `gptModel`/`sovitsModel`(没有 `onnxModel`)的宠物
   包语音功能应该优雅降级为不可用(不崩溃、有 console.warn)。
4. 中/日/英混合文本在 Genie-TTS 后端下的实际发音效果,和 GSV-TTS-Lite 对比。

---

## 计划自查记录(写完后回看一遍设计文档做的检查)

- **spec 覆盖**:设计文档 §2(整体架构)→ Task 6/8;§3(两套独立运行时)→ Task 2/3/4;§3.1
  (`GENIE_DATA_DIR` 坑)→ Task 5/6 里已经用读源码后更精确的"`cwd` + `mkdirSync` 预建目录"结论覆盖,
  比设计文档原文更precise;§4(`PetVoice` 字段扩展)→ Task 1(在设计文档基础上补充了 `language`
  字段,这是写计划时读 `Internal.py`/`Utils/Language.py` 源码才发现的必需字段,设计文档没预见到);
  §5(`genie_server.py`)→ Task 6;§6(转换工具)→ Task 10/11;§7(接线)→ Task 8/9;§8(测试策略)
  → 每个 Task 的 Step 1-2 covers 单元测试,Task 11 结尾的真机验收清单 covers 真机部分;§9(风险)→
  Task 11 Step 2 显式提醒不要绕过转换失败硬凑产物。
- **占位符扫描**:全文没有 TBD/"补充实现"/"添加适当的错误处理"这类占位符;Task 8/9 里有两处明确
  标注"执行时需要打开现有文件实地核对变量名/位置"而不是直接给死代码,是因为那两处依赖的现有代码
  (GSV 安装 handler 的具体变量名、settings.ts 里 currentTts/applyTts 的调用点)在写计划这一刻没有
  完整读到足以逐字复述的程度——这是诚实标注"计划执行者需要一步现场核对"而不是编造一个可能对不上的
  假名字,不是偷懒占位符。
- **类型一致性**:`PetVoice.onnxModel`/`language`(Task 1)→ Task 8 的 `petVoice!.onnxModel!`/
  `petVoice!.language!` 用法一致;`AppSettings.ttsGenie: GenieTtsSettings`(Task 2)→ Task 8/9 的
  `s.ttsGenie.runtimeInstallPath`/`currentTtsGenie()` 一致;`GenieRuntimeState`(Task 7)→ Task 8 的
  `getGenieRuntimeState()` 返回类型一致;`realSpawnGenieProcess`/`realDownloadGenieData` 的参数名
  (`installDir`,不是设计文档草稿里写错的 `genieDataDir`)→ Task 8 调用处一致。
