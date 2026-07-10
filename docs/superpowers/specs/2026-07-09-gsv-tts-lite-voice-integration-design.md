# 配音(GSV-TTS-Lite 集成)— 设计

> 2026-07-09 与用户 brainstorming 定下。承接 ROADMAP.md「听得到声音」一节:此前曾接入 `minimal_tts`
> (GPT-SoVITS 推理包)做 TTS 档,代码完成、真机验收中修过两处真实 bug(`ws` 默认 `binaryType` 丢帧、
> 逐 token 流式导致卡顿),随后用户决定换用更快的推理方案,已把那次集成的全部代码从本地和远端整体撤回
> (`git revert`,详见 `.superpowers/sdd/progress.md`「语音功能」section 与内存 `pet-agent-status`)。
> 本设计是重新的一轮,后端换成 **GSV-TTS-Lite**(`https://github.com/chinokikiss/GSV-TTS-Lite`,已发布
> PyPI 包 `gsv-tts-lite`,基于 GPT-SoVITS V2/V2Pro/V2ProPlus 的高性能推理引擎),不是在旧代码基础上改,
> 是全新设计。

## 1. 背景与目标

用户已经:
- 克隆 `GSV-TTS-Lite` 到 `D:\LProject\claude_Project\GSV-TTS-Lite`,用 conda 建了 `GSV-TTS-Lite` 虚拟
  环境并验证项目本身能跑通(v2Pro 模型)。
- 新建了宠物包 `pets/alice/`(天童爱丽丝·女仆 ver.,已有 `pet.json`/`spritesheet.webp`/`persona.md`/
  `lines.json`/`README.md`,`voice/` 目录目前只有占位 `.gitkeep`)。
- 把参考音频 `Reference/ailisi_4.wav` 与参考文本 `Reference/Alice_reference_content.txt`(日语,
  "rpg で例えるなら上级色です メイド服に着替えると")放在仓库根目录(已加入 `.gitignore`)。
- 有 GPT 模型 `E:\GST\...\Alice_v2pro-e15.ckpt`、SoVITS 模型 `E:\GST\...\Alice_v2pro_e8_s1032.pth`。

**目标**:把 GSV-TTS-Lite 的推理能力(不含 WebUI/ASR/批量等推理前端功能)以「随宠物包切换」的方式接入
本项目的 VoiceProvider `tts` 档(设计文档 §5.5 早已预留但未实现的接口),覆盖 LLM 现场生成的对话回复;
支持中/日/英及其混合输出,支持宠物"嘴上说的语言"与"实际朗读语言"不同(经翻译);支持按字数/按标点两种
合成切分方式,支持流式跟随/等完整回复两种播放触发方式;暴露 GSV-TTS-Lite 的生成参数(语速/噪声比例/
温度/top_k/top_p/重复惩罚/切分相关)供调优;支持 v2/v2Pro/v2ProPlus 与 Flash Attention。

**新增的核心约束(区别于上次集成)**:最终用户(把打包好的 Pet-Agent 安装包装到自己机器上的人)**不需要
自己装 conda、建虚拟环境、跑 pip install** —— 语音运行时是一个自包含的可移植 Python 环境,由本项目自动
下载/安装,或从预先打好的压缩包导入。

### 非目标(明确不做)

- 不移植 GSV-TTS-Lite 的 WebUI(Gradio)、ASR 自动识别、批量推理、外链音频下载、`api_v2` 兼容层——这些是
  它自己的"推理前端",本项目只要最小的"给文本、吐音频"能力。
- 不支持"预录配音片段"(`lines.json` 的 `audio` 字段/VoiceProvider `clip` 档)——那是独立于本次的既有
  预留字段,继续保持"仅读入未播放"的现状,互不影响。
- 不做音色迁移(`infer_vc`)、声纹识别(`verify_speaker`)、多说话人融合——用不到。
- 不做运行时热切换 GPT/SoVITS 模型(`/set_gpt_weights` 类接口)——切换宠物本身就要求重启应用(既有约定,
  见 MVP-09),重启时按新的 active 宠物重新起 sidecar 即可,不需要热切换。
