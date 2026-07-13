# TTS 后端手动选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TTS 后端从"按宠物包是否提供 `onnxModel` 自动判断"改成"用户在设置页手动选、全局生效",
选中的后端对当前宠物不可用时直接不可用(不静默回退到另一个),并让设置页把两套运行时安装区域在视觉上
明确分开。

**Architecture:** 新增 `TtsSettings.backend: 'gsv-tts-lite' | 'genie-tts'` 全局设置字段(默认
`'gsv-tts-lite'`,保证老配置行为不变);`shell/index.ts` 里原有的纯函数 `shouldUseGenieBackend` 替换成
`resolveVoiceBackend(petVoice, backend): 'gsv-tts-lite' | 'genie-tts' | null`,`null` 表示选中的后端
对当前宠物不可用;`SettingsSnapshot` 新增 `activePetVoice` 字段供设置页判断"当前宠物支不支持选中的
后端";设置页新增后端选择下拉 + 不可用提示 + 两个运行时面板加醒目分节标题。

**Tech Stack:** TypeScript(Electron 主进程/渲染层)、Vitest。

## Global Constraints

- 不要给 `package.json` 加 `"type": "module"`。
- 每个改动 TS 文件的任务都要跑 `pnpm typecheck` 和相关 Vitest,确认通过再提交。
- 选中的后端对当前宠物不可用时,语音功能直接不可用,绝不静默回退到另一个后端(设计文档 §1 明确要求)。
- `tts.backend` 是全局设置,不是每个宠物单独记忆(设计文档 §1/§2)。
- **`SETTINGS_SCHEMA_VERSION` 这次从 12 升到 13。上一轮(2026-07-12)升级 11→12 时漏改了
  `settingsMigration.test.ts` 里 8 处硬编码的 `toBe(11)`,导致一次跨任务回归,这次必须一次改全。
  已确认的全部硬编码 schemaVersion 断言位置(执行 Task 1 时按此列表逐一改,不要只改 grep 到的部分
  就假设改完了,改完后再 grep 一遍 `toBe(12)` 确认清零):**
  - `src/main/config/settingsMigration.test.ts` 第 24、52、74、112、137、165、193、243 行(均为
    `.toBe(12)`,改成 `.toBe(13)`,对应的 `it(...)` 标题如果写了具体数字也要同步改)
  - `src/main/config/settings.test.ts` 第 66、94、128 行(均为 `.toBe(12)`,改成 `.toBe(13)`)

---

### Task 1: `TtsSettings.backend` 字段

**Files:**
- Modify: `src/shared/llm.ts`(新增 `TtsBackend` 类型 + `TtsSettings.backend` 字段 + `DEFAULT_TTS_SETTINGS.backend` + `SETTINGS_SCHEMA_VERSION` 12→13)
- Modify: `src/main/config/settings.ts`(`normalizeSettings` 里 `tts` 归一化块新增 `backend` 处理)
- Modify: `src/main/config/settings.test.ts`(新增 `backend` 测试 + 3 处 schemaVersion 断言改 13)
- Modify: `src/main/config/settingsMigration.test.ts`(8 处 schemaVersion 断言改 13)

**Interfaces:**
- Produces:
  ```ts
  export type TtsBackend = 'gsv-tts-lite' | 'genie-tts'
  // TtsSettings 新增字段: backend: TtsBackend
  // DEFAULT_TTS_SETTINGS.backend = 'gsv-tts-lite'
  ```

- [ ] **Step 1: 写失败的测试**

在 `src/main/config/settings.test.ts` 里,找到已有的 `describe('ttsGenie', ...)` 块(Task 2 那次加的),
在它后面新增一个同级的 describe:

```ts
describe('tts.backend', () => {
  it('缺省 → 默认 gsv-tts-lite', () => {
    const f = tmpSettingsFile({ schemaVersion: 12, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).tts.backend).toBe('gsv-tts-lite')
  })
  it('保留合法值 genie-tts', () => {
    const f = tmpSettingsFile({ tts: { backend: 'genie-tts' } })
    expect(loadSettings(f).tts.backend).toBe('genie-tts')
  })
  it('非法值 → 回退默认 gsv-tts-lite', () => {
    const f = tmpSettingsFile({ tts: { backend: 'not-a-real-backend' } })
    expect(loadSettings(f).tts.backend).toBe('gsv-tts-lite')
  })
})
```

