# 配音第二后端(Genie-TTS)接入 — 设计

> 2026-07-12 与用户 brainstorming 定下。现状:项目已有一套基于 **GSV-TTS-Lite** 的完整 TTS 集成
> (`src/main/voice/`,`resources/voice/gsv_server.py`),已合并到 `main`,真机验收过流式播放、
> 中日混读等问题,不是从零开始。本设计是在其基础上**新增第二个可选后端 Genie-TTS**
> (`https://github.com/High-Logic/Genie-TTS`,PyPI 包 `genie-tts`,本地已克隆到
> `D:\LProject\claude_Project\Genie-TTS` 供参考源码),两套后端长期共存、按宠物包自动切换。

## 1. 背景与目标

用户已经用上 GSV-TTS-Lite 的语音功能,但发现**语音运行时现场安装要下几个 G**(embeddable Python +
CUDA 版 torch + gsv-tts-lite 依赖 + 基础预训练模型)。Genie-TTS 是同样面向 GPT-SoVITS V2/V2ProPlus
模型的另一个轻量级推理引擎,**推理阶段完全基于 ONNX Runtime,不需要 torch**(torch 只在离线的
"模型转换"这一步才用得到),官方文档强调 CPU 上就能做到"近乎实时"的合成速度。首次运行只需下载约
391MB 资源文件,相比 GSV-TTS-Lite 的运行时体积小得多。

**目标**:新增 Genie-TTS 作为第二个 TTS 后端,和现有 GSV-TTS-Lite **并存、独立安装/卸载、按宠物包
自动选择**,让"只想用 Genie-TTS 系宠物"的用户完全不需要下载 torch/CUDA。落地时同时把现有
`pets/alice`(用户已有 `.ckpt`/`.pth` 模型)转换为 ONNX,作为端到端验收用例。

### 非目标(明确不做)

- 不做"运行时热切后端"——和现有"切换宠物需要重启应用"的约定一致,后端选择在应用启动时按 active
  宠物一次性决定。
- 不给 Genie-TTS 接入 GPU/CUDA 加速(`onnxruntime-gpu`)——只用 CPU,官方文档显示 CPU 性能已经足够,
  这也是保持"轻量"初衷的关键(装 CUDA 版依赖会把体积拉回接近 GSV-TTS-Lite 那一档)。
- 不给 Genie-TTS 暴露 speed/noiseScale/temperature/topK/topP/repetitionPenalty 这些生成参数——它的
  Python API(`tts_async`)根本不支持这些旋钮,Settings UI 在选中 Genie-TTS 后端的宠物时这部分控件
  应隐藏/置灰,而不是假装支持。
- 不合并两套后端的 Python 运行时环境——分开安装/卸载(见 §3),不共用一个 embeddable Python 目录。
- 不做"运行时自动把 .ckpt/.pth 转换成 ONNX"——转换是宠物包作者的开发时一次性操作(见 §6),不放进
  应用运行时流程,应用运行时只认已经转换好的 ONNX 文件。
- 不移植 Genie-TTS 自带的 `Server.py`(FastAPI + `audio/wav` 流式 HTTP 响应)、GUI、预定义角色下载、
  声纹相关功能——协议形态跟现有 SSE 管线不一致,而且大多是"推理前端",同 GSV-TTS-Lite 当初不用它
  自带的 `personal_api.py` 一个道理,自己写精简的 `genie_server.py`。

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 主进程 (Node)                                                             │
│                                                                           │
│  voiceProvider.ts / sentenceSplitter.ts / speechSequencer.ts /           │
│  translate.ts / languageDetect.ts / sseParser.ts    —— 完全不变,         │
│  这条上层管线本来就是后端无关的,只依赖抽象的 VoiceSidecar.speak()         │
│                                                                           │
│  startVoiceIfConfigured() —— 新增"选后端"这一步:                         │
│    读 petVoice.onnxModel ? 'genie-tts' : 'gsv-tts-lite'                  │
│    → 查该后端各自独立的运行时安装状态                                     │
│    → spawn 对应 python.exe + gsv_server.py / genie_server.py             │
│                                                                           │
│  voiceRuntimeInstall.ts(GSV,不变) / genieRuntimeInstall.ts(新增,更简单)  │
│                                                                           │
│         │ HTTP POST + 手写 SSE 帧解析(两个后端协议完全一致)               │
│         ▼                                                                │
│  ┌───────────────────────────┐   ┌───────────────────────────────────┐  │
│  │ gsv_server.py (不变)        │   │ genie_server.py (新增)              │  │
│  │ GSV-TTS-Lite 运行时目录里    │   │ Genie-TTS 运行时目录里              │  │
│  │ torch + gsv-tts-lite        │   │ genie-tts + onnxruntime(CPU)       │  │
│  └───────────────────────────┘   └───────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                          │ IPC(既有 contextBridge 模式,不变)
                          ▼
              渲染层 pcmPlayer.ts —— 完全不变(两个后端最终都吐
              32kHz/float32/base64 的 PcmChunk,协议层面无区别)
