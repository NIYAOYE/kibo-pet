# 语音(TTS)质量问题修复 — 设计

> 日期:2026-07-11 · 状态:待实现

## 1. 背景与问题

当前语音功能(GSV-TTS-Lite 集成,见 `2026-07-09-gsv-tts-lite-voice-integration-design.md`)存在四个用户反馈的缺陷:

1. **漏句**:部分文本完全不发音。
2. **Markdown 原样朗读 + 播放乱序**:模型回复的原始 Markdown 语法(`**`、`#`、`` ` ``、列表符等)被原样送去合成,发音古怪;并且存在"先播放了后面文本语音、再播放前面文本语音"的乱序现象。
3. **首次朗读慢**:宠物启动后第一次语音合成明显比后续慢。
4. **特殊符号乱读/不读**:数学符号、摄氏度等非 ASCII 符号发音异常或被跳过。

## 2. 根因(代码追踪结论)

### 根因 A —— 句子级 TTS 请求没有排队/串行化(解释问题 1、2 的乱序部分)

- [`chat.ts`](../../../src/main/shell/chat.ts) 在 `stream` 播放模式下,每凑齐一个句子就直接 `opts.voice.speak(sentence)`,不 await、不排队,句子间完全并发。
- [`voiceProvider.ts`](../../../src/main/voice/voiceProvider.ts) 的 `inFlight` 只是一个用于 `abort()` 的 `Set`,不是队列,无法保证完成顺序。
- [`gsv_server.py`](../../../resources/voice/gsv_server.py) 用 `threading.Lock` 把并发请求在 GPU 推理层面串行化,但**锁的获取顺序不保证 FIFO**——后到的句子完全可能先抢到锁、先开始流式吐音频。
- [`pcmPlayer.ts`](../../../src/renderer/voice/pcmPlayer.ts) 只按 IPC 消息到达顺序把音频排入播放队列,没有任何序号/乱序处理。

三层叠加:谁的合成先完成,谁先播,与原文顺序无关。"漏句"很可能是同一并发问题的另一表现——若某句合成出错(见根因 B),`voiceProvider.speak()` 直接 `catch` 后调 `onError` 结束,没有重试也没有"跳过"提示,这句话就悄无声息地消失了。

### 根因 B —— 全链路没有"发音前文本归一化"层(解释问题 2 的乱读部分、问题 4)

从 `sentenceSplitter.ts` → `voiceProvider.ts` → `voiceSidecar.ts` → `gsv_server.py`,没有任何一处剥离 Markdown 语法或做符号→可读文本的映射。模型吐出的 `**加粗**`、`# 标题`、`` `code` ``、`- 列表项`、℃/≥/× 等符号原封不动送进 GPT-SoVITS,发音异常或跳过是自然结果。

### 根因 C —— sidecar 启动后没有推理预热(解释问题 3)

[`gsv_server.py`](../../../resources/voice/gsv_server.py) 里模型 `load_gpt_model`/`load_sovits_model` 完成后立刻打印 `READY`,没有做一次真实推理来触发 CUDA kernel 编译/cuDNN 算法选择。这是 PyTorch/CUDA 的常见冷启动现象:模型权重上 GPU 很快,但第一次真实 forward 会因编译产生额外几秒延迟。

## 3. 修复设计

### 3.1 Speech Sequencer(修复根因 A)

新增 `src/main/voice/speechSequencer.ts`,插在 `chat.ts` 和 `voiceProvider` 之间。`chat.ts` 改为调用 `sequencer.enqueue(sentence)`,不再直接调 `voice.speak(sentence)`。

行为:

- 每次 `enqueue` 分配一个单调递增的 `seq`。
- 合成请求**最多同时 2 个在途**(当前应播放的 seq + 预取的下一个 seq)——有限度预取,不会无限并发压垮 sidecar。
- 当前"轮到播放"的 seq,其音频块立即转发给渲染层(真流式,当前播放句子无额外延迟)。
- 被预取的下一个 seq,其音频块先缓冲在内存里(单句音频,体量小);等当前 seq 播放完(`voice.speak()` 的 Promise resolve,无论成功或失败),游标推进,再按顺序把缓冲的音频一次性转发出去——因此**播放顺序永远等于文本顺序**,与合成完成的先后无关。
- 某句合成出错:视为"已完成、零音频",游标照常推进,不卡队列。
- `stop()`:中止所有在途合成请求、清空所有缓冲区、丢弃队列里所有尚未开始的句子——与现有"点击宠物打断语音"的语义(打断后剩余队列全部丢弃)保持一致。

接口改动:`VoiceProvider.speak()` 需要把 `onChunk` 从"构造时固定一份"改成**每次调用各自传入**,因为现在两句可能同时在合成,构造时固定的单一 `onChunk` 无法区分两句的音频块归属。相应更新 `voiceProvider.test.ts` 与 `chat.ts` 的三处调用点(stream 模式逐句、stream 模式收尾 `flush()`、batch 模式整段)。

### 3.2 可发音文本归一化(修复根因 B)

新增纯函数模块 `src/main/voice/speakableText.ts`,`toSpeakableText(raw: string): string`。

应用时机:对 sentenceSplitter **已经切出的完整句子**(以及 `flush()` 吐出的尾巴、batch 模式的整段回复)做转换,而不是对原始流式 delta 做——因为 Markdown 语法标记(如 `**`)可能被拆分到不同的 delta 里,在句子边界确定之后再统一处理才可靠。

规则:

- 围栏代码块 ` ```...``` ` 与行内 `` `code` ``:整体跳过不读。
- `**粗体**`、`*斜体*`/`_斜体_`:去掉标记,保留文字。
- `#`/`##`/`###` 标题、`-`/`*`/`1.` 列表符:去掉前导标记,保留文字。
- `[文字](url)`:只读"文字",丢弃 URL。
- 表格行(`|a|b|`、`|---|---|`):分隔行整行丢弃,数据行去掉竖线、单元格间用顿号类停顿连接。
- 符号映射表(常见数学/单位符号):

  | 符号 | 读作 |
  |---|---|
  | ℃ | 摄氏度 |
  | ℉ | 华氏度 |
  | % | 百分之 |
  | × | 乘 |
  | ÷ | 除以 |
  | ≥ | 大于等于 |
  | ≤ | 小于等于 |
  | ≠ | 不等于 |
  | ≈ | 约等于 |
  | ± | 正负 |
  | ° | 度 |

  （ASCII 的字母类单位如 km/kg 不处理,交给 GPT-SoVITS 自带的 g2p。范围以后发现遗漏再加,不追求一次覆盖全部。）

### 3.3 Sidecar 启动预热(修复根因 C)

`resources/voice/gsv_server.py` 里 `load_gpt_model`/`load_sovits_model` 完成之后、打印 `READY` 之前,用宠物自己的参考音频/文本跑一次真实的 `tts.infer_stream(...)`,消费并丢弃其输出,整体包 try/except——预热失败只打日志、不阻止服务启动。把 CUDA 编译成本移到 sidecar 启动阶段(本来就是一个有加载等待的阶段),而不是用户第一句真实回复。

## 4. 测试策略

- `speechSequencer.ts`:纯逻辑,用可控完成时机的 fake `speak(text, onChunk)` 单测——必须专门构造"句子 2 的合成先于句子 1 完成"的场景来验证播放顺序仍然正确(否则测试可能"侥幸"通过)。
- `speakableText.ts`:纯函数,每条规则/每个符号表驱动单测。
- sidecar 预热:无法单元测试(需要真实 Python/GPU),按项目既有惯例留给真机验收。

## 5. 范围之外

- 合成出错句子的重试机制(现有 `onError` 提示已足够,遵循既有模式)。
- 超出约定范围的更多符号(后续真机验收发现遗漏再补)。