然后把第 66、94、128 行三处 `expect(loadSettings(f).schemaVersion).toBe(12)` 改成
`expect(loadSettings(f).schemaVersion).toBe(13)`(改动前先用 `Read` 工具打开文件确认这三行现在的
准确内容和行号,本计划撰写时的行号可能已随其它改动轻微漂移)。

在 `src/main/config/settingsMigration.test.ts` 里,把第 24、52、74、112、137、165、193、243 行(同样
先 `Read` 确认现在的准确内容/行号)全部 8 处 `.toBe(12)` 改成 `.toBe(13)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts`
Expected: 新增的 `tts.backend` 三个用例 FAIL(`TtsSettings` 还没有 `backend` 字段);所有改成 13 的
schemaVersion 断言 FAIL(当前代码仍产出 12)。

- [ ] **Step 3: 实现**

`src/shared/llm.ts`——在 `TtsTextSplit` 类型定义(第 58 行)后面新增:
```ts
export type TtsBackend = 'gsv-tts-lite' | 'genie-tts'
```

`TtsSettings` 接口里,在 `enabled: boolean` 后面加一行:
```ts
export interface TtsSettings {
  enabled: boolean
  backend: TtsBackend
  /** 语音运行时(可移植 Python + 依赖)安装位置;空字符串 = 未配置 */
  runtimeInstallPath: string
  ...
```

`DEFAULT_TTS_SETTINGS` 里,在 `enabled: false,` 后面加一行:
```ts
export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  backend: 'gsv-tts-lite',
  runtimeInstallPath: '',
  ...
```

把 `SETTINGS_SCHEMA_VERSION = 12` 改成 `SETTINGS_SCHEMA_VERSION = 13`。

`src/main/config/settings.ts`——在文件顶部新增一个合法值数组(仿照已有的 `TTS_DEVICES` 等数组,放在
它们旁边):
```ts
const TTS_BACKENDS: TtsBackend[] = ['gsv-tts-lite', 'genie-tts']
```
并把顶部 import 列表里的 `type TtsTextSplit` 后面加上 `, type TtsBackend`。

`normalizeSettings` 函数里的 `tts` 归一化块(`const tts = { enabled: ..., runtimeInstallPath: ..., ...}`),
在 `enabled: tt2.enabled === true,` 后面加一行:
```ts
  const tts = {
    enabled: tt2.enabled === true,
    backend: TTS_BACKENDS.includes(tt2.backend as TtsBackend) ? (tt2.backend as TtsBackend) : DEFAULT_SETTINGS.tts.backend,
    runtimeInstallPath: typeof tt2.runtimeInstallPath === 'string' ? tt2.runtimeInstallPath : DEFAULT_SETTINGS.tts.runtimeInstallPath,
    ...
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts`
Expected: 全部 PASS

Run: `grep -rn "toBe(12)" src/main/config/`
Expected: 无输出(确认没有漏改的 schemaVersion 断言)

Run: `pnpm typecheck`
Expected: 0 错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts src/main/config/settingsMigration.test.ts
git commit -m "feat(voice): AppSettings.tts 新增 backend 字段(手动选择 TTS 后端)"
```

---

### Task 2: `resolveVoiceBackend` 替换 `shouldUseGenieBackend`

**Files:**
- Modify: `src/main/shell/index.ts`(替换纯函数 + `startVoiceIfConfigured` 调用点)
- Modify: `src/main/shell/index.test.ts`(替换测试用例)

**Interfaces:**
- Consumes: `TtsBackend`(Task 1 产出)、`PetVoice`(已有,`src/shared/petPackage.ts`)
- Produces:
  ```ts
  export type VoiceBackendChoice = 'gsv-tts-lite' | 'genie-tts'
  export function resolveVoiceBackend(petVoice: PetVoice, selected: TtsBackend): VoiceBackendChoice | null
  ```
  (替换掉原来的 `export function shouldUseGenieBackend(petVoice: PetVoice): boolean`,原函数从此不存在)

- [ ] **Step 1: 写失败的测试**

把 `src/main/shell/index.test.ts` 整个文件内容替换成:

```ts
import { describe, it, expect } from 'vitest'
import { resolveVoiceBackend } from './index'

