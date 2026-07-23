# 本地 NLLB 翻译替换 LLM 翻译 —— 设计

> 日期：2026-07-23
> 状态：设计已确认，待写实现计划
> 前置文档：`2026-07-23-tts-translation-latency-design.md`（本设计是该文档路线 B/C 讨论后的最终选型，替代原文档 Phase 2-3 的流式翻译短语缓冲方案）

## 1. 背景

`2026-07-23-tts-translation-latency-design.md` 分析了朗读延迟的构成，路线 B（流式翻译+流式短语提交）被认为收益最大但实现复杂；后续联网调研发现，用**本地专用小型翻译模型**替换"调用聊天 LLM 做翻译"这一步，可以直接把翻译延迟压到可忽略量级，从而不需要 Phase 2-3 那套流式短语切分机制。用户确认采用这条路线。

设计过程中又确认了一个原文档未覆盖的硬约束：**朗读翻译时英文内容不能被翻译**（保留原文英文），因此目标语言 TTS 需要支持**中英/日英混合推理**——这直接影响两个现有 TTS sidecar（`gsv_server.py`/`genie_server.py`）的语言处理逻辑，不再是"只换翻译器、不动 TTS"的最小改动。

## 2. 目标与非目标

### 目标

1. 用本地 NLLB-200-distilled-600M 模型（CTranslate2 int8 推理）替换 `translate.ts` 里调用聊天 LLM 做翻译的默认路径，显著降低翻译环节延迟。
2. 本地模型未安装或推理失败时，静默回退到现有的 LLM 翻译，用户体验不中断。
3. 翻译时英文片段保持原文不译；对应地，GSV-TTS-Lite 与 Genie-TTS 两个 TTS 后端都要能在同一次朗读里正确混合发音中/日文与英文。
4. 保持现有"文字与语音同出"的顺序保证（`speechSequencer.ts` 的语义不变）。

### 非目标

- 不做逐 token 流式翻译或目标语言短语级流式提交（原文档 Phase 2-3 的方案）——本地模型推理已经足够快，整句输入整句输出即可。
- 不给用户提供"本地翻译 / LLM 翻译"的手动切换开关——本地优先、失败静默回退是唯一策略，用户无感知。
- 不提供翻译模型的 CUDA/设备选项——固定用 CPU。
- 不扩展 `zh`/`ja`/`en` 之外的语言范围。
- 不改变 GSV-TTS-Lite / Genie-TTS 的音色、口型同步协议或宠物包格式。

## 3. 模型与运行时

- **模型**：NLLB-200-distilled-600M，语言码 `zho_Hans`（zh）/`jpn_Jpan`（ja）/`eng_Latn`（en）。
- **推理引擎**：CTranslate2（int8 量化）+ `sentencepiece` 做分词，不引入 `transformers`/`torch`，延续 Genie-TTS 选型时"避免 torch 体积"的思路。
- **运行时安装**：复用现有 `genieRuntimeInstall.ts` 的 stage-based 安装模式（下载可移植 Python → 启用 pip → 安装 ctranslate2/sentencepiece → 下载 NLLB 模型，约数百 MB），新增对应的 `runTranslateRuntimeInstall`。
- **推理设备**：固定 CPU，不提供设备选项。

## 4. 组件架构

### 4.1 新 sidecar：`resources/voice/translate_server.py`

结构上模仿 `gsv_server.py`/`genie_server.py`（独立 HTTP 进程、独立端口、`http.server` 标准库实现，不引入 fastapi/uvicorn），但协议比两个 TTS sidecar 简单：不需要 SSE，单个 `/translate` POST 端点：

```
请求: { text: string, source: 'zh'|'ja'|'en', target: 'zh'|'ja'|'en' }
响应: { translation: string }  （同步 JSON，非流式）
```

### 4.2 生命周期：不跟宠物切换绑定

现有 GSV/Genie sidecar 的生命周期绑在"当前宠物"上（见 `petSession.ts` 的 `startVoice`，切宠物必须重启，因为音色模型文件不同）。翻译模型与宠物身份无关，同一个 NLLB 模型服务所有宠物，因此翻译 sidecar 在应用启动时起一次、常驻到应用退出，不随切宠物重启。生命周期管理放在比 `startVoice`（每次切宠物都跑）更高一层。

