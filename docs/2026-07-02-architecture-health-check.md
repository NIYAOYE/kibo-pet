# Pet-Agent 架构体检报告

> 体检时间:2026-07-02 · 基线:MVP-03 已完成(commit `e2c8e44`,`develop` 分支)
> 体检范围:`src/` 全部源码 + 配置(electron.vite.config.ts / package.json)+ PROGRESS.md

---

## 总体结论

**架构是健康的,方向正确,不需要伤筋动骨的修改。** 分层清晰、安全基线扎实、抽象粒度与项目阶段匹配。但发现了 2 个真实 bug、1 个"新 clone 跑不起来"的隐患,以及 1 个 MVP-04 必然要面对的架构压力点。

---

## 一、做得好的地方

- **跨进程契约收敛在 `src/shared/`**:IPC 通道常量、DTO、三个 API 接口都在 `ipc.ts` 单一真源,主/preload/渲染三方都从这里导入,四文件联动的纪律执行得很好。
- **安全基线到位**:三个窗口全部 `contextIsolation:true, sandbox:true, nodeIntegration:false` + CSP(三个 html 都有);API key 只在主进程、safeStorage 加密落盘(`config/secrets.ts`);渲染层零文件访问(spritesheet 走 data URL)。
- **Provider 抽象最小而正确**:`providers/llmProvider.ts` 只有一个 `streamChat(): AsyncIterable<StreamChunk>`,三个实现各 ~30 行,工厂切换。这是对的粒度。
- **依赖注入贯彻得好**:`createChatStore` 收函数依赖、`createSecretStore` 收 `SafeStorageLike`、`runAgent` 收 provider——纯逻辑全部可测,47 个测试覆盖了该覆盖的。
- **`shared/petBrain.ts` 是纯 reducer**,渲染层 `petController.ts` 只做驱动,位置漂移用 `syncBounds` 自愈 + 主进程 clamp 兜底,双保险设计合理。

---

## 二、发现的问题(按优先级)

### 1. 真实 bug:取消在途回复后,流式缓冲区串台

`src/main/shell/chat.ts:44` — 新消息会 `cancel()` 在途请求,取消的结果**静默丢弃**(不发 `CHAT_DONE`/`CHAT_ERROR`)。但 `src/renderer/dialog.ts:14` 的 `streaming` 累积器**只在 onDone/onError 时清零**。

**后果**:回复 A 流到一半时发送消息 B,B 的回复会带着 A 的残留前缀显示在气泡和 streaming 消息里。

**修法**(很小):在 `onUpdate` 回调里重置 `streaming = ''`(onUpdate 恰好在每次新消息发出时触发),或让主进程取消时也补发一个 done。

### 2. 真实 bug:自定义 baseURL 用户重开设置窗再保存,provider kind 会被改错

`src/renderer/settings.ts:66-67` — 回填时用 `kind + baseURL` 精确匹配预设,匹配不到就回落 `PRESETS[0]`(Anthropic)。

**后果**:用户选了 openai-compat 预设但改过 baseURL(自建代理/中转很常见),重开设置窗后下拉显示成 Claude;此时直接点"保存",`kind` 会被写成 `'anthropic'`,之后 Anthropic SDK 去打 OpenAI 格式的端点。

**修法**:匹配不到时回落到"按 kind 匹配"而不是 `PRESETS[0]`,或加一个"自定义"选项承接。

### 3. 隐患:新 clone 直接跑不起来

`src/main/shell/index.ts:36` 硬编码 `petDir = pets/luluka`,而 `pets/luluka` 被 gitignore。fresh clone 上 `loadPet` 抛错 → `GET_PET` reject → 渲染层 `boot()` 整体失败,宠物不显示、无任何可见提示(只有 console)。这与"宠物包是可换肤"的架构意图也矛盾。

**建议**:至少加载失败时显示占位/提示;中期把 pet id 放进 settings.json,或跟踪一个极小的默认宠物包。

### 4. MVP-04 的真正架构压力点:流协议不支持工具调用

这是体检中最重要的前瞻项。当前 `StreamChunk` 只有 `text | done | error`,`ChatTurn` 只有纯文本 content,`agent/agentLoop.ts` 实际是"单次补全 + 护栏",不是循环。MVP-04 的 `web_search` 工具意味着:

- `StreamChunk` 要加 `tool_call` 类型(且 Anthropic 和 OpenAI 的 tool-call 流式增量格式差异很大,要在 provider 层归一化);
- `ChatTurn` 要能表达 assistant 的 tool_use 和 user 侧的 tool_result;
- `runAgent` 要变成真循环(调用 → 执行工具 → 回填结果 → 再调用,带轮数上限护栏)。

这不是现在的设计缺陷——现在的简单是对的。但 **MVP-04 写计划时应先定协议再动手**,因为它同时波及 `shared/llm.ts`、三个 provider、agentLoop、promptAssembler 五处。抽象边界选对了,扩展不需要推倒任何东西。

---

## 三、次要观察(记下即可,不急)

- **preload 的 `removeAllListeners` 模式**限定每通道一个订阅者,且三个窗口共用一个 preload、全量暴露三套 API(dialog 窗也拿得到 settingsApi)。同信任域内不算漏洞,但 MVP-06 §11 加固时值得做 sender 校验或按窗口收窄暴露面。
- **流式中途出错时,已流出的部分文本不进 transcript**(`chat.ts:76-80`),下次 render 会消失——如果是有意的 UX 取舍就没问题。
- **personaLoader 缓存永不失效**,改 persona.md 要重启应用;开发期可以接受,做养成系统前要处理。
- **transcript 无上限也无持久化**(重启即失忆)——MVP-05 分层记忆时自然解决,promptAssembler 里的记忆占位符已经留好了注入点,这点设计得不错。
- `ChatAttachment { kind:'image' }` 是无消费者的死类型,和账本里记的 `IPC.HAS_KEY` 一样,属于提前铺路,留着或删掉都行。
- `shell/index.ts` 是组合根,现在 136 行还好,但 MVP-04/05 的 IPC 都会往里加;到时候按域拆成 `registerChatIpc()` / `registerSettingsIpc()` 即可,现在不必动。

---

## 四、建议的行动顺序

1. **MVP-04 开工前**花半天清掉 #1、#2 两个 bug 和 #3 的失败兜底(都是小改动);
2. **MVP-04 计划阶段**把 #4 的流协议扩展作为第一个设计决策来做;
3. 架构本身不需要重构。
