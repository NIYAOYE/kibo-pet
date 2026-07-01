# src/main/config — 设置 / 密钥存储 / 首次启动向导后端

集中管理用户配置与敏感凭据,并为首次启动的设置向导提供后端。

## 职责
- 读写用户设置(选用的 Provider、模型、热键绑定、当前宠物、语音模式等)。
- 安全存储 **API key**(LLM / Embedding / TTS)。
- **首次启动向导**后端:选 Provider、填 key、填 embedding key,完成即用。
- 数据落在用户目录,**卸载不丢**。

## 交互
- → [providers/](../providers/):提供当前 Provider 选择与 key。
- → [shell/](../shell/):提供热键、置顶/自启等偏好。
- ← [ipc/](../ipc/):接收渲染层设置界面的读写请求。
- → 用户数据目录:配置与 `pets/` 索引持久化。
