# src/main/providers — 提供方抽象(LLM / Embedding / Voice)

可插拔的"提供方"层,统一接口 + 内置预设,**用户填自己的 key**。屏蔽各家 API 差异,让上层只依赖抽象。

## 包含
- **LLM Provider**:对话补全 / 工具调用决策(Claude / OpenAI / 兼容 OpenAI 端点…)。
- **Embedding Provider**:文本向量化(默认在线,如 Qwen embedding;保留本地接口)。
- **VoiceProvider**:`clip`(预录片段)/ `tts`(实时合成)/ `off` 三模式,把文本解析为可播放的音频来源。

## 交互
- ← [agent/](../agent/):请求 LLM completion。
- ← [memory/](../memory/):请求 embedding 做写入/召回(RAG)。
- ← [lines/](../lines/):请求 VoiceProvider 把台词/回复解析为音频。
- ← [config/](../config/):读取当前选用的提供方与 API key。
