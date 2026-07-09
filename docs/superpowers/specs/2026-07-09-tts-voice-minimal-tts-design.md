# 语音功能(minimal_tts 集成)— 设计

> 2026-07-09 与用户 brainstorming 定下。承接设计文档 `2026-06-26-desktop-pet-agent-design.md` §5.5
> 预留但从未实现的 `tts` VoiceProvider 模式。用户已用另一个项目(GPT-SoVITS)把 Alice 角色的语音
> 推理能力抽取成一个独立最小包 `minimal_tts`(`D:\LProject\claude_Project\minimal_tts`,
> `USAGE.zh-CN.md` 有完整对接说明),本次要把它接进桌宠,并让语音**跟随宠物包**。

## 1. 背景与目标

设计文档 §5.5 早就规划了"角色语言层":口癖台词(`lines.json`)+ LLM 对话回复,配合可插拔的
`VoiceProvider`,分 `clip`(预录片段)/ `tts`(实时合成)/ `off` 三档。`lines.json` 的 `audio`
字段和 `pets/<id>/voice/` 目录已经预留在数据结构里,但从未接线——本次实现 `tts` 档。

`minimal_tts` 是从上游 GPT-SoVITS 抽出的**推理专用**子集(见 §2 的验证结论),提供一个本地
loopback WebSocket 服务(`python -m service`)+ 一层现成的 Electron 客户端参考代码
(`electron/AliceTts.ts`/`PcmPlayer.ts`/`protocol.ts`),流式接收文本片段、流式吐出 PCM16 音频。

目标:
- 把 `minimal_tts` 接成本项目的 `tts` VoiceProvider。
- **语音跟随宠物包**:每个宠物可以有自己微调好的专属音色;没有专属音色的宠物回退到共享默认音色
  (当前只有 Alice 一份现成的微调权重)。
- 覆盖两类文本:LLM 对话回复 + `lines.json` 口癖台词。
- 朗读语言(中/日/英)可在设置里选,选非中文时对 LLM 回复现场翻译,对 `lines.json` 走预存的多语言
  文案(避免台词库失去"零延迟零 token 离线可用"的特性)。

### 非目标(明确不做)

- `clip` 预录音频模式(`lines.json.audio` 字段读了但仍不接线播放)——留给以后。
- 运行时热切换音色——换宠物仍然是"重启 app 生效",不额外做"不重启 app 就换声音"的路径。
- 语音识别 / 语音唤醒(设计文档 §2 本就明确排除)。
- 存量 4 个宠物包 `lines.json` 补日语/英语文案——这是内容工作,不在本次代码改动范围,后续单独做。
- 给 `minimal_tts` 做 `package_manifest.json` 的自动重新签发/校验流程——覆盖模型文件后不强制刷新
  manifest(服务启动本就不做哈希校验,只要求文件存在,见 §4)。
- 非 Windows 平台适配(项目目前整体只面向 Windows)。

## 2. `minimal_tts` 是否"最小":验证结论

实测确认 `minimal_tts` 符合它自己 `README.md`/`USAGE.zh-CN.md` 声称的范围:

- 目录里没有 `webui.py`、没有训练/微调脚本;`README.md` §10 明确列出排除项(训练/微调/WebUI/
  UVR/数据集准备/批量推理入口/任意模型路径 API),实地检查一致。
- 体积分布全部指向推理期必需资源,不是冗余:`GPT_SoVITS/text/`(668M)是 G2PWModel(中文多音字
  消歧,推理期要用);`models/`(1.8G)是 Alice 微调权重 + v4 base/vocoder + BERT + HuBERT;
  `python/`(5.5G)是内嵌 Python + torch/cuda/onnxruntime-gpu 运行时。整包裸装 **~8GB 级别**。
- `service/config.py` 强制"配置文件里的所有路径必须是包内相对路径,不能指向包外"
  (`resolved.relative_to(root)` 校验),不接受客户端在 WebSocket 请求里传任意模型路径——这是安全
  边界,也印证了它是个"固定结构的推理包",不是通用模型管理器。
