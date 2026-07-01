# src/renderer/voice — 音频播放(VoiceProvider 渲染端)

配音的"扬声器"。渲染端负责实际**播放音频**;选哪种嗓音、如何合成由主进程 [providers](../../main/providers/) 的 VoiceProvider 决定。

## 职责
- 播放预录片段(`clip`:宠物包 `voice/*.wav`)。
- 播放 TTS 合成音频(`tts`:主进程给到的音频流/文件)。
- 与气泡/口型动画对齐(播放时可触发 `talk` 动画)。
- `off` 模式下不发声。

## 交互
- ← [ipc](../../main/ipc/):接收"播放哪段音频"的指令(来自 [lines](../../main/lines/) / [agent](../../main/agent/))。
- → 当前宠物包 `pets/<id>/voice/`:读取预录片段。
- → [pet/](../pet/):播放时联动口型/说话动画。

> 阶段:配音为后期增强;MVP 仅预留结构,不实现播放。
