# MVP-03 设计文档 · 对话式 Agent 内核

- **日期**: 2026-07-01
- **状态**: 已评审通过(用户认可 + 拍板默认项),待写实现计划
- **范围**: MVP-03 —— LLM Provider 抽象 + 密钥安全存储 + 首启设置窗 + 对话式 agent 循环(先 fake 后真)+ 逐字流式 + §5.6 运行时护栏
- **上游**: 产品设计文档 `docs/superpowers/specs/2026-06-26-desktop-pet-agent-design.md` §5(Agent 内核)、§8(部署/首启)、§11(安全);MVP-02 spec/plan(状态机 + 对话框 + 主进程持有 transcript)

---

## 1. 目标

让宠物**真正用 LLM 对话**:替换 MVP-02 的占位回复,接上可插拔 Provider(用户填自己的 key),逐字流式回复,并有明确的运行时护栏。

**In scope:**
1. **LLM Provider 抽象** + 三实现:`FakeProvider`(离线可测)、`AnthropicProvider`(Claude)、`OpenAiCompatProvider`(OpenAI / 通义千问 / DeepSeek / Moonshot / 本地 Ollama 等兼容端点)。
2. **API key 安全存储**(Electron `safeStorage` / DPAPI)+ 非敏感设置(JSON,原子写,schemaVersion)。
3. **首启设置窗**:未配置时引导选 Provider + 填 base_url/model/key + 测试连接。
4. **对话式 agent 循环**:组装 system prompt(persona.md 分块 + 当前对话窗口)→ 调 Provider 流式 → 护栏 → 产出;支持取消。
5. **逐字流式**:token 增量推给对话框逐字显示,宠物 thinking→talk→idle 联动。
6. **§5.6 运行时护栏**:超时 / 预算 / 取消 / 重试 / 失败即状态。

**明确不做(留后):**
- **工具调用回灌**(agent 多轮 tool loop)、`web_search`、Skill 加载 —— **MVP-04**。Provider 接口预留可扩展空间,但本期不实现 tool round-trip。
- **Embedding / 分层记忆 / RAG 召回** —— **MVP-05**。prompt 组装里"召回记忆"的位置留空注释;设置窗不收集 embedding key。
- 台词库随机触发(Phase 2)、配音(后期)。

---

## 2. 现状与改动边界

MVP-02 已就绪(相关):
- `src/main/shell/chat.ts`:主进程持有 `ChatMessage[]` transcript;`handleSend` 目前调 `placeholderReply()`(读 `lines.json`/兜底串),发 `messageSent`/`replyDone`,经 `CHAT_UPDATE` 推整份 transcript 给对话框。**本期把占位回复替换为 agent 循环。**
- `src/shared/ipc.ts`:`ChatMessage`/`ChatSendPayload`/`ChatApi`/`CHAT_SEND`/`CHAT_UPDATE`/`PET_EVENT`/`DIALOG_SET_SIZE`。
- `src/renderer/dialog.ts`:双态 UI,`onUpdate(msgs)` 全量渲染。**本期加逐字流式渲染。**
- `src/main/` 预留空目录 + README:`providers/`、`agent/`、`config/`、`persona/`。
- `pets/luluka/persona.md`:已含 4 分块(Persona/Voice/Behavior/Tools)。

**关键约束(沿用):** CJS 主进程/preload(不加 `"type":"module"`);跨进程只经 preload 白名单;IPC 名走 `IPC` 常量;渲染安全三件套 + CSP;纯逻辑 TDD;真机 `pnpm preview` 验收;提交中文。

---

## 3. 拍板决策(用户已定)

- **Anthropic 预设默认模型 = `claude-haiku-4-5`**(快且省;设置里可改 `claude-sonnet-5`/`claude-opus-4-8`)。
- **未配置 → 提示去设置**:没填 key 时发送消息,回一句"先去设置里填下 Provider/Key~"并可一键打开设置窗;**不**退回 lines.json 占位(避免"已接大脑"的错觉)。
- **依赖:现在就装 `@anthropic-ai/sdk` + `openai` 两个官方 SDK**,两个适配器都用官方 SDK(流式/错误处理更稳)。

