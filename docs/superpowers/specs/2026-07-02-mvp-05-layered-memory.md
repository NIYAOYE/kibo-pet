# MVP-05 设计文档 · 分层记忆(短期/工作记忆 + 事实库 + 本地向量库)+ persona 组装

> 日期:2026-07-02 · 状态:已与用户逐节确认定案
> 上游依据:产品设计文档 §5.4(System Prompt 组装)、§5.6(运行时边界)、§7(分层记忆系统·标准档)、§8.3(数据位置)、§11(安全基线)
> 前置:MVP-04 已完成(多轮工具调用 + web_search + Skill 加载器),`promptAssembler.ts` 已留 `MEMORY_PLACEHOLDER` 注入点

---

## 1. 目标

给宠物装上"记性":

1. **长期记忆(事实库)**:宠物在对话中主动记下用户的稳定事实/偏好(名字、爱好、习惯),跨重启保留,下次对话能用上——"它记得我"。
2. **语义召回(本地向量库)**:事实多了以后,按当前话题相关性召回,而不是全量塞 prompt。
3. **短期/工作记忆**:对话变长时滚动摘要,防上下文爆炸;摘要与完整对话历史都跨重启持久化,重启后有"上次我们聊到…"的延续感,对话框能看到历史消息。
4. **persona 组装收口**:把 §5.4 规定的完整顺序落实——`[人设分块] + [召回的长期记忆] + [工作记忆摘要] + [对话窗口]`,替换掉 MVP-03 留下的占位符。

非目标(明确不做,留后续):记忆管理 UI(编辑/删除界面——用户直接手改 facts.json)、相似度判重/衰减/定期反思(§7.4 允许 MVP 简单判重)、search_memory 主动检索工具、对话片段级语义库、本地 embedding 模型内置(只留接口)。

## 2. 现状与改动边界

- `promptAssembler.ts`:`MEMORY_PLACEHOLDER` 常量已标注"MVP-05 在此注入用户事实/工作记忆摘要"——本 MVP 的核心接入点。
- `chat.ts`:transcript 目前只在内存,重启即失;每次发送时组装 registry(web_search + read_skill)。
- `config/settings.ts`:原子写 + schemaVersion 迁移(v1→v2)模式已成熟,本 MVP 沿用并升 v3。
- `config/secrets.ts`:safeStorage 加密、可多实例(MVP-04 第二实例存 Tavily key),本 MVP 加第三实例存 embedding key。
- 工具链路(toolSpec/toolRegistry/校验失败回灌不抛)完备,save_memory 直接复用。
- Provider 层只有对话补全;embedding 是新能力,但**只需 openai-compat 一种实现**(Anthropic 无 embedding API)。

## 3. 拍板决策(用户已定)

| 决策点 | 结论 |
|---|---|
| 写入策略 | **agent 工具 `save_memory`**,模型对话中自主调用;persona 引导;零额外 LLM 调用,UI 可播报 |
| 向量库 | **纯文件 JSON 索引 + JS 余弦相似度**(桌宠量级百~千条,全量扫描毫秒级;零原生依赖,不给 MVP-06 打包埋雷) |
| Embedding | **独立 openai-compat 配置(baseURL/model/key)+ 优雅退化**:未配置时召回退化为最近-N 事实,Anthropic-only 用户可用 |
| 短期记忆 | **滚动摘要 + 完整对话历史都持久化跨重启** |
| 召回对象 | **只索引事实库条目**(单一权威源,索引可重建,隐私面可控) |
| 整体架构 | **A·自动注入管道**:召回全自动(不依赖模型自觉),写入走工具,摘要异步后台 |

## 4. 数据模型与存储

全部存 `app.getPath('userData')/memory/`(§8.3:用户目录、卸载不删);整目录可直接拷走备份/迁移(§7.5)。四个文件,全部原子写(临时文件 + rename,沿用 settings.ts 模式),全部带 `schemaVersion: 1`:

### 4.1 `facts.json` — 唯一权威源(人类可读,可手改)

```jsonc
{
  "schemaVersion": 1,
  "facts": [
    { "id": "f_01J...", "text": "用户叫小星", "createdAt": "2026-07-02T10:00:00Z", "updatedAt": "2026-07-02T10:00:00Z" }
  ]
}
```

- `id` 稳定唯一(时间戳+随机后缀即可);`source` 目前恒为 save_memory,不落字段(YAGNI)。
- **判重**:规范化文本(trim + 压空白)完全相同 → 更新 `updatedAt` 而非新增。

### 4.2 `vector-index.json` — 可重建索引

```jsonc
{
  "schemaVersion": 1,
  "model": "text-embedding-v3",
  "dims": 1024,
  "entries": [ { "factId": "f_01J...", "vector": [0.01, ...] } ]
}
```