- 不做非 Windows 平台适配——沿用项目现有约定(仅 Windows)。
- 不做语音运行时的自动更新检查——版本不匹配时靠用户手动点"重新安装/重新导入"。

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ 主进程 (Node)                                                     │
│                                                                   │
│  voiceRuntime.ts   —— 运行时安装状态检测 / 现场安装(下载+pip)/    │
│                        压缩包导入导出                              │
│  voiceSidecar.ts   —— spawn Python 子进程(resources/voice/        │
│                        gsv_server.py)+ 生命周期(随 app 启动/退出)  │
│  voiceProvider.ts  —— chat.ts 的接线点:决定要不要翻译/按什么切分/  │
│                        按什么方式触发,调用 sidecar,把 PCM 块推给   │
│                        渲染层                                     │
│  translate.ts      —— 复用既有 LLM Provider 做整句翻译(仅在目标   │
│                        朗读语言 ≠ 检测到的回复语言时触发)          │
│                                                                   │
│         │ HTTP POST + 手写 SSE 帧解析(纯文本协议,无 ws 包)        │
│         ▼                                                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Python sidecar (语音运行时里的可移植 Python + gsv_tts)       │  │
│  │ resources/voice/gsv_server.py                              │  │
│  │ - 启动时按 active 宠物的 voice/ 绑定 GPT+SoVITS+参考音频/文本 │  │
│  │ - stdlib http.server 实现单一 /speak 端点(SSE)              │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          │ IPC(既有 contextBridge 模式)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ 渲染层                                                            │
│  src/renderer/voice/pcmPlayer.ts —— Web Audio API 播放 float32   │
│  PCM 块(32kHz 单声道),与既有流式聊天渲染并行、互不阻塞            │
└─────────────────────────────────────────────────────────────────┘
```

**为什么是 HTTP+SSE 而不是 WebSocket**:上次集成的 Critical bug 是 `ws` 包默认 `binaryType` 把真实音频
帧解析成了错误类型,静默丢帧。SSE 是纯文本协议(音频以 base64 包在 JSON 里),从协议层面排除了这整类
bug——主进程用 Node 内置 `http` 发起请求、手动解析 `text/event-stream` 帧,不引入 `ws` 或任何新的二进制
帧解析依赖。渲染层完全不碰网络,只通过既有 `contextBridge` 模式接收主进程转发的 PCM 块,符合本项目
"渲染层零文件/网络访问"的安全基线。

**为什么 sidecar 不需要运行时热切模型**:宠物包切换本身就要求重启应用(MVP-09 既有约定:`activePetId`
改变后按重启后生效)。因此"配音随宠物包走"只需要:应用启动时读取当前 active 宠物的 `voice/` 内容,
以此启动 sidecar 一次即可,不需要 GSV-TTS-Lite 的 `/set_gpt_weights`/`/set_sovits_weights` 热切换接口。

**为什么自己写 `gsv_server.py` 而不是直接跑 `personal_api.py`**:`personal_api.py` 自带 ASR(会额外
下载 Qwen3-ASR 模型)、外链音频下载、批量推理、`api_v2` 兼容层——都是本项目用不到的"推理前端"。我们只
写一个精简的 `/speak` SSE 端点,启动时一次性绑定该宠物的模型与参考音频/文本,请求参数只保留生成参数
(见 §5),不需要每次请求都传路径。为了让语音运行时尽量小、尽量少一环安装失败点,这个端点用 Python
标准库 `http.server`(`ThreadingHTTPServer`)手写,不引入 `fastapi`/`uvicorn`/`pydantic`/`starlette`——
唯一的调用方是本项目自己的主进程,请求形状固定,用不上它们的路由/校验/文档机制。

## 3. 语音运行时:两种获取方式

语音运行时 = 一个自包含的可移植 Python 目录(embeddable Python + pip 装好的 torch/gsv-tts-lite 等 +
GSV-TTS-Lite 自身首次会下载的基础预训练模型,如 chinese-hubert/chinese-roberta),落在用户可自选的
**安装位置**(见下),不依赖用户机器上是否装了 conda/系统 Python。

### 3.1 安装位置

Settings 新增"语音运行时安装位置"(原生文件夹选择对话框),默认建议 `userData/voice-runtime/` 但用户
可指向任意路径(例如空间更充裕的 D:/E: 盘)。一旦某个位置已完成安装,更换位置要求显式"重新安装/重新
导入"(在新位置重新走一遍安装或导入,不做静默的多 GB 文件夹搬家)。

### 3.2 现场安装(需要联网)

按顺序、每步都有阶段性进度文案 + 可展开的原始日志:
1. 下载 Python 官方 **embeddable** 发行版(约 10MB 的 zip,不是完整安装包,不改注册表/PATH)到安装
   位置。
2. 修补其 `._pth` 文件启用 `site`,跑 `get-pip.py` 启用 `pip`。
3. 检测 GPU(跑 `nvidia-smi`,存在则装 CUDA 版 torch:`pip install torch --index-url
   https://download.pytorch.org/whl/cu128`;不存在则装 CPU 版)。Settings 里的 `device` 下拉
   (`auto`/`cuda`/`cpu`)可覆盖自动检测结果。
4. `pip install gsv-tts-lite`(PyPI 已发布,依赖如 einops/transformers/jieba/pyopenjtalk-plus 等随之
   自动装好)。