describe('resolveVoiceBackend', () => {
  it('选中 genie-tts 且宠物提供 onnxModel → 返回 genie-tts', () => {
    const petVoice = { onnxModel: 'voice/x', refAudio: 'a', refText: 'b', language: 'ja' as const }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBe('genie-tts')
  })

  it('选中 genie-tts 但宠物没提供 onnxModel → 返回 null(不回退)', () => {
    const petVoice = { gptModel: 'a.ckpt', sovitsModel: 'a.pth', refAudio: 'a', refText: 'b' }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBeNull()
  })

  it('选中 gsv-tts-lite 且宠物提供 gptModel/sovitsModel → 返回 gsv-tts-lite', () => {
    const petVoice = { gptModel: 'a.ckpt', sovitsModel: 'a.pth', refAudio: 'a', refText: 'b' }
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBe('gsv-tts-lite')
  })

  it('选中 gsv-tts-lite 但宠物没提供 gptModel/sovitsModel → 返回 null(不回退)', () => {
    const petVoice = { onnxModel: 'voice/x', refAudio: 'a', refText: 'b', language: 'ja' as const }
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBeNull()
  })

  it('两套模型都提供、选中 genie-tts → 返回 genie-tts(不受另一套模型存在与否影响)', () => {
    const petVoice = {
      onnxModel: 'voice/x', gptModel: 'a.ckpt', sovitsModel: 'a.pth',
      refAudio: 'a', refText: 'b', language: 'ja' as const
    }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBe('genie-tts')
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBe('gsv-tts-lite')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/shell/index.test.ts`
Expected: FAIL(`resolveVoiceBackend` 不存在;`shouldUseGenieBackend` 还在但没人 import 会导致
import 报错)

- [ ] **Step 3: 实现**

在 `src/main/shell/index.ts` 里找到:
```ts
/** 语音后端选择:宠物包提供 onnxModel 时走 Genie-TTS,否则(gptModel/sovitsModel)走 GSV-TTS-Lite。
 *  纯函数,独立导出以便单测覆盖这个 startVoiceIfConfigured() 里最高风险的分支决策。 */
export function shouldUseGenieBackend(petVoice: PetVoice): boolean {
  return !!petVoice.onnxModel
}
```
整段替换成:
```ts
export type VoiceBackendChoice = 'gsv-tts-lite' | 'genie-tts'

/** 按用户在设置里选的后端 + 当前宠物包实际提供的模型文件,解出这次要用哪个后端。
 *  选中的后端如果宠物包没提供对应模型文件,返回 null(不可用)——不会退回另一个后端,
 *  这是设计文档明确要求的行为,不是遗漏。
 *  纯函数,独立导出以便单测覆盖这个 startVoiceIfConfigured() 里最高风险的分支决策。 */
export function resolveVoiceBackend(petVoice: PetVoice, selected: TtsBackend): VoiceBackendChoice | null {
  if (selected === 'genie-tts') return petVoice.onnxModel ? 'genie-tts' : null
  return (petVoice.gptModel && petVoice.sovitsModel) ? 'gsv-tts-lite' : null
}
```
(需要把 `TtsBackend` 加进这个文件顶部从 `@shared/llm` 的 import 列表里。)

再找到 `startVoiceIfConfigured()` 函数体里这一段(大致在 `if (!petVoice) return` 之后):
```ts
    const useGenie = shouldUseGenieBackend(petVoice)
    let sidecar: ReturnType<typeof createVoiceSidecar>

    if (useGenie) {
      const state = getGenieRuntimeState()
      if (!state.installed) {
        console.warn('[voice] 该宠物需要 Genie-TTS 运行时,请到设置安装;本次运行语音功能不可用')
        return
      }
```
改成:
```ts
    const backend = resolveVoiceBackend(petVoice, s.tts.backend)
    if (backend === null) {
      console.warn(`[voice] 当前宠物不提供 ${s.tts.backend === 'genie-tts' ? 'Genie-TTS' : 'GSV-TTS-Lite'} 需要的模型文件,本次运行语音功能不可用`)
      return
    }
    let sidecar: ReturnType<typeof createVoiceSidecar>

    if (backend === 'genie-tts') {
      const state = getGenieRuntimeState()
      if (!state.installed) {
        console.warn('[voice] 该宠物需要 Genie-TTS 运行时,请到设置安装;本次运行语音功能不可用')
        return
      }
```
(只改了判断条件那几行;`if (backend === 'genie-tts') {...} else {...}` 两个分支各自内部 spawn
sidecar 的代码原样保留,不要改动分支内部——原来 `if (useGenie) {...}` 里的内容原样搬到
`if (backend === 'genie-tts') {...}` 里,原来 `else {...}` 里的内容原样搬到新的 `else {...}` 里。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/shell/index.test.ts`
Expected: 5/5 PASS

Run: `pnpm typecheck`
Expected: 0 错误(确认没有其它地方还在引用已删除的 `shouldUseGenieBackend`)

Run: `pnpm test`
Expected: 全部 PASS,无回归

- [ ] **Step 5: `pnpm preview` 真机(尽力而为)确认应用能正常启动**

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/index.ts src/main/shell/index.test.ts
git commit -m "feat(voice): shouldUseGenieBackend 替换成 resolveVoiceBackend,支持手动选择且不回退"
```

---

### Task 3: `SettingsSnapshot.activePetVoice` 字段

**Files:**
- Modify: `src/shared/ipc.ts`(`SettingsSnapshot` 接口新增字段)
- Modify: `src/main/shell/index.ts`(两处 `IPC.GET_SETTINGS` handler 填充该字段)

**Interfaces:**
- Consumes: `PetVoice`(已有)、`loadPet`(已有,`startVoiceIfConfigured` 里已经在用)
- Produces:
  ```ts
  // SettingsSnapshot 新增字段: activePetVoice: PetVoice | undefined
  ```

**本任务没有独立的 Vitest**(`SettingsSnapshot` 是纯类型 + 两个已有 IPC handler 的字段扩展,和现有
`noPetInstalled`/`hasFirecrawlKey` 等字段的现状一致,没有专门测试;靠 `pnpm typecheck` + `pnpm preview`
走查验证)。

- [ ] **Step 1: `src/shared/ipc.ts` 扩展类型**

找到:
```ts
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean; noPetInstalled: boolean }
```
改成:
```ts
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean; noPetInstalled: boolean; activePetVoice: PetVoice | undefined }
```
(需要确认这个文件顶部已经 import 了 `PetVoice` 类型;如果没有,从 `@shared/petPackage` 加一个
`import type { PetVoice } from './petPackage'`,注意 `ipc.ts` 和 `petPackage.ts` 都在 `src/shared/`
下,用相对路径 `./petPackage` 而不是 `@shared/petPackage` 别名——同目录下的跨文件 import 这个仓库的
既有代码用的是相对路径,执行本任务时打开 `ipc.ts` 顶部 import 区实地确认一下既有写法再照抄。)

- [ ] **Step 2: `src/main/shell/index.ts` 两处 `GET_SETTINGS` handler 各自填充**

`startOnboarding` 里那个(第 111-118 行附近,`noPetInstalled: listPets(petCatalogDirs).length === 0`
那个):
```ts
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey(),
    noPetInstalled: listPets(petCatalogDirs).length === 0,
    activePetVoice: undefined
  }))
```
(这个 handler 跑在"引导模式,没有已装宠物包"的场景,不存在 `petDir`,固定给 `undefined`。)

`startShell` 里那个(第 768-775 行附近,`noPetInstalled: false` 那个):
```ts
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey(),
    hasSearchKey: searchSecrets.hasKey(),
    hasEmbeddingKey: embeddingSecrets.hasKey(),
    hasFirecrawlKey: firecrawlSecrets.hasKey(),
    noPetInstalled: false,
    activePetVoice: (await loadPet(petDir)).manifest.voice
  }))
