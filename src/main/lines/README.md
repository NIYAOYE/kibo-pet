# src/main/lines — 口癖台词库 + 事件分流(角色语言层)

加载当前宠物包的 `lines.json`,并实现**混合分流**:高频/氛围/事件场景走台词库(零延迟、零 token、离线、贴角色),真正的对话与干活交给 [agent/](../agent/) 的 LLM。

见设计文档 §5.5。

## 职责
- 加载并按事件 key 组织台词(`greet/idle/drag/sleep/task_done/...`)。
- 事件到来时选择:抽一条台词 or 转交 LLM。
- 若台词带 `audio` 或开启 TTS,请求 VoiceProvider 生成音频。

## 交互
- → 当前宠物包 `pets/<id>/lines.json` 与 `voice/`:读取台词与音频。
- ← [shell/](../shell/) / [agent/](../agent/):接收事件/状态变化(被拖拽、任务完成、待机…)。
- → [providers/](../providers/):经 VoiceProvider 解析音频来源。
- → [ipc/](../ipc/):把"气泡文本 + 可选音频"推给渲染层显示/播放。
