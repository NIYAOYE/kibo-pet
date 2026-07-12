# 应用焦点 · LLM 实时开场白 — 设计文档

> 2026-07-12 与用户 brainstorming 定下。承接 [2026-07-11-app-focus-awareness-design.md](2026-07-11-app-focus-awareness-design.md) §2 明确列为非目标的一项（"LLM 实时生成吐槽——本 MVP 只做预写台词库路径"）。触发契机：用户觉得当前"一问一答"式聊天窗和"随机抽台词池"式日常反应，本质是同一个问题——都不像宠物在真的观察你，而更像调用一个固定素材库。这次只解决其中最具体、信息量最大的一个触发点：应用焦点切换。

## 1. 背景与问题

`app_focus` 规则命中后，目前固定从 `lines.json` 对应规则的 `lines` 池里随机选一句预写台词（见上一份设计文档 §5-6）。这条路径信息量最大——它知道用户切到了哪个具体应用/网页——但输出永远是宠物包作者预先写好的几句话，用久了就会被认出"又是那几句"。

本设计只做一件事：`app_focus` 命中时，**可选地**改由配置好的 LLM 现场生成一句话，而不是查表选词；生成失败或功能未开启时，无缝退回原有预写台词池。不改变"何时触发"（沿用现有 `minGapMs`/`ruleCooldownMs` 双层冷却），只改变"触发后说什么、这句话从哪来"。

## 2. 目标与非目标

**目标（本轮）**
- 新增设置项 `appFocusLlmOpener.enabled`（默认 `false`）。开启后，`app_focus` 命中时优先尝试让 LLM 生成一句贴合当前应用/窗口标题的开场白。
- 生成失败（无 provider/无 key/网络错误/超时/空结果）→ 静默退回 `pickFromPool(rules[i].lines, ...)`，行为与关闭该功能时完全一致，不额外报错、不影响 `app_focus` 的可靠性。
- 生成内容依然只进瞬时气泡（`showAmbientLine`），不写入 transcript/记忆、不打开对话框——不改变现有"聊天 vs 日常台词"两条 UI 路径的既有划分。
- 复用当前对话框聊天已配置的 provider/apiKey/model，不新增一套 LLM 配置。

**非目标（留给以后，YAGNI）**
- ❌ 其余触发点（idle/click/drag/greet/farewell/afk/break）的 LLM 化——命中频率高、单次信息量小，性价比低，本轮明确不做（brainstorming 时已确认范围只到 `app_focus`）。
- ❌ 气泡可交互升级为对话（brainstorming 时确认：气泡依然是"说完即收"，不做成可以直接在气泡里回复继续聊天）。
- ❌ 生成内容写入长期记忆/transcript——保持"用完即弃"的边界，只是把弃之前多绕了一次网络请求。
- ❌ 每条 `app_focus` 规则单独可配置是否允许 LLM 化——本轮是一个全局总开关；如果某类应用不想被发给 LLM，用户可以选择不为它写 `app_focus` 规则（规则本身就是白名单）。
- ❌ 设置面板里做"确认弹窗"式的强仪式开关（对比 `desktopControl`）——brainstorming 时已确认风险等级更接近 `firecrawl`（只是把一段文本发给已经配置好的 LLM，不涉及操控鼠标键盘/文件系统），用普通 checkbox + 说明文字即可。

## 3. 架构

| 单元 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `contextualLineGenerator` | `src/main/context/contextualLineGenerator.ts`（新增） | 拼一个极简 system prompt（persona 摘要 + "用一句话搭话，不解释不加引号"的指令），把 `processName`/`windowTitle` 作为 user content，调用 provider 拿到单行文本；任何失败都返回 `null` | `loadPersona`、`createProvider`、新增的单次补全封装（见 §4） |
| `appFocusWatcher`（扩展） | `src/main/context/appFocusWatcher.ts:145-152` | 命中规则时，若 `appFocusLlmOpener.enabled` 且 provider 已配置 → `await generateContextualLine(...)`；拿到非空结果就用，否则回退 `pickFromPool` | `contextualLineGenerator`、现有 `pickFromPool` |
| `settings`（扩展） | `src/shared/llm.ts`（类型 + `DEFAULT_SETTINGS` + `SETTINGS_SCHEMA_VERSION`）、`src/main/config/settings.ts`（`normalizeSettings` 缺省兜底） | 新增 `AppSettings.appFocusLlmOpener: { enabled: boolean }`，默认 `{ enabled: false }`；`SETTINGS_SCHEMA_VERSION` 10 → 11 | 现有 `DesktopControlSettings`/`FirecrawlSettings` 同款形状（均定义在 `llm.ts`） |
| 设置窗（扩展） | `src/renderer/settings.ts`/`.html` | 新增一个 checkbox + 说明文字（仿 firecrawl 的"启用"控件样式），文案明确写"命中规则时会把当前应用名/窗口标题发送给你配置的 LLM 服务商" | 现有表单读写模式 |