- 记录生成向量所用的 `model`:换模型 = 全部条目视为缺失,懒重建。
- 文件损坏/被删 → 按空索引处理,自然重建;**绝不反向影响 facts.json**。

### 4.3 `summary.json` — 工作记忆(滚动摘要)

```jsonc
{ "schemaVersion": 1, "text": "上次聊到:用户在准备考研…", "coveredCount": 24, "updatedAt": "..." }
```

- `coveredCount`:摘要已覆盖 transcript 累计前多少条消息(单调递增,transcript 裁剪不影响其语义,见 4.4)。

### 4.4 `transcript.json` — 对话历史

```jsonc
{ "schemaVersion": 1, "totalCount": 240, "messages": [ { "role": "user", "text": "..." } ] }
```

- 只保留**最近 200 条**,超出从头裁剪;`totalCount` 记录累计总条数,使 `coveredCount` 在裁剪后仍可对齐(窗口/摘要溢出判定都用累计序号,不用数组下标)。
- 更早的内容只活在滚动摘要里——这是有意的取舍(隐私/体积)。

## 5. 架构 / 模块地图

```
src/main/memory/          ← 新目录
  factStore.ts            事实库读写 + upsert 判重(纯解析函数可测,fs 走临时目录测试)
  vectorIndex.ts          纯函数:cosineSimilarity / topK / 找缺向量事实;索引文件读写
  workingSummary.ts       溢出判定纯函数 + 调 provider 滚动总结(独立超时,无工具)
  transcriptStore.ts      对话历史落盘/加载/按 200 条裁剪
  memoryManager.ts        门面:recall(query) + onFactSaved + maybeSummarize 编排
src/main/providers/
  embedder.ts             Embedder 接口 + createOpenAiCompatEmbedder(POST /embeddings)+ fakeEmbedder
src/main/tools/
  saveMemory.ts           save_memory 工具(输入 { text },写事实库 + onStatus 播报"记住了…")
src/main/agent/
  promptAssembler.ts      扩展:assemblePrompt(persona, transcript, skills, memory?)
                          memory = { facts: string[]; summary?: string } → 替换 MEMORY_PLACEHOLDER
src/main/shell/chat.ts    编排每次发送的记忆管道(见 §6);transcript 改为落盘存取
src/shared/llm.ts         AppSettings v3:+ memory.embedding;迁移 v2→v3
src/main/config/secrets.ts  第三实例:embedding key
settings 窗口              新增「记忆」小节(embedding 三字段 + 隐私文案 + 打开记忆文件夹)
pets/luluka/persona.md    Tools 块加 save_memory 引导(磁盘副本,gitignore 内,验收时手动应用)
```

### Embedder 接口(§7.3"保留本地 embedding 接口"的落点)

```ts
interface Embedder {
  readonly model: string
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>
}
```

MVP 只有 openai-compat 实现;将来本地 embedding 只需新增一个实现,索引的 `model` 字段天然区分。

## 6. 每次发送的数据流(chat.ts)

1. 用户消息 append → transcriptStore 落盘。
2. **懒补建**:若配置了 embedding,找出无向量/模型不匹配的事实,批量 embed 补进索引(失败静默跳过,下次再试)。
3. **召回**:
   - 配置了 embedding → 用户消息 embed 为 query,余弦 **top-5**(相似度阈值常量,初始 0.3)事实;
   - 未配置 / embed 失败 → **静默退化**:取 `updatedAt` 最近的 **10** 条事实。
4. `assemblePrompt(persona, transcript, skills, { facts, summary })` — 记忆注入 system(格式见 §7)。
5. registry = web_search + read_skill + **save_memory**,跑 runAgent(agentLoop 不改)。
6. 回复完成 → pet 消息落盘;检查溢出:**窗口(12 条)之外、未被摘要覆盖的消息 ≥ 8 条** → 后台异步滚动摘要(旧摘要 + 溢出消息 → 新摘要),完成后原子写 summary.json。不阻塞下一条消息;失败保留旧摘要下次再试。

**启动时**:加载 transcript 推给对话框(历史消息可见,沿用现有 CHAT 更新通道),加载 summary 备用。

## 7. Prompt 组装(§5.4 收口)

`MEMORY_PLACEHOLDER` 替换为(无记忆时对应小节整体省略):

```markdown
# 关于用户的记忆
以下是你之前记住的关于用户的事实,回答时自然地用上,不要生硬复述:
- 用户叫小星
- 用户爱吃冰淇淋

# 上次对话摘要
上次聊到:用户在准备考研,压力有点大…
```