> Provider 技术事实(来自 claude-api 参考,已核对):Anthropic TS SDK `@anthropic-ai/sdk`,`new Anthropic({ apiKey, baseURL })`,`client.messages.stream({ model, system, messages, max_tokens })`,流式取 `content_block_delta` 的 `text_delta`;当前模型 ID `claude-haiku-4-5`/`claude-sonnet-5`/`claude-opus-4-8`(不加日期后缀)。桌宠默认**不开** extended thinking(要快)。OpenAI 兼容端用 `openai` SDK + `baseURL` 覆盖 + `stream:true`,取 `choices[].delta.content`。

---

## 4. 架构 / 模块地图

填充 `src/main` 预留目录;主进程编排,渲染层只负责 UI 与流式渲染。

```
src/shared/
  llm.ts             跨进程/纯类型:ChatTurn、StreamChunk、ProviderKind、ProviderSettings、AppSettings、schemaVersion
src/main/providers/
  llmProvider.ts     LlmProvider 接口
  fakeProvider.ts    确定性流式假 provider(TDD)
  anthropicProvider.ts   @anthropic-ai/sdk
  openaiCompatProvider.ts openai SDK(baseURL 覆盖)
  presets.ts         预设列表(label + kind + baseURL + 默认 model)
  createProvider.ts  依设置构造对应 provider(注入 key)
src/main/config/
  settings.ts        非敏感设置读写(userData/settings.json,原子写 + schemaVersion + 校验/迁移)
  secrets.ts         API key:safeStorage 加密,落 userData/secrets.bin;缺失/不可用降级策略
src/main/persona/
  personaLoader.ts   读 pets/<id>/persona.md 分块(缓存);纯解析函数可测
src/main/agent/
  promptAssembler.ts 纯函数:persona 分块 + 对话窗口 → { system, messages };记忆位留空
  agentLoop.ts       编排:组装 → provider.streamChat → 护栏(超时/预算/重试/取消)→ 逐 chunk 回调
src/main/shell/
  chat.ts            改:handleSend 走 agentLoop;未配置分支返回"去设置"提示;流式经新 IPC 推送
  settingsWindow.ts  首启/设置窗(独立 BrowserWindow)生命周期 + 定位 + 打开/关闭
  index.ts           组装 + 注册新 IPC;托盘加"设置"
src/renderer/
  settings.html / settings.ts   设置/首启向导 UI(独立第三渲染入口)
  dialog.ts          改:接收 CHAT_STREAM 增量逐字渲染 + CHAT_DONE/CHAT_ERROR
electron.vite.config.ts  renderer 加 settings.html 第三入口
```

**单元边界:** provider 各自独立、只依赖接口;`promptAssembler`/`personaLoader`/`settings`/`secrets` 都是可独立测的小单元;`agentLoop` 用注入的 provider(fake 或真)编排,护栏逻辑集中在此。

---

## 5. Provider 抽象层

### 5.1 类型与接口(`src/shared/llm.ts` + `providers/llmProvider.ts`)

```ts
// src/shared/llm.ts —— 跨进程纯类型
export type ProviderKind = 'fake' | 'anthropic' | 'openai-compat'
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ProviderSettings {
  kind: ProviderKind
  baseURL?: string       // openai-compat/anthropic 可覆盖
  model: string
}
export interface AppSettings {
  schemaVersion: number  // 迁移预留
  provider: ProviderSettings
  // 热键等其它偏好后续并入
}
```
```ts
// src/main/providers/llmProvider.ts
import type { ChatTurn, StreamChunk } from '@shared/llm'
export interface StreamChatRequest {
  system: string
  messages: ChatTurn[]
  maxOutputTokens: number
  signal: AbortSignal
}
export interface LlmProvider {
  streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk>
}
```
> 接口只吐**文本增量**;工具调用(MVP-04)将来通过在 `StreamChunk` 增加 `tool_use` 变体 + 请求里加 `tools` 扩展,不改现有调用方 —— 纯增量。

