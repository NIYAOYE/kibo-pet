# TTS 后端手动选择 — 设计

> 2026-07-13 与用户 brainstorming 定下。承接前一天(2026-07-12)完成并推送的 Genie-TTS 第二语音后端
> 接入工作。用户真机验收时反馈:"语言选择界面中没有将两个方案区分,我甚至都不知道每次自己用的是哪
> 一个"——现有设计里后端是按`宠物包是否提供 onnxModel` 自动选择的(见
> `docs/superpowers/specs/2026-07-12-genie-tts-voice-backend-design.md` §4),用户用起来发现"看不出
> 用哪个"、也没法自己控制,要求把两套方案在设置页里明确分开、做成手动选择、每次只用一个。

## 1. 背景与目标

现状:`shouldUseGenieBackend(petVoice)` 纯按 `petVoice.onnxModel` 是否存在来决定用 Genie-TTS 还是
GSV-TTS-Lite,用户对这个"自动"选择完全没有可见性也没有控制权。alice 宠物包目前两套模型都提供
(2026-07-12 转换 Alice 模型时按用户要求两套都接了),自动选择下永远优先 Genie-TTS,用户无法验证/对比
GSV-TTS-Lite 的效果,也不确定当前到底在用哪个。

**目标**:把后端选择从"按宠物包内容自动判断"改成"用户在设置页手动选、全局生效",选中的后端对当前
宠物不可用时直接不可用(不静默回退到另一个),并让设置页在视觉上把两套方案的运行时安装区域明确分开。

### 非目标(明确不做)

- 不做"每个宠物记住自己上次用的后端"——本次确认是全局设置,跟 `tts.enabled`/`tts.targetLanguage` 等
  既有全局项一个层级,切换宠物不用重新选。
- 不做"选中的后端不可用时自动回退到另一个可用的"——用户明确要求不回退,选哪个就是哪个,不可用就是
  不可用,页面给清楚提示。
- 不改两套后端各自独立安装/独立运行时目录/独立 IPC 的既有架构(2026-07-12 设计的核心决策不变)——
  这次只改"选哪个生效"的判断方式和呈现方式,不动安装流程本身。
- 不做"同时装两个的时候顺带自动检测哪个更快/更省资源帮用户推荐"这类智能推荐——超出这次反馈的范围。

## 2. `AppSettings.tts.backend` 字段

`TtsSettings`(`src/shared/llm.ts`)新增一个字段:

```ts
export type TtsBackend = 'gsv-tts-lite' | 'genie-tts'

export interface TtsSettings {
  enabled: boolean
  backend: TtsBackend   // 新增,默认 'gsv-tts-lite'
  runtimeInstallPath: string
  // ...其余字段不变
}
```

放在 `tts` 里(不是新开一个顶层字段),因为它和 `enabled`/`targetLanguage` 一样是"语音功能整体的开关
类设置",不是某一个后端专属的参数(`runtimeInstallPath`/`device`/生成参数那些才是 GSV-TTS-Lite 专属,
早就该在 `tts` 里,历史遗留,这次不顺带重构)。默认值 `'gsv-tts-lite'`,保证老用户/老配置升级后行为不变
(升级前就是"只有 GSV-TTS-Lite 能自动选中",默认选它完全等价)。`SETTINGS_SCHEMA_VERSION` 照例
+1(13),`normalizeSettings` 按现有 `tts` 字段同样的"非法值回退默认"套路加一行归一化。

## 3. 后端解析逻辑:`shouldUseGenieBackend` → `resolveVoiceBackend`

现有 `shouldUseGenieBackend(petVoice): boolean`(`src/main/shell/index.ts`,2026-07-12 加的,带单测)
整个替换成:

```ts
export type VoiceBackendChoice = 'gsv-tts-lite' | 'genie-tts'

/** 按用户在设置里选的后端 + 当前宠物包实际提供的模型文件,解出这次要用哪个后端;
 *  选中的后端如果宠物包没提供对应模型文件,返回 null(不可用),不会退回另一个后端。 */
export function resolveVoiceBackend(petVoice: PetVoice, selected: TtsBackend): VoiceBackendChoice | null {
  if (selected === 'genie-tts') return petVoice.onnxModel ? 'genie-tts' : null
  return (petVoice.gptModel && petVoice.sovitsModel) ? 'gsv-tts-lite' : null
}
```

这是纯函数,替换掉原来那个纯函数,保持"独立导出、可单测覆盖最高风险分支决策"的既有原则
(2026-07-12 那次最终审查专门加固过这一点,这次延续)。