```

## 3. 两套独立运行时

`TtsSettings` 里现在单一的运行时字段拆成按后端分组:

```ts
export interface TtsSettings {
  enabled: boolean
  targetLanguage: TtsTargetLanguage
  playbackTrigger: TtsPlaybackTrigger
  synthesisChunking: TtsSynthesisChunking
  textSplit: TtsTextSplit
  gsvTtsLite: {
    runtimeInstallPath: string
    device: TtsDevice
    useFlashAttn: boolean
    isCutText: boolean; cutMinLen: number; cutMute: number
    speed: number; noiseScale: number; temperature: number
    topK: number; topP: number; repetitionPenalty: number
  }
  genieTts: {
    runtimeInstallPath: string
  }
}
```

顶层的 `targetLanguage`/`playbackTrigger`/`synthesisChunking`/`textSplit` 是应用自己的播放编排逻辑,
两个后端共用,不受后端切换影响。`gsvTtsLite`/`genieTts` 两个块各自独立的"安装位置/安装状态/marker
文件/导入导出压缩包"整套逻辑,用户可以只装其中一套,互不影响,互相卸载不影响另一套。

Genie-TTS 的安装步骤(新增 `runGenieRuntimeInstall`,结构照抄现有 `runVoiceRuntimeInstall` 但更简单):

```
download-python → enable-pip → install-genie-tts(pip install genie-tts,
  自带 onnxruntime CPU 版) → download-genie-data → done
```

跟 GSV 那套比,少了 `detect-gpu`/`install-torch`/`warm-start-models` 三步(合并简化成
`download-genie-data` 一步)——这正是体积缩水的来源。

### 3.1 `GENIE_DATA_DIR` 环境变量与交互式 prompt 的坑

`genie_tts` 包在 `Core/Resources.py` 的模块级代码里,如果发现 `GenieData` 目录不存在,会同步执行
`input("是否自动下载?(y/N): ")`。这是在 **`import genie_tts` 时**触发的,而 sidecar 是被 spawn 的
无 TTY 子进程,这个 `input()` 会直接抛 `EOFError` 让子进程在导入阶段崩溃退出,而不是卡住等待。

对策:
- `download-genie-data` 安装阶段显式设置环境变量 `GENIE_DATA_DIR=<安装目录>/GenieData`,并主动调用
  一次 `genie_tts.download_genie_data()`(非交互路径),确保 `GenieData` 目录在任何 sidecar 首次
  `import genie_tts` 之前就已经存在。
- 之后每次 spawn `genie_server.py` 时都要带上同一个 `GENIE_DATA_DIR` 环境变量,不能依赖包内默认的
  `./GenieData` 相对路径(相对于 cwd,对打包后的 Electron app 不可靠)。

## 4. 宠物包 `voice` 字段扩展

`PetVoice`(`src/shared/petPackage.ts`)扩展为:

```ts
export interface PetVoice {
  refAudio: string; refText: string          // 两套后端都需要
  gptModel?: string; sovitsModel?: string    // GSV-TTS-Lite 后端(可选)
  onnxModel?: string                          // Genie-TTS 后端(可选,ONNX 模型目录)
}
```

校验规则:`refAudio`/`refText` 必填;`onnxModel` 与 `{gptModel, sovitsModel}` 至少提供一组(可以两组
都提供)。后端选择在加载宠物包时决定:**优先 `onnxModel`(体积更小的 Genie-TTS),否则退回
`gptModel`/`sovitsModel`(GSV-TTS-Lite)**。若该宠物选中的后端运行时未安装,该宠物本次启动语音功能
不可用,并给出明确提示("该宠物需要 Genie-TTS 运行时,请到设置安装"),与现有"无 voice 字段则不可用"
的降级思路一致。

## 5. `genie_server.py`(新增)

结构与现有 `gsv_server.py` 同构:进程启动时按 active 宠物的 `voice/` 绑定一次角色和参考音频/文本,
暴露单一 `/speak` SSE 端点,请求方保持与现有 `SpeakRequest` 协议兼容(Genie-TTS 用不到的生成参数字段
直接忽略)。

启动时:
```python
genie.load_character(character_name, onnx_model_dir, language)
genie.set_reference_audio(character_name, ref_audio_path, ref_text, language)
```

`/speak` 处理:
```python
async for chunk in genie.tts_async(character_name, text, play=False, split_sentence=False):
    # chunk 是 int16 PCM bytes(genie_tts 内部 TTSPlayer._preprocess_for_playback 的输出)
    pcm_f32 = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
    # base64 编码后按现有 SSE 协议 emit: event: audio, data: {"audio": ..., "sampleRate": 32000}