### 5.2 三实现
- **FakeProvider**:把一段固定/可注入文本按字符或词切片,用可注入的"时钟/延迟"逐片 `yield {type:'text'}`,末尾 `{type:'done'}`;`signal` 触发即停。**让 agent 循环/护栏/流式/动画联动全程离线单测**(先 fake 后真的 "fake")。
- **AnthropicProvider**:`new Anthropic({ apiKey, baseURL? })` → `client.messages.stream({ model, system, messages, max_tokens })`;迭代 stream,`content_block_delta.text_delta` → `{type:'text'}`;完成 `{type:'done'}`;异常 → `{type:'error'}`。默认不设 `thinking`。
- **OpenAiCompatProvider**:`new OpenAI({ apiKey, baseURL })` → `chat.completions.create({ model, messages:[{role:'system',...},...], stream:true, max_tokens })`;`choices[0].delta.content` → `{type:'text'}`。system 作为首条 system message。

### 5.3 预设(`presets.ts`)
一张表:`{ id, label, kind, baseURL?, defaultModel }`,例:
- OpenAI(`kind:'openai-compat'`, 默认 base_url 官方, `gpt-...`)
- 通义千问 DashScope 兼容(`openai-compat`, dashscope compat base_url, `qwen-...`)
- DeepSeek(`openai-compat`, deepseek base_url, `deepseek-chat`)
- Moonshot(`openai-compat`)
- 本地 Ollama(`openai-compat`, `http://localhost:11434/v1`, 用户填模型名)
- Claude(`anthropic`, 默认 `claude-haiku-4-5`)

用户选预设后可改 base_url/model/key;`createProvider(settings, key)` 依 `kind` 构造实例。

---

## 6. 配置与密钥(§11.2)

- **`config/secrets.ts`**:用 Electron `safeStorage.encryptString/decryptString`(Windows=DPAPI,无原生依赖)加密 key,密文写 `app.getPath('userData')/secrets.bin`。**绝不**写日志、settings.json、错误上报。`safeStorage.isEncryptionAvailable()` 为假时:不落明文,返回"当前系统不支持安全存储,暂不保存 key"由 UI 提示(会话内可临时用内存 key)。`hasKey()` 判断是否已配置。
- **`config/settings.ts`**:`userData/settings.json` 存 `AppSettings`(provider 选择/model/baseURL 等,**不含 key**)。读时校验 + 缺省填默认 + 按 `schemaVersion` 迁移预留;写用**临时文件 + 原子替换**。
- Provider 请求全部在**主进程**发出,渲染层永远拿不到 key(§11.1)。

---

## 7. 首启设置窗(§8.2)

- **独立 BrowserWindow**(第三渲染入口 `settings.html`),渲染安全三件套 + 自带 CSP;可获焦、可拖(沿用 MVP-02 对话窗做法或系统边框二选一,实现期定,倾向无边框圆角 + 顶部可拖区)。
- **首启逻辑**:主进程启动后若 `!hasKey()`,自动打开设置窗;托盘菜单加"设置"随时打开。
- **表单**:选预设 → 显示/可改 base_url + model → 填 key → **"测试连接"**(发一条最短 completion,成功/失败即时反馈)→ 保存(key 进 secrets,其余进 settings)。
- **未配置降级**:对话框在 `!hasKey()` 时发送 → 主进程回一条 pet 消息"先去设置里填下 Provider/Key 吧~",并可经 `OPEN_SETTINGS` 一键打开设置窗;不静默、不用 lines.json 占位。

---

## 8. Agent 循环 + Prompt 组装(§5.1 / §5.4 / §5.6)