`startVoiceIfConfigured()`(`src/main/shell/index.ts:418-475`)里 `const useGenie =
shouldUseGenieBackend(petVoice)` 那一行,连同后面 `if (useGenie) {...} else {...}` 的分支条件,改成:

```ts
const backend = resolveVoiceBackend(petVoice, s.tts.backend)
if (backend === null) {
  console.warn(`[voice] 当前宠物不提供 ${s.tts.backend === 'genie-tts' ? 'Genie-TTS' : 'GSV-TTS-Lite'} 需要的模型文件,本次运行语音功能不可用`)
  return
}
if (backend === 'genie-tts') {
  // 原 if (useGenie) 分支内容不变
} else {
  // 原 else 分支内容不变
}
```

两个分支内部(spawn 对应 sidecar 那部分)完全不动,只是触发条件从"看 onnxModel 有没有"改成"看设置选了
啥 + 宠物包配不配合"。

## 4. Settings 快照扩展:让设置页知道当前宠物支持哪些后端

设置页要显示"选中的后端对当前宠物不可用"这类提示,需要知道当前 active 宠物的 `voice` 字段长什么样。
`SettingsSnapshot`(`src/shared/ipc.ts`)新增一个字段:

```ts
export interface SettingsSnapshot {
  settings: AppSettings
  hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean
  noPetInstalled: boolean
  activePetVoice: PetVoice | undefined   // 新增
}
```

两处 `IPC.GET_SETTINGS` handler(`src/main/shell/index.ts` 里 `startOnboarding` 和 `startShell` 各有
一个)分别填:引导模式(没有已装宠物包)那个固定给 `undefined`;`startShell` 那个用已有的
`loadPet(petDir)`(`startVoiceIfConfigured` 已经在用同一个函数)取 `manifest.voice`。

设置页(`settings.ts`)据此算出两个布尔量供 UI 用:

```ts
const supportsGenie = !!snap.activePetVoice?.onnxModel
const supportsGsv = !!(snap.activePetVoice?.gptModel && snap.activePetVoice?.sovitsModel)
```

## 5. Settings UI

语音页(`settings.html` 的 `data-page="voice"` 分区)顶部,`ttsEnabled` 开关下面,新增一个后端选择控件:

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

`settings.ts` 里:
- `currentTts()`/`applyTts()` 加上 `backend` 字段的读写(跟其余 `tts.*` 字段一样的处理方式)。
- 新增一个 `refreshBackendAvailability()`,在 `ttsBackend` 变化时 和 初始回填时都调用一次:根据
  §4 算出的 `supportsGenie`/`supportsGsv`,如果当前选中值对应的那个是 `false`,显示
  `ttsBackendUnavailable` 提示;否则隐藏。

两个运行时安装面板(现有的 GSV 卡片 + 2026-07-12 加的 Genie 卡片)**保持都可见**——用户可能想两个都
装好、随时切换,不做"只显示选中那个"的隐藏逻辑(那样谁想切换后端就得先去点选择器,可能会没装就切过去
发现用不了,不如两个都留着装,配合 §3 的"不可用就是不可用"直接看得懂)。但两个卡片各自的分节标题从现在
比较不起眼的 hint 文字,改成更醒目的小标题(比如卡片顶部加一行 `<h3>GSV-TTS-Lite 运行时</h3>` /
`<h3>Genie-TTS 运行时</h3>`),满足"两个方案分隔开、看得清楚"的诉求。

## 6. 测试策略

- `resolveVoiceBackend` 是纯函数,直接对着 §3 的四种组合(genie 选中且支持 / genie 选中但不支持 /
  gsv 选中且支持 / gsv 选中但不支持)写单测,替换掉 2026-07-12 给 `shouldUseGenieBackend` 写的那两个
  测试用例(在 `src/main/shell/index.test.ts`)。
- `normalizeSettings` 对 `tts.backend` 的归一化(缺省/非法值回退 `'gsv-tts-lite'`)照抄现有 `tts`
  其它枚举字段的测试写法。
- Settings UI 的可用性提示逻辑(`refreshBackendAvailability`)沿用现有惯例——渲染层 DOM 逻辑没有
  Vitest 覆盖,靠 `pnpm preview` 真机走查确认:切换后端选择器时提示能正确出现/消失。
- 真机验收(这次改动的核心目的就是解决真机反馈,所以这轮真机验收尤其重要):选 GSV-TTS-Lite 时确认
  用的确实是 GSV-TTS-Lite(可以通过音色/日志区分);切到 Genie-TTS 且已装运行时,确认真的切换生效;
  切到一个当前宠物不支持的后端,确认页面提示出现且语音功能确实不可用(不会静默用了另一个)。
