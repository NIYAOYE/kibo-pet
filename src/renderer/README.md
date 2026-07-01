# src/renderer — 渲染进程(躯壳 UI)

宠物的"身体和脸"。运行在 Electron 渲染进程,负责一切可见/可听的东西:精灵动画、对话框、语音播放。**不直接碰内核逻辑**——所有智能、记忆、工具都在 `src/main`,经 [ipc](../main/ipc/) 通信。

## 子模块
| 目录 | 职责 |
|---|---|
| [pet/](pet/) | 精灵动画 + 动画状态机(读 pet.json) |
| [chat/](chat/) | 对话框 / 气泡 UI |
| [voice/](voice/) | 音频播放(VoiceProvider 的渲染端) |

## 交互
- ↔ `src/main`(经 ipc):上报用户输入/拖拽/点击;接收回复、状态切换、气泡+语音指令。
- → `src/shared`:复用类型与状态枚举。
- → 当前宠物包 `pets/<id>/`:加载 `spritesheet.webp` 与 `pet.json`(动画),音频来自 `voice/`。