```
(这个 handler 跑在 `startShell()` 里,`petDir` 在同一个函数作用域内已经解析好,`loadPet` 也已经在
`startVoiceIfConfigured` 里被引用过,直接复用,不需要新增 import。如果 `loadPet(petDir)` 抛错——
理论上不应该,因为能跑到这个 handler 说明 `startShell` 已经成功解析出宠物目录——不用额外 try/catch,
让它按现有惯例自然向上抛,IPC 调用方(渲染层)会在 `await window.settingsApi.getSettings()` 那层
看到 rejected promise,这和这个 handler 里其它字段没有特殊保护是一致的处理方式。)

- [ ] **Step 3: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 0 错误

- [ ] **Step 4: `pnpm preview`,打开设置窗口,确认没有因为这个改动导致设置窗口加载报错(尽力而为)。**

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/shell/index.ts
git commit -m "feat(voice): SettingsSnapshot 新增 activePetVoice,供设置页判断后端可用性"
```

---

### Task 4: Settings UI —— 后端选择控件 + 不可用提示 + 面板分节标题

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `TtsBackend`(Task 1)、`SettingsSnapshot.activePetVoice`(Task 3)

**本任务没有独立的 Vitest**(渲染层 DOM 逻辑,和现有 TTS 面板代码现状一致,靠 `pnpm preview` 真机走查)。