5. 启动一次 sidecar 触发 `gsv_tts` 自身的基础预训练模型下载(`chinese-hubert`/`chinese-roberta` 等),
   等它完成——**"安装完成"意味着真的完成,不会在宠物第一次说话时才发现还要再下载一次**。
6. 写入版本戳标记文件(记录已安装的 `gsv-tts-lite` 版本等),后续启动靠这个文件判断"已安装"。

失败(网络中断、没有匹配的 GPU 驱动、杀毒软件拦截、磁盘空间不足等)在这一步要**明显报错 + 提供重试**,
不能安安静静地看起来像没反应——区别于"语音功能开关本身"启动失败时的静默降级(见 §7)。

### 3.3 导入压缩包(离线,推荐用于第二台机器/分享给他人)

Settings 里的"导入运行时压缩包"文件选择器:选一个提前打好的 `.zip`(内容与现场安装完成后的目录结构
一致,包含已装好的 embeddable Python + 全部 pip 包 + 已下载的基础预训练模型),直接解压到安装位置,
校验版本戳标记文件后即可用,完全不需要联网/pip。配套地,Settings 里有"导出运行时压缩包"(开发者/已
成功现场安装过一次的机器上使用),把当前已populate 好的目录打包成 `.zip` 供复用/分享。

## 4. 宠物包 `voice` 字段

`pet.json` 新增可选 `voice` 块(现有 `PetManifest` 类型里新增,`src/shared/petPackage.ts`):

```json
"voice": {
  "gptModel": "voice/Alice_v2pro-e15.ckpt",
  "sovitsModel": "voice/Alice_v2pro_e8_s1032.pth",
  "refAudio": "voice/ailisi_4.wav",
  "refText": "voice/ailisi_4.txt"
}
```

- 无 `voice` 字段 ⇒ 该宠物的 TTS 永远不可用,与全局开关无关(与 `lines.json` 可选 `audio` 字段的降级
  思路一致)。
- 四个路径都相对宠物包目录解析,与 `spritesheetPath` 的既有解析方式一致。
- `refText` 是纯文本文件(内容即参考音频对应的文本),`Reference/Alice_reference_content.txt` 的内容
  原样迁入 `pets/alice/voice/ailisi_4.txt`。
- 落地本次工作时,把 `Reference/ailisi_4.wav` 复制/链接到 `pets/alice/voice/ailisi_4.wav`,GPT/SoVITS
  模型从 `E:\GST\...` 复制/链接到 `pets/alice/voice/` 下对应文件名。这些大文件与 `pets/alice/spritesheet.webp`
  同等对待——`pets/alice` 已经整体 gitignore(与 `pets/luluka` 同规则),不需要额外的 `.gitignore` 改动。
- `get_sovits_weights` 会根据 checkpoint 内部结构自动识别 V2/V2Pro/V2ProPlus,不需要在 `pet.json` 里
  额外声明模型版本。

## 5. 设置 schema

`AppSettings.tts`(`schemaVersion` 8→9,新增字段迁移补 `tts` 默认值):

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 总开关;运行时未安装时开关仍可点,但会引导去完成安装 |
| `runtimeInstallPath` | string | `''` | 语音运行时安装位置(空 = 未配置,首次安装/导入前必须选) |
| `device` | `'auto'\|'cuda'\|'cpu'` | `'auto'` | 双重作用:①现场安装时决定 pip 装 CUDA 版还是 CPU 版 torch(`auto` = 按 `nvidia-smi` 检测结果);②sidecar 启动时透传给 `TTS(device=...)`,决定实际用哪个设备推理。两处用同一个设置值,改动后需重新安装/重启 sidecar 才生效 |
| `useFlashAttn` | boolean | `false` | 对应 `TTS(use_flash_attn=...)`;需要用户自行满足 README 里的 Flash Attention 安装前提(Windows 预编译 wheel) |
| `targetLanguage` | `'auto'\|'zh'\|'ja'\|'en'` | `'auto'` | `auto` = 直接朗读回复原文(含中日英混合,由 GSV-TTS-Lite 的 `LangSegment` 自动分段);否则先翻译成目标语言再朗读 |
| `playbackTrigger` | `'batch'\|'stream'` | `'batch'` | `batch` = 等 LLM 回复完整生成后一次性合成朗读(上次修复验证过的稳态行为);`stream` = 回复流式生成过程中,每凑齐一个完整句子就立即合成朗读该句 |
| `synthesisChunking` | `'token'\|'sentence'` | `'sentence'` | 映射 GSV-TTS-Lite 的 `stream_mode`:`token`=按字数切分,`sentence`=按标点切分 |
| `isCutText` / `cutMinLen` / `cutMute` | boolean / number / number | `true` / `10` / `0.3` | 对应截图的"是否切分文本"/"最小切分长度"/"切分静音时长" |
| `speed` / `noiseScale` / `temperature` / `topK` / `topP` / `repetitionPenalty` | number | `1` / `0.5` / `1` / `15` / `1` / `1.35` | 对应截图其余生成参数,逐字段透传给 `/speak` 请求 |