组装顺序 = `[人设四分块] + [可用技能] + [关于用户的记忆] + [上次对话摘要]` 为 system,`[对话窗口(12 条)]` 为 messages——与设计文档 §5.4 一致。窗口逻辑不变。

## 8. save_memory 工具

- schema:`{ text: string }`——一条**简洁、自包含**的事实(persona 引导:用户透露稳定的个人信息/偏好/重要事件时调用;临时话题不记)。
- 行为:factStore.upsert(判重)→ onStatus 播报「记住了:…」→ 返回成功文本回灌;embedding 补向量**不在工具内做**(下次发送时懒补建),工具保持快速同步。
- 遵守 registry 契约:校验失败回灌错误不抛。

## 9. 设置与 IPC(四文件联动惯例)

- `shared/llm.ts`:`SETTINGS_SCHEMA_VERSION = 3`;`AppSettings` 增 `memory: { embedding: { baseURL: string; model: string } | null }`;`DEFAULT_SETTINGS` 中为 `null`;迁移 v1→v2→v3 链式补默认。
- embedding key 存 secrets 第三实例;**key 留空且 embedding.baseURL 与聊天 provider 的 baseURL 相同时,自动复用聊天 key**(qwen/DashScope 用户不用粘两遍;不同端点则必须单独填)。
- 设置窗「记忆」小节:baseURL / model / key 三字段(留空 = 不启用向量召回)+ 隐私文案:**"配置后,被记住的事实文本会发送到该 embedding 端点用于向量化;留空则记忆功能完全本地(按最近记忆召回)。"** + 「打开记忆文件夹」按钮(`shell.openPath(memory 目录)`)。
- README 补同样的隐私说明(§7.3 硬性要求)。
- IPC:沿用 SETTINGS_GET/SET 通道传 memory 设置;新增 embedding key 的 set 通道(仿 `setSearchKey`);「打开记忆文件夹」新增一条 invoke 通道。渲染层照旧零文件访问。

## 10. 错误处理与运行时边界(§5.6 对齐)

- **记忆链路任何故障都不得阻断对话主链路**:embed 调用独立超时(10s)、不重试、失败静默退化;懒补建失败跳过;summary/transcript 写盘失败仅日志。
- 滚动摘要:独立超时、不带工具、小 maxOutputTokens;应用退出不等待;失败保留旧摘要。
- 所有 memory 文件解析失败 → 按空数据处理 + 日志,不崩;facts.json 有原子写保底,索引可重建。
- 取消语义:摘要请求用独立 AbortController,用户取消对话不误伤摘要;反之摘要不占用对话的 inFlight。

## 11. 测试与验收

### 单元测试(TDD,纯逻辑先行)

- vectorIndex:余弦相似度、topK(含阈值/空索引/维度不符防御)、缺向量事实检测
- factStore:解析防御(坏 JSON→空)、upsert 判重(规范化文本)、原子写往返(临时目录)
- transcriptStore:落盘/加载/200 条裁剪 + totalCount 对齐
- workingSummary:溢出判定纯函数(coveredCount/totalCount/窗口边界)
- promptAssembler:memory 段注入(有/无 facts、有/无 summary、全无时不出现小节)
- saveMemory 工具:schema 校验、判重、onStatus 播报
- embedder:openai-compat 请求/响应映射(mock fetch)、超时、错误
- settings:v2→v3 迁移
- chat 集成:fake provider(script)+ fakeEmbedder —— 召回注入 system、save_memory 落盘、摘要触发与异步不阻塞

### 真机验收

1. 「我叫小星,我爱吃冰淇淋」→ 播报「记住了…」→ **重启** → 「我叫什么?」→ 答对。
2. 不配 embedding(纯 Anthropic)重复 1 → 退化召回也答对。
3. 长对话超窗口 → 重启 → 对话框可见历史消息,且宠物延续「上次聊到…」语境。
4. 拷走 `memory/` 再放回 → 记忆完好;删 `vector-index.json` → 下次对话自动重建(facts 无损)。

## 12. 风险与缓解

- **小模型懒得调 save_memory** → persona Tools 块显式引导 + 验收用真机检验;实在不行后续再补自动抽取(已在决策里排除出 MVP)。
- **embedding 端点五花八门**(维度/字段差异)→ openai-compat 标准 `/embeddings` 响应结构,dims 以首次返回为准存入索引;不符时按模型不匹配整体重建。
- **摘要质量差污染上下文** → 摘要 prompt 限定"只总结事实与话题走向,不虚构";摘要仅作为 system 一小节,权重天然低于窗口原文。
- **transcript 无限膨胀** → 200 条硬裁剪;更早内容进摘要。
- **persona.md 在 gitignore 内** → save_memory 引导需在磁盘副本手动应用,并在 PROGRESS.md 记录(沿用 MVP-04 的处理先例)。