**失败语义**：
- sidecar 进程启动失败：只在应用启动时尝试一次，失败则整个会话期内固定使用 LLM 翻译，不随每句对话反复重试。
- sidecar 运行中但单次 `/translate` 请求超时（提案 5s）或报错：只影响当前这一句，立刻回退 LLM，不重启 sidecar、不影响后续句子继续尝试本地翻译。

### 4.3 Translator 组合

`translate.ts` 现有 `Translator` 接口不变：

```ts
export interface Translator {
  translate(text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal): Promise<string>
}
```

新增：
- `createLocalNllbTranslator(sidecarClient)`：实现 `Translator`，内部调用 `translate_server.py` 的 `/translate`。
- `createFallbackTranslator({ primary, fallback, isPrimaryAvailable })`：`isPrimaryAvailable()` 为 false 时直接用 `fallback`；`primary` 抛错或超时时对当前调用回退 `fallback`。

接入点：`petSession.ts:287`，把 `createLlmTranslator(translatorProvider)` 换成 `createFallbackTranslator({ primary: createLocalNllbTranslator(...), fallback: createLlmTranslator(translatorProvider), isPrimaryAvailable: ... })`。

### 4.4 源语言检测

NLLB 需要显式源语言码（不会自动识别）。`languageDetect.ts` 现有 `needsTranslation()` 只判断"文本是否已经是目标语言"，没有"这段文本本身是什么语言"。新增纯函数：

```ts
export function detectSourceLanguage(text: string): 'zh' | 'ja' | 'en'
```

复用同文件已有的 `CJK`/`KANA`/`LATIN` 正则做同样的启发式判断。只有本地翻译路径需要；LLM 翻译路径由模型自己识别源语言，不受影响。

## 5. 中英混合推理

### 5.1 共享分段函数

新增纯函数（提案位置 `src/main/voice/mixedLanguageSplit.ts`）：

```ts
export function splitByScript(text: string): Array<{ lang: 'en' | 'other'; text: string }>
```

按拉丁字母连续片段 vs 其他字符切分。翻译预处理、GSV 请求构造、Genie 请求构造三处共用同一份结果，避免在多处各写一遍类似正则、产生长期行为走样风险。

### 5.2 翻译预处理：拆段分别翻

用 `splitByScript` 切出的 `lang: 'other'` 片段各自独立送 NLLB 翻译（配合 `detectSourceLanguage` 判断源语言），`lang: 'en'` 片段原样保留，按原顺序拼回。

已知代价：英文嵌入较深的句子（如"我觉得 React 这个框架很好用"）会被拆成多个独立翻译的非英文片段，可能损失一部分整句语法连贯性。采用这个方案而非"占位符替换+整句翻译"，是因为占位符能否在 NLLB 里原样穿越（不被误译/拆字/丢失）目前无法在当前环境验证，拆段方案的行为更可预测。真机验证阶段如果发现译文明显生硬，可以作为后续迭代重新评估占位符方案。

### 5.3 协议改动：`SpeakRequest` 新增 `segments`

`voiceSidecar.ts` 的 `SpeakRequest`（现有 `text`/`language` 字段不变）新增：

```ts
segments: Array<{ lang: 'en' | 'zh' | 'ja'; text: string }>
```

由 `voiceProvider.ts` 在调用 `sidecar.speak()` 前统一用 `splitByScript` + 已知目标语言算好传入。`text` 字段本身继续保留、原样传完整文本——GSV 的 `infer_stream` 仍需要它做 `cutMinLen`/`cutMute` 流式分块切割，`segments` 只负责告诉 sidecar "这些子串各自该按什么语言发音"，两者是互补关系，不是新旧替代关系。

### 5.4 GSV-TTS-Lite：单次调用内消费 segments

现有 `_apply_language()`（`gsv_server.py:29-44`）为了修复"纯汉字、不含假名的日语行被 `LangSegment.getTexts` 自动检测误判成中文"这个问题，把整段文本强制按单一语言处理，副作用是顺带关掉了 `LangSegment` 原生的混合语言能力。