```

`split_sentence` 固定传 `False`——上层 `sentenceSplitter`/`speechSequencer` 已经按句子切好了,每次
`/speak` 调用本身就是一句,不需要 Genie-TTS 内部再切一遍。

采样率固定 32000Hz,和现有 GSV 管线完全一致,不存在重采样问题;转换成 float32 base64 后协议与现有
`PcmChunk{audioBase64, sampleRate}` 完全一致,**渲染层 `pcmPlayer.ts` 不需要改动**。

## 6. Alice 模型转换(dev-time 工具)

`genie_tts.convert_to_onnx(torch_ckpt_path, torch_pth_path, output_dir)` 需要本地装 torch(仅转换时
用得到,不进入应用运行时)。落地为 `tools/` 下一个一次性小脚本(定位与 `tools/hatch-desktop-pet/`
一致——开发时资产生成工具,不是产品运行时代码):

```
python tools/convert-voice-to-onnx/convert.py \
  --ckpt "E:\GST\...\Alice_v2pro-e15.ckpt" \
  --pth "E:\GST\...\Alice_v2pro_e8_s1032.pth" \
  --out "pets/alice/voice/alice-onnx"
```

转换完成后给 `pets/alice/pet.json` 的 `voice` 块加上 `onnxModel: "voice/alice-onnx"`(相对宠物包目录
路径,与 `gptModel`/`sovitsModel`/`spritesheetPath` 的既有解析方式一致)。这一步产出作为本次工作的
端到端验收用例:装好 Genie-TTS 运行时 → 切到 alice 宠物 → 实际听到声音。

## 7. 接线改造

`startVoiceIfConfigured()`(`src/main/shell/index.ts`)按以下顺序改造:

1. 读取 active 宠物的 `manifest.voice`,无则不启用语音。
2. 决定后端:`petVoice.onnxModel ? 'genie-tts' : 'gsv-tts-lite'`。
3. 查该后端**独立**的运行时安装状态(`getGsvRuntimeState()` / `getGenieRuntimeState()`,分别对应
   `settings.tts.gsvTtsLite.runtimeInstallPath` / `settings.tts.genieTts.runtimeInstallPath`)。
4. 未安装则语音功能本次不可用(沿用现有"静默降级 + console.warn"惯例,不弹窗打断)。
5. 已安装则 spawn 对应脚本(`gsv_server.py` 带 gptModel/sovitsModel,或 `genie_server.py` 带
   onnxModel + `GENIE_DATA_DIR` 环境变量),后续 `voiceProvider`/`voiceSidecar`/IPC 转发链路不变。

Settings UI 需要两个独立的"运行时安装位置 + 安装状态 + 安装/导入导出"面板(复用现有面板的展示模式),
以及生成参数区在当前宠物选中 Genie-TTS 后端时隐藏/置灰(因为这些参数对它不生效)。

## 8. 测试策略

- `genie_server.py` 本身是 Python,不接入 Vitest,和 `gsv_server.py` 现状一致——只能真机跑通验证。
- TS 侧新增部分(后端选择逻辑、`PetVoice` 校验的新分支、`genieRuntimeInstall` 状态机)照抄现有 GSV
  对应模块的测试方式:纯函数 + 依赖注入,mock `InstallStepRunner`,不依赖真实网络/进程。
- 真机验收清单(agent 会话内无法验证,需要用户在真机跑):
  - Genie-TTS 运行时现场安装全流程(含 `GENIE_DATA_DIR` 首次下载不触发交互式 prompt 卡死)。
  - Alice ONNX 转换脚本实际跑通,产出可加载的模型目录。
  - 切到 alice 宠物,`onnxModel` 优先于 `gptModel`/`sovitsModel` 被选中,实际听到声音。
  - 两套运行时各自独立安装/卸载互不影响;只装 Genie-TTS 不装 GSV-TTS-Lite 时,GSV 系宠物语音功能
    正确降级不可用(不崩溃)。
  - 中/日/英混合文本在 Genie-TTS 后端下的发音效果(GSV 后端此前修过"目标语言强制发音"的 bug,
    Genie-TTS 是否有同样问题需要真机验证,`genie_server.py` 目前按 `language` 参数直接传给
    `load_character`,机制上类似但未验证效果)。

## 9. 风险与已知限制

- Genie-TTS 的生成质量/语速/情感表现力可能与 GSV-TTS-Lite 不同(毕竟是不同推理实现),真机对比是
  验收的一部分,不在本设计阶段评估。
- ONNX 转换目前只验证了 v2/v2ProPlus(`convert_to_onnx` 文档限定),纯 v2Pro(不带 ProPlus 特性)的
  模型转换兼容性需要在跑 Alice 转换脚本时实际验证。