**数据流**：`appFocusWatcher` 采样到前台窗口变化 → 匹配规则 → 双层冷却检查通过（与今日一致）→ **新增分支**：若开关开启且有可用 provider，`generateContextualLine({persona, processName, windowTitle, provider, apiKey, model})` → 5 秒超时 + 单次非流式补全 → 成功则得到一行文本，失败/超时/空 → `null` → 用 `pickFromPool` 兜底 → 结果通过既有 `onMatch(line)` 回调交给 `shell/index.ts`，后续路径（`pendingAppFocusText` 暂存 → `IPC.CONTEXT_SIGNAL` → 渲染进程叫醒/`stepReaction` → `PET_SPEAK` → `showAmbientLine`）完全不变，因为 `onMatch` 拿到的仍然只是一个 `Line{text}`。

`onMatch` 目前是同步回调，改为可以是 `async` 回调（内部 `await` 生成结果后再调用），`appFocusWatcher` 的轮询 `setInterval` 循环里对应位置改成 `await` 这一步——因为已经是 `async` 上下文（现有代码已 `await execFile(...)`），不需要额外改造轮询机制本身。

## 4. 单次 LLM 补全封装

现有 `LlmProvider` 接口只有 `streamChat(req): AsyncIterable<StreamChunk>`（多轮工具调用取向），没有"来一句话就好"的轻量入口。新增：

```ts
// src/main/context/contextualLineGenerator.ts
export async function generateContextualLine(opts: {
  personaText: string          // loadPersona(petDir).persona，直接用，不走 promptAssembler 全套
  processName: string
  windowTitle: string
  provider: LlmProvider
  timeoutMs?: number           // 默认 5000
}): Promise<string | null>
```

内部：组装 `system = personaText + "\n\n用一句话，以你的口吻自然地对用户此刻在做的事搭话或吐槽。不要加引号，不要解释，只输出这一句话。"`，`messages = [{role:'user', content: `用户刚切换到：${processName} / ${windowTitle}`}]`，`maxOutputTokens` 设小（如 60），`tools` 留空。用 `AbortController` 包一个超时；调用 `provider.streamChat(req)`，只攒 `'text'` 类型的 chunk，遇到 `'error'` 或超时直接 `return null`；正常结束后把攒到的文本 `trim()`，空字符串也视为 `null`。

失败路径全部走 `return null`（不抛异常）——调用方 `appFocusWatcher` 不需要 `try/catch`，只需要判断返回值，与项目里"错误回灌不终止/坏数据跳过不报错"的一贯降级哲学一致。

## 5. 设置与隐私边界

- `AppSettings.appFocusLlmOpener: { enabled: boolean }`，默认 `{ enabled: false }`，类型与默认值加在 `src/shared/llm.ts`（`DesktopControlSettings`/`FirecrawlSettings` 所在处）。`SETTINGS_SCHEMA_VERSION`（同文件，10 → 11）沿用现有"新增字段+防御性默认值"模式（`src/main/config/settings.ts` 没有显式版本化迁移函数，靠 `normalizeSettings` 兜底缺省值）。
- 设置窗新增一个 checkbox（仿 `firecrawl.enabled` 的 UI 写法，不做 `desktopControl` 那种原生确认弹窗），说明文字直接点出隐私影响：**"开启后，命中应用焦点规则时会把当前应用名/窗口标题发送给你配置的 LLM 服务商，用来生成开场白（而非使用宠物预设台词）。默认关闭。"**
- 这是 `docs/making-a-pet.md:146`（"窗口标题只在内存里用于匹配，用完即弃，不会被记录、发送或喂给 LLM"）这句话第一次被打破的地方——需要同步更新该文档，明确写清楚："默认情况下仍然如此；只有用户在设置里显式打开『应用焦点 LLM 开场白』时，才会把命中规则时的应用名/窗口标题发送给已配置的 LLM 服务商。"
- 暴露面本身有界：只有作者在 `lines.json` 里写了 `app_focus` 规则的应用才会命中判定（规则本身就是白名单），不是"任意前台窗口都发给 LLM"；再叠加 `minGapMs`/`ruleCooldownMs` 双层冷却，实际请求频率很低。
- 不写入 transcript/factStore/日志——生成的文本只用于当次气泡展示，用完即弃，和预写台词池路径的落地方式完全一致。

## 6. 兜底与容错

