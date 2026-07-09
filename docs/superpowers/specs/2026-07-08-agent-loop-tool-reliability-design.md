# Agent 工具调用循环健壮性改进 — 设计

> 2026-07-08 与用户 brainstorming 定下。起因:用户用 gpt-5.4-mini / gpt-5.4 / gpt-5.5 三个模型
> 实测 `desktopControl` 自动化工具(截屏+鼠标键盘,见 `2026-07-08-desktop-control-tools-design.md`),
> prompt 为「打开浏览器,转到 bilibili 的网页」。只有 gpt-5.5 每次稳定完成;gpt-5.4/gpt-5.4-mini
> 大多在定位到地址栏后就没有后续动作;gpt-5.5 在任务步骤稍多时会在中途**完全静止**(不再输出任何
> 文本或工具调用),用户怀疑是撞到了循环轮数上限。

## 1. 背景与根因分析

通读 `src/main/agent/agentLoop.ts` 后确认:用户猜测的"撞循环上限"**不是**真实原因——真撞到
`MAX_TOOL_ROUNDS`/`maxToolRounds` 上限时(`agentLoop.ts:87`),代码会显式返回一句中文错误
「工具调用轮数达到上限,已停止」,这条错误会被 `chat.ts` 当作错误处理并推给 UI,不会是"完全静止、
无任何提示"。

真正的根因在 `agentLoop.ts:71`:

```ts
if (toolUses.length === 0) return { text }
```

这一行把两种完全不同的情况混为一谈:

1. **模型正常说完**——本轮没有工具调用,是因为模型认为对话/任务已经结束,合理返回。
2. **模型被截断、什么都没吐出来**——推理模型(如 gpt-5.5)在内部"思考"阶段耗尽了
   `maxOutputTokens`(`chat.ts` 里 `DESKTOP_CONTROL_MAX_OUTPUT_TOKENS = 4096`),还没来得及
   输出可见文本或工具调用就被 provider 按 `finish_reason: 'length'` 截断。此时 `roundText` 和
   `toolUses` 都是空的,和情况 1 在代码层面完全无法区分,于是被当作"正常说完"直接返回空文本,
   在用户眼里就是"对话突然静止,什么反应都没有"。

`normalizeOpenAiChunks`(`openaiCompatProvider.ts:41-48`)已经修过一个同类 bug(commit
`b76b446`):`finish_reason==='length'` 时会 flush 掉已聚合到一半的工具调用参数,避免截断丢失
"正在生成中"的工具调用。但如果截断发生在**任何工具调用参数都还没开始生成之前**(纯推理阶段耗尽
预算),`calls` map 是空的,这个 flush 无事可做——问题不在 flush 逻辑本身,而在 `agentLoop.ts`
拿到"这轮啥也没有"的结果后,没有能力区分"正常结束"还是"被截断打断"。

弱模型(gpt-5.4/gpt-5.4-mini)不调用工具的根因不同:通读 `promptAssembler.ts` 后确认,系统提示词
里**没有任何与模型能力无关的强制性"必须靠调用工具行动"指令**——多步任务的执行指引完全依赖各宠物
`persona.md` 里的散文式文案(风格化的人设文本,非结构化约束),对工具调用意愿弱的模型起不到硬约束
效果。

## 2. 目标与非目标

**目标**:
- gpt-5.5 在常见多步自动化任务上接近 100% 成功率(不再"完全静止"卡死)。
- gpt-5.4 / gpt-5.4-mini 这类工具调用能力弱的模型有明显改善,但不追求 100%(产品仍以推荐用户使用
  更强模型为主)。

**非目标(本次不做,留给后续迭代)**:
- 任务级"可续跑"机制(撞真实轮数上限后允许用户点击继续,而不是任务作废)。
- 针对弱模型的强制 `tool_choice: required`。
- 新增设置项(温度、reasoning effort、per-model max_tokens 等可配置项)。
- 修改 UI。

## 3. 设计

### 3.1 `finish_reason` 透传(数据流基础)

`src/shared/llm.ts` 的 `StreamChunk` 里 `done` 分支扩展一个可选字段:

```ts
| { type: 'done'; finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string }
```

- `normalizeOpenAiChunks`(`openaiCompatProvider.ts`)记录最后一次看到的 `choice.finish_reason`,
  随 `done` 一并吐出。
- `normalizeAnthropicEvents`(`anthropicProvider.ts`)记录 `message_delta` 事件里的
  `delta.stop_reason`,`max_tokens` 归一映射为 `'length'`,其余原样透传。
- **顺带修复一个同类问题**:目前 Anthropic 流如果在 `tool_use` 块内容中途因 `max_tokens` 截断,
  `content_block_stop` 事件永远不会到来,`normalizeAnthropicEvents` 里累积中的 `current`
  (`anthropicProvider.ts:21`)会被直接丢弃、不吐出任何 chunk——这和已修的 openai-compat 截断丢失
  bug 是同一类问题,只是发生在 Anthropic 侧。这次一并在流结束时兜底:若 `current` 非空,尝试用已
  累积的 `json` 解析(失败则回退 `{}`,同现有 openai-compat 的兜底策略)并 flush 出一个 `tool_use`
  chunk。