- 唯一能扩展的方式是 §6.1 描述的"覆盖 `models/` 下的文件名 + 改 `config/alice.json`",这也是本设计
  "按宠物切换音色"要用到的机制(见 §4)。

结论:`minimal_tts` 已经是合格的最小 TTS 推理包,可以直接作为外部依赖对接,不需要再精简。

## 3. 整体架构

```
src/main/providers/tts/
  ├── ttsClient.ts        # 改编自 minimal_tts/electron/AliceTts.ts,去掉 "Alice" 专有命名,
  │                        # 依赖注入 Clock/spawn(仿 automation/automationControl.ts 的先例,
  │                        # 可用假子进程/假 WebSocket 单测状态机,不需要真的起 sidecar)
  ├── protocol.ts          # 原样复用 minimal_tts/electron/protocol.ts 的 wire 类型
  └── sentenceBuffer.ts    # 原样复用 minimal_tts/electron/SentenceBuffer.ts(句子切分缓冲)
```

这三个文件是薄 TypeScript 客户端代码(几 KB),**拷贝进本仓库、正常 git 跟踪**——它们只是"如何跟
sidecar 说话"的协议实现,不含任何模型/二进制。真正重的东西(`minimal_tts` 整个目录,~8GB)不进
git,处理方式与 `pets/luluka` 一致:磁盘上存在、`.gitignore` 排除、开发态从一个可配置路径读取、
打包态走 `electron-builder.yml` 的 `extraResources`。

`AppSettings` 新增:

```ts
export interface TtsSettings {
  enabled: boolean            // 默认 false
  language: 'zh' | 'ja' | 'en' // 默认 'zh'
  packagePath?: string        // minimal_tts 包根目录;不填时用约定默认路径
}
```

`SETTINGS_SCHEMA_VERSION` 递增一版,迁移逻辑补齐默认值(仿 `desktopControl`/`browserControl` 先例)。

主进程新增单例 `ttsProvider`(`src/main/providers/tts/index.ts`),职责:
- 开关生效时 spawn sidecar、建立 WebSocket、常驻;关闭开关 / app 退出时关闭(接入现有
  `app.on('will-quit', ...)` 清理链,与 `unregisterHotkeys()`/`scheduler.stop()` 等同一处)。
- 对外暴露 `speak(id, text, language)` 和 `cancel(id)`,内部按 §5 的规则决定走流式 token 还是整句。
- 找不到配置路径下的 `minimal_tts` 包时,开关在设置面板里置灰 + 提示,不尝试启动、不崩溃。

## 4. 宠物包音色约定

不改 `pet.json` schema(`voice/` 已是设计文档预留的兄弟目录)。约定:

```
pets/<id>/voice/tts/
  ├── gpt.ckpt        # 对应 minimal_tts 的 gpt_weight
  ├── sovits.pth       # 对应 minimal_tts 的 sovits_lora
  ├── reference.wav    # 对应 minimal_tts 的 default_reference
  └── voice.json       # { "promptText": "...", "promptLanguage": "zh"|"ja"|"en" }
```

四个文件同时存在才算"该宠物有专属音色";否则回退到 `minimal_tts` 自带的默认音色(当前是 Alice,
即 `minimal_tts/models/` 里原装的文件,不做任何覆盖)。

**切换时机**:app 启动时读 `activePetId`,若该宠物有专属音色目录:
1. 关闭正在跑的 sidecar(若已启动)。
2. 把 `gpt.ckpt`/`sovits.pth`/`reference.wav` 复制覆盖到 `minimal_tts/models/`(用固定文件名,
   与 `config/alice.json` 里引用的路径对应,不必每个宠物起不同文件名)。
3. 用 `voice.json` 的 `promptText`/`promptLanguage` 重写 `minimal_tts/config/alice.json` 里对应
   字段,其余字段(`sovits_base`/`vocoder`/`bert_dir`/`hubert_dir`/`version`)保持原样(共享 base
   权重不动)。
4. 重新 spawn sidecar(冷启动,模型重新载入,可能十几秒到一分钟)。

这一步只在 app 启动、且 `tts.enabled === true` 时执行一次,不做运行时热切换(换宠物仍需重启 app
生效,与 MVP-09 既有约定一致)。