- provider 未配置（没测试连接过/没 key）→ `appFocusWatcher` 在调用 `generateContextualLine` 之前先检查，若没有可用 provider 直接跳过 LLM 分支，走 `pickFromPool`（不浪费一次必然失败的调用）。
- 网络错误/超时/API 拒绝/空文本 → `generateContextualLine` 内部吞掉，返回 `null`，外层退回 `pickFromPool`。
- 不重试——`app_focus` 本身已有 20s/15min 双层冷却，重试只会让下一次真实触发的间隔变得不可预期，宁可这次退回预写台词，下次命中再试。
- 宠物包对应规则的 `lines` 池为空数组 → `pickFromPool` 返回 `null`（现有行为），此时 LLM 分支即使失败也没有更差的兜底可用，与今天规则配了但 `lines` 写空数组的行为一致（不触发）。

## 7. 测试策略

- **`contextualLineGenerator`**（新 Vitest 文件）：用注入的 fake provider（仿 `providers/fakeProvider.ts`）覆盖——正常返回单行文本被 `trim()`；`error` chunk → 返回 `null`；空字符串结果 → 返回 `null`；超时（fake provider 故意不产出 `done`）→ 返回 `null`；system prompt 拼装包含 persona 文本与固定指令片段（字符串断言，不做语义判断）。
- **`appFocusWatcher`**（扩展现有测试文件）：
  - 开关关闭 → 命中规则直接走 `pickFromPool`，不调用生成函数（用 spy 断言未调用）。
  - 开关开启 + 生成函数注入返回文本 → `onMatch` 收到该文本而非池内文本。
  - 开关开启 + 生成函数注入返回 `null` → `onMatch` 收到 `pickFromPool` 的结果（兜底路径）。
  - 覆盖"发起生成调用前，冷却状态（`msSinceLastFire`/`ruleLastFiredMsAgo[i]`）必须已经落定"——这是一条判别性测试：如果实现错误地把状态更新挪到 `await` 之后，构造"发起第一次调用但尚未 resolve 时，再采样到同一规则命中"的序列，能看到实现 bug 会重复触发，正确实现会被冷却压住。
- **`settings`**：`appFocusLlmOpener` 默认值、`normalizeSettings` 缺省补全、schemaVersion 提升不破坏旧 settings.json 读取（沿用现有迁移测试模式）。
- **真机验收**（`pnpm dev`/`pnpm preview`，项目既有约定，无 Electron GUI 自动化驱动）：
  - 关闭状态下 `app_focus` 行为与今天完全一致（回归检查）。
  - 开启 + 已配置有效 LLM key → 切到白名单应用 → 气泡显示的是新生成的、贴合当前应用的句子（非固定预写句）。
  - 开启但网络断开/key 失效 → 切到白名单应用 → 依然正常显示预写台词兜底，不报错、不卡顿。
  - 生成内容主观质量（是否真的"贴切/好玩"）——和其他台词类功能一致，留给用户真机使用后判断，不强求自动化验证。

## 8. 风险与遗留

- **风险**：LLM 生成的内容不可控（可能跑题/过长/不搭人设），需要在 prompt 里明确约束长度和语气；真机验收后可能需要调整 system prompt 措辞。
- **风险**：5 秒超时是合理猜测，如果用户常用模型响应慢，可能经常触发超时兜底；这个值集中在 `contextualLineGenerator` 里，后续易调。
- **风险**：`streamChat` 是为多轮工具调用设计的接口，这里"借用"它做单次补全，如果某个 provider 的实现假设了工具调用的存在，可能有隐藏行为差异——需要在实现阶段跑一遍三个 provider（anthropic/openai-compat/fake）确认行为一致。
- **遗留/后续**：其余触发点是否也值得 LLM 化、气泡是否升级为可交互对话、生成内容是否该有轻量记忆（如"今天已经吐槽过你在摸鱼了，别重复"）——均留给独立后续 brainstorming，本轮不做。

## 9. 涉及文件清单

**新增**
- `src/main/context/contextualLineGenerator.ts` + `contextualLineGenerator.test.ts`

**修改**
- `src/main/context/appFocusWatcher.ts` + `appFocusWatcher.test.ts`（命中分支新增可选 LLM 生成 + 兜底、`onMatch` 支持 async）
- `src/shared/llm.ts`（`AppSettings.appFocusLlmOpener` 字段类型 + `DEFAULT_SETTINGS` + `SETTINGS_SCHEMA_VERSION` 10 → 11）
- `src/main/config/settings.ts` + `settings.test.ts`（`normalizeSettings` 补上新字段缺省兜底）
- `src/renderer/settings.ts`/`settings.html`（新增开关 UI + 说明文字）
- `docs/making-a-pet.md:146`（更新隐私声明，注明该开关存在及其影响）
