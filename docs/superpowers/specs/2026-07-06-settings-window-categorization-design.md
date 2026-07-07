# 设置窗分类重构(左侧边栏)— 设计文档

> 日期:2026-07-06 · 状态:设计已与用户确认,待写实现计划
> 承接:配置项持续增多(宠物/模型/搜索/记忆/文字加工,且即将加入 Firecrawl),平铺长表单已到分类阈值。
> 关系:这是一个**独立小 MVP**。Firecrawl 网页读取工具(scrape+extract)为**后续独立工作**,其设置项将落进本次分好类的「工具能力」页,不在本 spec 范围内。

## 1. 目标与非目标

**目标**:把当前单条平铺的设置窗,改成**左侧边栏分类导航 + 右侧分页内容**,让 API/模型配置、宠物配置、记忆配置、工具配置彼此分开,降低认知负担,并为后续新增配置(Firecrawl 等)预留干净的落点。

**非目标(YAGNI / 明确排除)**:
- 不改配置的**数据模型**:`ProviderSettings`、`search`、`memory`、`textTools`、`activePetId` 字段与 `schemaVersion` **完全不变**。
- 不做**分页独立保存**:维持单个全局「保存」原子写整快照(见 §4)。
- 不引入路由库、状态管理库或任何新依赖。
- 不改 IPC 契约、preload、主进程业务逻辑(唯一例外见 §6 的窗口尺寸)。
- 不做主题切换、暗/亮色适配等超出「分类」诉求的美化。

## 2. 现状

设置窗是**一整条平铺的长表单**([src/renderer/settings.html](../../../src/renderer/settings.html) + [src/renderer/settings.ts](../../../src/renderer/settings.ts)),所有配置堆叠、共用一个「保存」一次性写全部快照。现有配置项:

1. 当前宠物(`petSelect` + `importPet` + `relaunch`)
2. Provider(`preset` / `baseURL` / `model` / `key` / `test` 测试连接)
3. 搜索(`searchBackend` + `searchKeyRow`→`searchKey` Tavily)
4. 记忆(`embBaseURL` / `embModel` / `embKey` + `openMemoryDir`)
5. 文字加工(`autoCopyResult` 勾选)
6. 底部:`test` 测试连接 · `save` 保存 · `status` 状态行

保存逻辑([settings.ts](../../../src/renderer/settings.ts) 第 94–131 行)一次性读取**所有字段**并调 `setApiKey/setSearchKey/setEmbeddingKey` + `setSettings`;init 逻辑(第 134–152 行)从 `getSettings()` 快照一次性回填所有字段。**这两段逻辑与「字段在第几页」无关**,是本次低风险重构的关键前提。

## 3. 架构

**性质:纯渲染层重构。** 只改 [settings.html](../../../src/renderer/settings.html) 与 [settings.ts](../../../src/renderer/settings.ts)。

**DOM 结构**:
```
#app
├── header(标题「宠物大脑设置」)
├── #layout(flex row)
│   ├── nav#sidenav      ← 4 个分类按钮(data-page="pet|model|tools|memory")
│   └── #pages           ← 4 个 <section class="page" data-page="...">
│       ├── 宠物         (petSelect, importPet, relaunch)
│       ├── 模型 · API    (preset, baseURL, model, key, test)
│       ├── 工具能力       (searchBackend, searchKeyRow→searchKey, autoCopyResult)
│       └── 记忆          (embBaseURL, embModel, embKey, openMemoryDir)
└── footer(固定)        ← save 按钮 + status 状态行(切页恒显)
```

**导航机制**:纯 CSS/JS 显隐。点击某个 nav 按钮 → 给对应 `.page` 加 `.active`(其余移除)、给该 nav 按钮加高亮态。**所有 `<input>/<select>` 始终留在 DOM 中**,仅靠 `display:none` 隐藏未激活页——因此隐藏页的字段值在保存时依旧可读。默认激活页:**模型 · API**(首启最常做的是填 Provider + Key)。

**样式**:沿用现有暗色 token(`#1e1e28` 背景、`#f0f0f4` 文字、圆角输入框等),不新增配色体系。侧边栏项为纵向列表按钮,激活项高对比高亮。

## 4. 分类映射(4 页)