**默认音色的回退备份**:`minimal_tts` 首次接入时,把包内原装的默认音色四份文件(`models/` 下对应
`config/alice.json` 引用的 GPT/SoVITS/reference 三个文件 + 原始 `config/alice.json` 内容)复制一份
只读备份到 `minimal_tts/models/_default_voice/`(新建目录,不影响 `service/config.py` 的路径校验,
因为它只在启动时读 `config/alice.json` 指向的那几个具体文件,不遍历 `models/` 目录)。之后:
- 目标宠物有专属音色目录 → 覆盖成该宠物的文件(§4 上文步骤)。
- 目标宠物没有专属音色目录 → 从 `_default_voice/` 备份覆盖回默认音色,**每次启动都执行**(不只在
  "从有专属音色的宠物切回默认"时做),避免依赖"当前 `models/` 里到底是谁的音色"这种隐式状态,
  逻辑简单、可预测、可测(纯函数:给定 `activePetId` + 宠物包内容 → 目标覆盖源固定是"该宠物的
  `voice/tts/`" 或 "`_default_voice/` 备份"二选一)。

## 5. 文本管线与语言处理

### 5.1 LLM 对话回复

- `tts.language === 'zh'`:直接复用 `chat.ts` 里已有的流式 delta 循环,把每个文本 delta 灌进
  `ttsProvider.speak` 的流式 token 接口(`begin` → 逐 token `pushToken` → 回复结束 `finish`),
  与文字气泡的流式渲染并行,不额外等待。
- `tts.language !== 'zh'`:不能流式。等 assistant 整句回复生成完毕(文字气泡该显示的都显示完)后,
  额外发起一次**非流式** LLM 调用,系统提示要求"把下面这段中文完整翻译成{目标语言},只回译文,不要
  解释",拿到译文整句后一次性 `begin(language) → pushToken(整句) → finish()`。这条路径本来就要
  多花一次 LLM 调用的 token 和几百毫秒到几秒延迟,已与用户确认可接受。
  - 翻译调用复用当前已配置好的 LLM provider(不引入新依赖),失败时静默降级为**不朗读**(文字气泡
    仍正常显示),不阻断对话本身。

### 5.2 `lines.json` 口癖台词

`Line` 类型扩展:

```ts
export interface Line {
  text: string
  text_ja?: string
  text_en?: string
  audio?: string  // 沿用既有字段,本次仍不接线播放(见非目标)
}
```

播放时按 `tts.language` 直接取现成字段(`text_ja`/`text_en` 缺失则回退用 `text`,即用中文原文
硬读——不现场翻译,保持台词库"零延迟零 token 离线可用"的特性)。存量宠物包补充 `text_ja`/
`text_en` 是后续的内容工作,不在本次代码范围。

### 5.3 打断/取消

对齐现有 `bubbleWindow`/聊天气泡的清理时机:新用户消息发出、对话框关闭、宠物切换台词分类时,
调用 `ttsProvider.cancel(id)` 打断正在合成/播放的语音,避免新旧内容串音(与 MVP-13 里聊天气泡
和瞬态台词互斥的既有不变式类比)。

## 6. IPC 与渲染层播放

仿 `PET_SPEAK`/`BUBBLE_LINE` 的既有单向推送模式,新增:
- `TTS_AUDIO_START` (id, sampleRate)
- `TTS_AUDIO_CHUNK` (id, 二进制 PCM)
- `TTS_AUDIO_DONE` (id)
- `TTS_AUDIO_CANCELLED` (id)

渲染层新增 `src/renderer/voice/pcmPlayer.ts`,逻辑照抄 `minimal_tts/electron/PcmPlayer.ts`(int16→
Float32、按 Web Audio 时钟调度、`cancel`/`close` 清理),但只经 preload 暴露的窄接口接收数据,
不直接碰 Node/文件系统——延续 `src/renderer/voice/README.md` 里"渲染端只播放,不决定音色/合成"
的既有职责划分。preload 新增 `voiceApi`(仿 `chatApi` 的 `onStream`/`onDone` 风格)。

## 7. 设置面板

新增一节(仿 `desktopControl`/`firecrawl` 现有交互模式,`src/renderer/settings.ts`):
- 总开关 `enabled`(默认关);找不到 `minimal_tts` 包时置灰 + 提示"未检测到语音包,请在下方填写
  minimal_tts 路径"。
- `packagePath` 输入框(可选,不填用约定默认路径:开发态 `<repo>/minimal_tts`,打包态
  `process.resourcesPath/minimal_tts`)。
- 朗读语言下拉:中文/日语/英语,默认中文。
- 无需 CUDA/CPU 选择——`minimal_tts` 自动探测,只在检测到 CPU 模式时提示"当前用 CPU 合成,速度会
  明显变慢"。

## 8. 依赖与打包

- 零新增 npm 依赖(不像 `browserAutomation` 引入 `playwright-core`——`minimal_tts` 是进程外的
  Python sidecar,主进程只用 Node 内置 `child_process`/`WebSocket` 与它通信)。
- `electron-builder.yml` 新增一条 `extraResources`,`from` 指向 `tts.packagePath` 约定的开发期
  位置,`to: minimal_tts`;比照现有 `pets`/`skills`/`resources` 三条已有条目的写法。
- `minimal_tts` 目录本身要在项目根 `.gitignore` 里加一条排除(比照 `pets/luluka`),避免 ~8GB 的
  Python 运行时和模型权重被意外 `git add`。
- 需要在实现计划里安排一次真实 `pnpm dist` 打包产物冒烟测试(参考项目记忆
  `packaged-gui-gpu-crash` 的教训:某些问题只在真实打包产物里出现),验证 `extraResources` 拷贝
  的 `minimal_tts` 在打包后依然能被主进程按 `process.resourcesPath` 正确定位并 spawn 成功。

## 9. 测试策略

- `ttsClient.ts`:仿 `automation/automationControl.ts`/`browserAutomation/browserControl.ts` 先例,
  依赖注入 `spawn`/`WebSocket`/`Clock`,单测覆盖:ready 行解析、启动超时、WebSocket 连接失败、
  `begin`/`pushToken`/`finish`/`cancel` 的消息序列、旧回复被新回复替换时的状态清理。不起真实
  sidecar。
- `sentenceBuffer.ts`:原样复用 minimal_tts 已有实现,如其本身没有覆盖到位可以直接搬运原有测试。
- `lines/linesLoader.ts`:扩展 `Line` 类型后的解析测试(`text_ja`/`text_en` 缺省/存在两种路径)。
- `chat.ts` 里的语言分支逻辑:zh 走流式、非 zh 走"等待整句→翻译→整句合成"分支,用假 LLM
  provider + 假 `ttsProvider` 单测两条路径都正确触发,翻译失败时静默降级不阻断对话。
- 音色切换文件覆盖逻辑(§4 的复制+改配置):纯函数单测"给定 activePetId 和宠物包内容 → 应该
  拷贝哪些文件、config/alice.json 应该变成什么内容",不需要真的起 Python 进程。
- **真机验收清单**(自动化覆盖不到,需人工在真实 Windows + CUDA 环境执行):
  - 开启开关 → sidecar 成功拉起(有 ready JSON,`device: cuda`)→ 关闭开关后 sidecar 进程真的退出、
    没有孤儿进程。
  - 找不到 `minimal_tts` 包时开关置灰 + 提示文案清晰。
  - 中文对话:流式打字动画与语音播放大致同步、打断新消息时旧语音立即停。
  - 切到日语/英语:整句延迟明显但语言/发音正确、翻译失败(如断网)时静默退化为纯文字气泡。
  - 换到有专属音色的宠物(目前只有能配出 Alice 专属音色目录的那一个)重启 app → 确认声音变了;
    换到没有专属音色的宠物 → 确认回退到默认音色而不是残留上一个宠物的声音。
  - `lines.json` 口癖台词朗读:中文默认可用;`text_ja`/`text_en` 缺失时优雅回退读中文原文。
  - 打包产物冒烟(§8):`pnpm dist` 产物里语音功能可正常开启使用。