### 3.2 `agentLoop.ts`:区分"正常说完"与"被截断说不出话"

第 71 行的判断改为:只有当"本轮无工具调用 **且** 无文本(`roundText` 为空)**且**
`finishReason === 'length'`"时,才判定为"疑似截断、不是真的说完了"。此时不直接 `return`,而是让
`for` 循环自然进入下一轮重试:
- 用一个局部 `truncatedRetries` 计数器兜底(上限 3 次),避免病态反复截断把整个轮次预算耗光。
- 重试这一轮时,给发给 provider 的 `system` 临时追加一句提示(仅这一次请求生效,不写入
  `messages` 历史):「你上一轮被截断且没有产生任何输出,请直接调用工具继续任务,不要输出多余的
  思考过程。」
- 其他情况(有文本、有工具调用、或 `finishReason` 不是 `'length'`)行为不变,`toolUses.length===0`
  且非疑似截断时依旧直接 `return { text }`。

选择"消耗一个轮次预算"而不是额外开洞的原因:`desktopControl` 模式下 `maxToolRounds=20`
(`chat.ts:229`)已经比默认的 6 宽松很多,重试 1-2 次不会实质压缩可用步骤数,同时避免为"轮次不计入
总预算"这类特殊语义单独设计一套计数器,保持 `agentLoop.ts` 的控制流简单。

### 3.3 轮次预算提醒(避免硬撞上限时缺乏过渡)

当 `round >= maxRounds - 2` 时,给当次请求的 `system` 追加一句「你还剩 N 轮工具调用机会,请尽快
完成当前动作或总结目前进度」。同样只临时拼进当次请求的 `system` 字符串,不改动 `messages` 数组。

**为什么不写入 `messages`**:`messages.push` 一条新的 `user` 角色消息,会紧跟在上一轮 push 进去的
`tool_result` 批次后面——而 `tool_result` 在 Anthropic 侧本身就会被 `messageMapping.ts` 映射成一条
`user` 角色消息,再插一条独立的 `user` 消息会导致两条连续的 `user` 角色消息,存在触发 Anthropic
"角色必须交替"校验错误的风险。只改 `system` 完全绕开这个问题。

### 3.4 模型无关的工具执行规范(解决弱模型不调用工具)

`promptAssembler.ts` 的 `assemblePrompt()` 新增一段固定文本(不依赖 persona.md,任何宠物、任何
model 都会注入,不受人设文案是否提到这些规则影响),核心约束:

1. 需要执行动作时必须真正调用工具,不能只用文字描述"我将要……"却不实际调用。
2. 有视觉反馈的动作(点击/输入)前后配合 `take_screenshot` 验证执行结果。
3. 任务未完成不要提前结束回复,除非需要用户确认/介入才可以用文字说明并停下来等待。

这段与 persona.md 的风格化文案职责分离:persona 继续负责"人设怎么说话",这段负责"agentic 执行的
硬规矩",且始终注入,不因宠物或模型而异。

### 3.5 输出 token 预算

`chat.ts` 的 `DESKTOP_CONTROL_MAX_OUTPUT_TOKENS` 从 `4096` 调到 `8192`,降低推理模型"内部思考"
吃满预算导致截断的**发生频率**(§3.2 的重试逻辑是兜底,这一步是减少触发次数,两者互补而非互斥)。

### 3.6 诊断日志

`agentLoop.ts` 每轮结束时按仓库现有的 `console.debug`/`console.warn` 风格(参考
`src/main/shell/index.ts` 等既有用法)打一行诊断信息:轮次号、`finishReason`、本轮工具调用数、
文本长度。目的是下次再出现类似"卡住"问题时能直接从日志定位,不用再靠读源码猜测。

## 4. 测试

- `openaiCompatProvider.test.ts` / `anthropicProvider.test.ts`(如已存在同名文件,否则新建对应用
  例):
  - `finishReason` 随 `done` 正确透传(`'length'` / `'tool_calls'` / `'stop'` 等)。
  - Anthropic 中途因 `max_tokens` 截断、`content_block_stop` 未到达时,兜底 flush 出 `tool_use`
    的用例。
- `agentLoop.test.ts`(如已存在则追加用例,否则新建):
  - 模拟"本轮空输出 + `finishReason==='length'`"触发一次重试,重试轮拿到正常工具调用后继续走完
    整体流程。
  - 模拟 `truncatedRetries` 耗尽后仍然返回空文本(不会死循环)。
  - 模拟正常的"有文本、无工具调用"收尾路径不受影响(回归测试,防止改坏正常退出路径)。
  - 真撞 `maxToolRounds` 上限的现有行为(`agentLoop.ts:87` 的错误文案)不受影响。
- **真机验证**(自动化测试无法覆盖,需人工在真实 Windows 环境用真实 API key 跑):开启
  `desktopControl`,分别用 gpt-5.4-mini / gpt-5.4 / gpt-5.5 跑「打开浏览器,转到 bilibili 的网页」
  及一个步骤更多的任务,对照日志确认:
  - gpt-5.5 不再出现"完全静止"的卡死,截断重试分支是否被命中、命中后是否成功续上。
  - gpt-5.4 / gpt-5.4-mini 在新增的工具执行规范提示词下,工具调用意愿是否有可观察的改善。