### 8.1 流程(`chat.ts` + `agentLoop.ts`)
1. 用户消息 → `chat.ts` append transcript,`CHAT_UPDATE` 推回(渲染用户气泡),发 `PET_EVENT: messageSent`(宠物 thinking)。
2. 若 `!hasKey()` → 直接走§7 降级分支(去设置提示),结束。
3. 否则新建 `AbortController`(记为当前在途;若已有在途先 abort),调 `agentLoop.run({ transcript, signal, onChunk })`:
   - `promptAssembler.assemble(persona, transcriptWindow)` → `{ system, messages }`。
   - `provider.streamChat({ system, messages, maxOutputTokens, signal })`。
   - **宠物动画:** 用户消息即发 `messageSent`(宠物进入 `thinking`),并在**整个流式期间保持 `thinking`**;逐 chunk 经 `CHAT_STREAM` 增量推给对话框(逐字),累积成完整 pet 文本。
   - **结束:** pet 完整文本 append transcript,`CHAT_UPDATE` 定稿(与流式累积一致),发 `CHAT_DONE`;此时发 `PET_EVENT: replyDone`(宠物做一次 `talk` 收尾 → 回 `idle`)。
     > MVP-02 的 `talk` 状态有 `talkMs` 自动回 idle;流式时长通常大于它,故本期**不**在首 chunk 切 talk(否则会在流式中途提前回 idle),而是全程 thinking、结束再 talk 收尾。"流式期间播 talk"作为后续动画细化(需给 reducer 加'流式中'状态),本期不做。
   - **出错/超时/预算到:** 发 `CHAT_ERROR`(错误气泡),宠物回 `idle`(不卡 thinking);若已在途被新消息取消,旧流静默丢弃、不发 CHAT_ERROR。

### 8.2 Prompt 组装(`promptAssembler.ts`,纯函数,TDD)
```
system = [persona.Persona] + [persona.Voice] + [persona.Behavior] + [persona.Tools]
         + "\n\n[记忆召回:MVP-05 在此注入用户事实/工作记忆摘要]"(占位注释,当前为空)
messages = 当前对话窗口(最近 N 轮 user/assistant,转成 ChatTurn[])
```
- persona 分块由 `personaLoader` 从 `pets/<id>/persona.md` 解析(按 `#` 标题分块),缓存。
- 窗口大小 N 为常量(如最近 12 条),防止无限增长;**滚动摘要/长期记忆是 MVP-05**,此处只做窗口截断。

### 8.3 §5.6 运行时护栏(集中在 `agentLoop`)
- **超时**:provider 调用设总超时(如 60s 无进展即中止)——用 `signal` + 定时器。
- **预算**:单次交互 `maxOutputTokens`(如 1024)+ 总时长上限;逼近即收尾。
- **取消**:用户再次发送或关闭对话框 → abort 在途(旧流丢弃,不覆盖新态)。`chat.ts` 维护"当前在途 controller"。
- **重试**:仅幂等网络失败(连接错/5xx/429)有限次 + 退避,**由 agent 层统一**,provider 不各自重试(SDK 自带重试可关小或接受其默认,择一,实现期定)。
- **失败即状态**:任一环节失败 → `CHAT_ERROR` + 宠物回 idle;不留"卡 thinking"。
- 阈值均为**常量**,便于调。

---

## 9. 流式传输 IPC + 动画联动

新增通道(名进 `IPC` 常量):

| 通道 | 方向 | 类型 | 用途 |
|---|---|---|---|
| `GET_SETTINGS` | renderer(设置)→ main | invoke | 读当前 AppSettings + hasKey + 预设列表 |
| `SET_SETTINGS` | renderer(设置)→ main | invoke | 写 provider 选择/model/baseURL |
| `SET_API_KEY` | renderer(设置)→ main | invoke | 写 key(进 safeStorage);返回是否成功 |
| `TEST_CONNECTION` | renderer(设置)→ main | invoke | 用当前(或表单临时)设置发一条最短 completion,返回 ok/错误 |
| `OPEN_SETTINGS` | renderer → main | send | 打开设置窗(对话框"去设置"按钮/托盘) |
| `CHAT_STREAM` | main → renderer(对话) | send | 增量 token(逐字追加到进行中的 pet 气泡) |
| `CHAT_DONE` | main → renderer(对话) | send | 本轮回复结束(定稿) |
| `CHAT_ERROR` | main → renderer(对话) | send | 本轮失败(错误气泡 + 建议下一步) |
| `CANCEL_CHAT` | renderer(对话)→ main | send | 用户取消在途回复(关框/再次发送时) |