改法：不再依赖 `LangSegment` 自己猜测语言，直接用请求传来的 `segments` 构造 `LangSegment.getTexts` 的返回值（该函数本来的返回形状就是 `[{lang, text}, ...]`，等价替换）。因为目标语言已经由请求显式给出，不需要再让 `LangSegment` 去猜零散汉字行到底是中文还是日文，原问题和混合语言能力可以同时满足。单次 `infer_stream` 调用内完成，现有 `cutMinLen`/`cutMute` 等流式分块参数作用在这层之上，不受影响。

### 5.5 Genie-TTS：多次调用拼接

已通过实际查看 High-Logic/Genie-TTS 源码确认：该引擎的语言是**角色模型加载时定死的全局设置**，没有单次调用内逐段切换语言的能力（现有 `genie_server.py` 为了"按请求切换整段语言"已经是在改它的私有内部状态，见 `genie_server.py:85-97` 的注释）。

改法：`run()` 遍历 `segments`，每个 segment 切换一次 `model_manager.character_to_language`，单独调用一次 `genie.tts_async()`，产出的 PCM 按顺序连续写入同一个 SSE 流。对 `voiceSidecar.ts` 完全透明——仍然是"多个 audio 帧顺序到达"，不需要 TS 侧感知这是拼接产生的。

**已知风险**：这是全新机制，没有先例参照，多段拼接处可能出现音量/停顿突变。真机验证阶段需要重点听拼接处是否自然，如效果不理想可能需要后续加淡入淡出或段间静音过渡（本设计不预先实现，等真实听感反馈）。

### 5.6 与"文字语音同出"的关系

`speechSequencer.ts` 的顺序闸门逻辑不受影响——它只关心"这个源段的音频最终有没有到、有没有失败"，不关心 sidecar 内部是一次调用还是多次拼接产生的这些 PCM chunk。第 2 节确认的"整句进整句出、不做流式短语"结构继续成立，现有文字与语音同出的保证不因这次改动改变。

## 6. 设置与安装 UX

### 6.1 Schema

新增 `AppSettings.ttsTranslate: { runtimeInstallPath: string }`（形状照抄 `GenieTtsSettings`，只有安装路径，无开关），`SETTINGS_SCHEMA_VERSION` 15→16。

### 6.2 安装入口

设置页 TTS 区块，`tts.targetLanguage !== 'auto'` 且 `ttsTranslate` 运行时未安装时，显示安装提示条 + 安装按钮，复用 `genieRuntimeInstall.ts` 的 stage-based 进度上报模式。

## 7. 测试范围

- `detectSourceLanguage`、`splitByScript`、`createFallbackTranslator` 的组合/降级逻辑均为纯函数或可注入依赖的逻辑，按项目 TDD 约定写 Vitest：
  - 本地不可用 → 直接走 fallback
  - 本地超时/报错 → 仅当前句回退，不影响后续句
  - 本地成功 → 不触碰 LLM
  - `splitByScript` 对纯英文/纯中文/纯日文/混合文本的切分边界
- sidecar 安装流程测试仿照 `genieRuntimeInstall.test.ts` 的 fake step runner 模式。
- **真机专项**（无法在当前 sandbox 验证，需明确移交用户）：
  - NLLB 真实翻译质量、CPU 推理延迟
  - 完整安装流程（下载/pip/模型下载）
  - GSV 混合语言发音是否正确、自然
  - **Genie 多段拼接的音频衔接是否有明显瑕疵**（全新机制，优先级最高的真机验证项）
  - 翻译失败/超时回退 LLM 的真实触发路径

## 8. 明确不做的事

- 不做流式翻译或目标语言短语级流式提交（原方案 Phase 2-3）。
- 不提供翻译后端手动切换开关。
- 不提供翻译模型的 CUDA 选项。
- 不扩展 `zh`/`ja`/`en` 之外的语言。
- 不改变宠物包格式、口型同步协议、音色本身。
- 不实现占位符替换式整句翻译（英文保留通过拆段分别翻实现，见 5.2）。