`gpt_cache`/`sovits_cache`(CUDA graph 静态缓存形状)不做 UI 暴露,维持库默认值——这两个只影响性能
上限,不影响正确性,不值得增加设置面板复杂度(若后续用户反馈现有默认在特定显卡上不理想,再单独加)。

Settings UI:沿用既有"语音"页面思路(此前 minimal_tts 集成时的页面骨架可参考,但内容全新),新增运行
时安装位置 + 安装/导入/导出三个按钮 + 进度展示,下方是开关/语言/触发方式/切分方式的下拉,再下方是可
折叠的"生成参数"面板(即截图内容原样对应)。

## 6. 文本处理管线(接入 `chat.ts`)

`chat.ts` 的 `handleSend` 成功路径里,`acc`(完整回复文本)已经在 `opts.memory.appendMessage({ role:
'pet', text: acc })` 处可用——这是 `batch` 模式的接线点。`stream` 模式额外在 `onText: (t) => { acc +=
t; ... }` 回调里维护一个"待发送缓冲区",每当缓冲区里出现完整句子边界(`。！？.!?…` 等标点或达到一定
长度上限兜底)就切出该句立即送去合成+播放,回复结束时把剩余不完整尾巴作为最后一段补发,避免丢字。

翻译判断(仅 `targetLanguage != 'auto'` 时生效):对拟朗读的文本段做一次廉价的脚本检测(按 Unicode
范围数假名/CJK 表意文字/拉丁字母各自占比),如果已经以目标语言为主就跳过翻译直接送去合成;否则调用
一次 LLM(复用现有 Provider,类似上次集成里的翻译辅助函数)把该段整体翻译成目标语言,再送去合成。

新消息发送或用户主动取消(`cancel()`)时,连带停止任何在播放/在合成队列中的语音(新增
`voiceProvider.stop()`,与既有的取消逻辑挂钩),避免新旧回复的语音重叠。

## 7. 生命周期与失败处理

- Sidecar 随应用启动时按 active 宠物尝试起(仅当该宠物有 `voice` 字段且 `settings.tts.enabled` 且
  运行时已安装);任何一个条件不满足则该次不起 sidecar,功能整体不可用,但不阻塞应用其余部分——与
  `desktopControl`/`browserControl` "未启用则相关能力从工具清单里消失"的既有习惯一致。
- Sidecar 启动失败(端口占用、Python 进程崩溃、模型文件缺失等)**静默降级**为"仅气泡文字,无语音"，
  在设置页给出一次性状态提示(如"检测:语音引擎未就绪"),不打断正常聊天体验——这是"功能开关"层面的
  失败处理,区别于 §3.2 "安装"这一步必须显眼报错。
- 应用退出时正常终止 sidecar 子进程(参考现有 automation 模块子进程生命周期管理的既有写法)。

## 8. 测试计划

纯逻辑部分走 Vitest(TDD):
- `pet.json` 的 `voice` 字段解析(有/无字段两种情况),沿用 `parsePetManifest` 现有测试文件扩展。
- 设置 schema 迁移(v8→v9 补 `tts` 默认值)。
- 句子边界切分逻辑(`stream` 模式下的"完整句子"判定,含结尾无标点兜底)。
- 翻译是否需要触发的脚本检测启发式(zh/ja/en 各自的判定用例)。
- SSE 帧解析(`event: audio\ndata: {...}\n\n` 文本协议的手写 parser)。
- 运行时安装状态检测(标记文件存在/版本匹配/不匹配三种情况)。

Python 端(`gsv_server.py`)与真实 GPU 推理不在 Vitest 覆盖范围内,和历次涉及真实 GPU/GUI 的功能一样,
**需要真机验收**——现场安装全流程(下载→pip→模型下载→sidecar 起来)、导入压缩包流程、中/日/英/混合
朗读、`targetLanguage` 触发翻译、`playbackTrigger` 两种模式手感、Flash Attention 开启后确实生效、
v2ProPlus 模型可用、断网/GPU 驱动缺失时安装步骤的报错清晰度,均待用户在真实机器上走查。

## 9. 遗留/后续(不在本次范围)

- 语音运行时的自动更新检测(§非目标已提)。
- 预录配音片段(`lines.json` 的 `audio`)与本次 `tts` 档的优先级/混用策略——按 §5.5 原设计"固定台词
  有 `audio` 就播预录,LLM 自由回复走 TTS",本次只做后半部分,前半部分维持"仅读入未播放"的现状。
- 多宠物同时装语音(目前只有 alice 一个宠物包会拿到 `voice` 字段;其余宠物包留空,行为上等同于关闭)。