| 页面(data-page) | 现有元素 id | 说明 |
|---|---|---|
| **宠物** `pet` | `petSelect`, `importPet`, `relaunch` | 原样搬入 |
| **模型 · API** `model` | `preset`, `baseURL`, `model`, `key`, `test` | 测试连接按钮从底部移入本页(它是 provider 相关操作) |
| **工具能力** `tools` | `searchBackend`, `searchKeyRow`→`searchKey`, `autoCopyResult` | 搜索 + 文字加工;未来 Firecrawl 落此页 |
| **记忆** `memory` | `embBaseURL`, `embModel`, `embKey`, `openMemoryDir` | 原样搬入 + 记忆说明文案 |

**底部固定 footer(所有页恒显)**:`save`(保存)+ `status`(状态行)。

**保存模型:维持单个全局保存,原子写整快照。** 保存处理器不变——无论当前在哪一页,都读取全部字段并写完整 `setSettings` 快照 + 三个 key。理由:拆成分页保存会引入「只存了一半」的部分写风险,且与现有 `setSettings` 一次写整快照的契约冲突。测试连接(`test`)按钮虽视觉上移入模型页,但行为不变(读 `currentProvider()` + `key.value`)。

## 5. 数据流 / 交互

- **切页**:点 nav → 切 `.active` class。无异步、无 IPC。
- **保存**:点底部 `save` → 现有逻辑(读全部字段 → 三个 setKey + setSettings)→ 更新 `status`;若 `petSelect` 变化则显示「立即重启」提示(逻辑不变)。
- **测试连接**:模型页 `test` → `testConnection(currentProvider(), key.value)` → 更新 `status`(不变)。
- **init 回填**:`getSettings()` 快照一次性回填所有字段(不变);Tavily key 行随 `searchBackend` 显隐(逻辑不变,现在位于工具页内)。
- **错误**:保存/测试失败照旧写入 `status`(不变)。

## 6. 窗口尺寸(唯一可能的主进程改动)

当前 [settingsWindow.ts](../../../src/main/shell/settingsWindow.ts) 为 `width:460, height:520, resizable:false`。侧边栏(约 110px)+ 内容在 460 宽下略紧。**允许调整这两个数字**(预期 `width` 调至 ~560;分页后每页字段更少,`height` 可维持或略减)。这是本次唯一可能触及主进程的改动,且仅为常量尺寸,不涉及逻辑。最终值以真机肉眼观感为准。

## 7. 测试与验收

- [settings.ts](../../../src/renderer/settings.ts) 是 GUI 接线代码、现无单测;导航显隐为平凡 DOM 操作,无值得抽离的纯逻辑。按项目既有约定(CLAUDE.md「GUI/Electron wiring is verified by running the app」),由**真机 `pnpm dev` / `pnpm preview` 肉眼验收**。
- `pnpm typecheck` / `pnpm build`(三包)/ `pnpm test`(全量回归)须全绿——确保重构没破坏渲染层编译与既有单测。

**真机验收清单(回归重点)**:
1. 四个分类可点击切换,右侧内容随之切换,激活项高亮正确。
2. **从任意一页点保存,都能写全部字段**(在模型页改 model、切到记忆页再保存,重开后 model 仍生效)。
3. 重开设置窗,各页字段被正确回填(含 Tavily/Embedding 的「已配置」占位提示)。
4. 测试连接在模型页可用。
5. 工具页切换搜索后端时 Tavily key 行正确显隐。
6. 首启提示文案仍在(`status` 初始文案)。
7. 宠物页导入/切换/重启提示流程不变。
8. 窗口尺寸容得下侧边栏,无横向溢出/裁切。

## 8. 影响面与风险

- **改动文件**:`src/renderer/settings.html`(结构+样式重排)、`src/renderer/settings.ts`(新增 nav 显隐接线;保存/测试/init 逻辑基本不动)、可能 `src/main/shell/settingsWindow.ts`(尺寸常量)。
- **零改动**:IPC 契约、preload、`@shared/llm` 数据模型、`schemaVersion`、主进程业务逻辑、settings 持久化。
- **主要风险**:重排 DOM 时误改字段 id / 漏搬字段,导致保存少写或 init 漏填 → 由验收清单第 2、3 项专门拦截。
- **回归风险低**:所有字段仍在 DOM、保存/init 逻辑复用,不改数据层。

## 9. 后续(不在本 spec)

- Firecrawl 网页读取工具(`read_url` + `extract_from_url`,scrape 含 JS/反爬/PDF + 单页结构化抽取,云服务 + 可选 baseURL + safeStorage key + opt-in 注入):其设置项(Firecrawl key + baseURL)将落进本次的「工具能力」页。独立 spec、独立 plan。