- `dialog.ts`:`CHAT_STREAM` 往"进行中的 pet 气泡"逐字追加(不整份重渲染);`CHAT_DONE` 落定;`CHAT_ERROR` 显错误气泡。常态薄条气泡仍显示最新 pet 文本(流式时实时增长)。
- `preload`:`chatApi` 扩展 `onStream/onDone/onError/cancel`;新增 `settingsApi`(仅设置窗用)。
- 所有新 IPC handler 校验 payload;`TEST_CONNECTION`/provider 调用只在主进程。

---

## 10. 依赖

- 新增(主进程用):`@anthropic-ai/sdk`、`openai`。用 `pnpm add`。渲染层不引入 SDK。
- electron-vite 主进程 external:确认这两个包在主进程 bundle 里按 node 模块处理(必要时加入 rollup external / build.rollupOptions.external),避免打进渲染层。实现期验证 `pnpm build` 通过。

---

## 11. 测试

- **纯逻辑 TDD(Vitest):**
  - `personaLoader`:markdown 分块解析(标题→块;缺块降级)。
  - `promptAssembler`:persona 分块 + 窗口 → system/messages 顺序与截断;记忆位为空。
  - `settings`:默认填充 / schemaVersion 迁移 / 原子写(可对临时目录)。
  - `agentLoop` + **FakeProvider**:流式 chunk 顺序正确;`signal` 取消能中止(不再产出);超时 → error;预算截断;错误 → CHAT_ERROR 语义。
  - `secrets`:可注入一个 safeStorage 假实现,测"可用→加密往返 / 不可用→降级不落明文"。
- **真 provider**:靠真机 `pnpm preview` + 手填 key(Anthropic 与一个 OpenAI 兼容端各验一次)肉眼验收流式与动画联动。**自动化过≠能跑**。

---

## 12. 安全基线复核(§11)

- **§11.1**:设置窗与对话窗都用 `contextIsolation/sandbox/nodeIntegration:false` + CSP;新 IPC 全校验;provider 客户端与 key 只在主进程,渲染层零接触。
- **§11.2**:key 走 `safeStorage`(DPAPI)加密;不写日志/settings.json/错误文本;`CHAT_ERROR` 文案不带 key/敏感头。
- **§11.3**:provider 调用是异步 I/O,不阻塞窗口/热键;主进程只做轻量编排。
- **来源标注(为 MVP-04/05 铺路)**:prompt 里 persona 是可信基底;将来工具结果/召回记忆注入时需标注来源、防注入(本期无外部不可信文本进 prompt)。

---

## 13. 识图/记忆接缝复述(非本期)

- **识图**:`ChatMessage.attachments?`(MVP-02 已留)+ Provider 多模态消息(将来在两个适配器各自映射);本期文本-only。
- **记忆**:transcript 已在主进程(MVP-02 接缝);MVP-05 在 `promptAssembler` 的空位注入召回,并在设置窗补 embedding key —— 本期都不做。

---

## 14. 交付物清单

- 新增:`src/shared/llm.ts`;`src/main/providers/{llmProvider,fakeProvider,anthropicProvider,openaiCompatProvider,presets,createProvider}.ts`(+ 相关测试);`src/main/config/{settings,secrets}.ts`(+ 测试);`src/main/persona/personaLoader.ts`(+ 测试);`src/main/agent/{promptAssembler,agentLoop}.ts`(+ 测试);`src/main/shell/settingsWindow.ts`;`src/renderer/settings.html`、`src/renderer/settings.ts`。
- 修改:`src/shared/ipc.ts`(新通道 + 类型 + settingsApi/chatApi 扩展)、`src/preload/index.ts`、`src/main/shell/chat.ts`(接 agentLoop + 未配置降级 + 流式)、`src/main/shell/index.ts`(注册新 IPC + 托盘"设置" + 首启弹窗)、`src/renderer/dialog.ts`(流式渲染)、`electron.vite.config.ts`(settings.html 第三入口)、`package.json`(加两个 SDK 依赖)。
- 文档:完成后更新 `PROGRESS.md`(勾选 MVP-03 + 现状 + 下一步 MVP-04)。