- [ ] **Step 1: `settings.html` 新增后端选择控件 + 不可用提示**

在 `ttsEnabled` 那个 `<label>`(第 199-202 行)后面、原来紧接着的运行时安装卡片(第 204 行
`<div style="margin-top:6px;...">`)前面,插入:
```html
            <label>TTS 后端
              <select id="ttsBackend">
                <option value="gsv-tts-lite">GSV-TTS-Lite</option>
                <option value="genie-tts">Genie-TTS(轻量)</option>
              </select>
            </label>
            <div id="ttsBackendUnavailable" class="hint" style="display:none;color:#e88">
              当前宠物未提供所选后端需要的模型文件,语音功能本次不可用。
            </div>
```

把第 198 行的顶部说明文字:
```html
            <div class="hint">配音使用本地 GSV-TTS-Lite 运行时(独立 Python 环境 + 模型,体积较大),需先安装运行时才能生效。</div>
```
改成不再预设"只有 GSV-TTS-Lite"这个前提:
```html
            <div class="hint">配音使用本地 Python 运行时,下面选一个后端并安装对应运行时才能生效。</div>
```

把 GSV 运行时卡片(第 204 行 `<div style="margin-top:6px;...">`)开头加一行醒目小标题:
```html
            <div style="margin-top:6px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg)">
              <div style="font-weight:600;margin-bottom:4px">GSV-TTS-Lite 运行时</div>
              <div id="ttsRuntimeStatus" class="hint">运行时状态:检测中…</div>
```
(即在原来的 `<div id="ttsRuntimeStatus" ...>` 那一行前面加一行 `<div style="font-weight:600;...">`。)

把 Genie 运行时卡片开头的说明文字(第 222-225 行):
```html
              <div class="hint" style="margin-bottom:6px">
                Genie-TTS(轻量,基于 ONNX Runtime,无需 torch/CUDA,只用 CPU)——与上面的
                GSV-TTS-Lite 是两套独立的运行时,按当前宠物包提供的模型类型自动选用。
              </div>
```
改成(去掉"自动选用"这句已经不成立的描述,加同款醒目小标题):
```html
              <div style="font-weight:600;margin-bottom:4px">Genie-TTS 运行时</div>
              <div class="hint" style="margin-bottom:6px">
                轻量,基于 ONNX Runtime,无需 torch/CUDA,只用 CPU——与上面的 GSV-TTS-Lite
                是两套独立的运行时,在上方"TTS 后端"选择哪个就用哪个。
              </div>
```

- [ ] **Step 2: `settings.ts` 新增 DOM 绑定与可用性刷新逻辑**

在第 37 行 `const ttsEnabled = $<HTMLInputElement>('ttsEnabled')` 后面新增:
```ts
const ttsBackend = $<HTMLSelectElement>('ttsBackend')
const ttsBackendUnavailable = $<HTMLElement>('ttsBackendUnavailable')
```

在顶部 import 的 `type TtsTextSplit` 后面加上 `, type TtsBackend`。

在文件里找一个合适位置(紧跟 `applyTtsGenie` 函数定义之后即可)新增:
```ts
let activePetVoice: import('@shared/petPackage').PetVoice | undefined

function refreshBackendAvailability(): void {
  const v = activePetVoice
  const supportsGenie = !!v?.onnxModel
  const supportsGsv = !!(v?.gptModel && v?.sovitsModel)
  const selected = ttsBackend.value as TtsBackend
  const unavailable = selected === 'genie-tts' ? !supportsGenie : !supportsGsv
  ttsBackendUnavailable.style.display = unavailable ? '' : 'none'
}

ttsBackend.addEventListener('change', refreshBackendAvailability)
```

在 `currentTts()` 函数(现有的,返回 `TtsSettings` 那个)里,`enabled: ttsEnabled.checked,` 后面加一行:
```ts
function currentTts(): TtsSettings {
  return {
    enabled: ttsEnabled.checked,
    backend: ttsBackend.value as TtsBackend,
    runtimeInstallPath: ttsInstallPath.value.trim(),
    ...
```

在 `applyTts(t: TtsSettings)` 函数里,`ttsEnabled.checked = t.enabled` 后面加一行:
```ts
function applyTts(t: TtsSettings): void {
  ttsEnabled.checked = t.enabled
  ttsBackend.value = t.backend
  ttsInstallPath.value = t.runtimeInstallPath
  ...
```

- [ ] **Step 3: 接入初始化回填 + 可用性刷新**

找到初始化回填 IIFE 里 `applyTts(snap.settings.tts)` 那一行(在 `applyTtsGenie(snap.settings.ttsGenie)`
之前),后面新增:
```ts
  applyTts(snap.settings.tts)
  applyTtsGenie(snap.settings.ttsGenie)
  activePetVoice = snap.activePetVoice
  refreshBackendAvailability()
```

- [ ] **Step 4: 跑 typecheck**

Run: `pnpm typecheck`
Expected: 0 错误

- [ ] **Step 5: `pnpm preview`,打开设置窗口的"语音"页,肉眼确认:**
  - 顶部出现"TTS 后端"下拉,两个选项都在
  - 两个运行时卡片各自有醒目的小标题("GSV-TTS-Lite 运行时" / "Genie-TTS 运行时"),视觉上能一眼
    分清楚
  - 切换下拉选项时,如果当前宠物不支持选中的那个后端,`ttsBackendUnavailable` 提示文字会出现;
    支持的话提示消失
  - (不需要真的跑通安装/合成——那依赖真实网络/Python 环境,已经在之前的真机反馈循环里验证过基础
    安装流程能走通,这次只看新增的选择/提示 UI)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(voice): 设置页新增 TTS 后端手动选择 + 不可用提示 + 面板分节标题"
```

---

## 计划自查记录

- **spec 覆盖**:设计文档 §2(`tts.backend` 字段)→ Task 1;§3(`resolveVoiceBackend`,不回退)→
  Task 2;§4(`activePetVoice` 快照扩展)→ Task 3;§5(设置页 UI:选择控件+不可用提示+分节标题,
  两个面板都保留可见不做隐藏)→ Task 4;§6(测试策略,含 `resolveVoiceBackend` 四种组合的单测)→
  Task 1(schemaVersion/normalizeSettings 测试)+ Task 2(`resolveVoiceBackend` 五个用例,覆盖了设计
  文档要求的四种组合外加一个"两套模型都提供"的额外场景)。
- **占位符扫描**:全文没有 TBD/"补充实现"这类占位符;Task 3 里关于 `ipc.ts` 是否已有 `PetVoice`
  import 的不确定性,明确标注"执行时打开文件实地确认"而不是编造一个可能不对的现状,这是诚实标注,
  不是偷懒占位符。
- **类型一致性**:`TtsBackend`(Task 1)→ Task 2 的 `resolveVoiceBackend(petVoice, selected:
  TtsBackend)`、Task 4 的 `ttsBackend.value as TtsBackend` 一致;`VoiceBackendChoice`(Task 2)→
  仅在 Task 2 内部使用,没有跨任务传递,命名不会和别处冲突;`SettingsSnapshot.activePetVoice`
  (Task 3)→ Task 4 的 `snap.activePetVoice` 一致。特别检查:Task 2 删除了 Task 8(上一个计划)
  产出的 `shouldUseGenieBackend`,已确认全仓库没有其它文件 import 它(`src/main/shell/index.test.ts`
  是唯一的消费方,Task 2 本身就会重写这个测试文件)。
