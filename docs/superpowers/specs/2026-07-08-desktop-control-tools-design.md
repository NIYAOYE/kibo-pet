# 宠物自主截屏 + 鼠标/键盘控制工具 — 设计

> 2026-07-08 与用户 brainstorming 定下。承接 ROADMAP.md 轨道一「桌面自动化(操作其他软件/键鼠)」
> 与轨道二「宠物自主截屏工具」两项——用户明确希望合并成一个功能:截屏(眼睛)必须配合鼠标/键盘
> 控制(手脚)才有实际价值,不单独只做截屏。**高风险功能,默认关闭,需用户手动确认风险后开启。**

## 1. 背景与目标

在已有 MVP-07 多模态识图管线(`imagePrep.ts` 降采样/编码 + 两 Provider 图像序列化)之上,
让 Agent 能在常规聊天中**自主决定**何时截屏、何时点击/输入,形成
「截屏 → 分析 → 点击/输入 → 再截屏确认」的闭环,复用现有 MVP-04 起的
`ToolSpec` / `toolRegistry` / `agentLoop` 回灌机制(与 web_search、天气、Firecrawl 同一套)。

- **触发模式**:常规聊天里 AI 按需自主调用,不设独立「自动化任务」模式(工具和其他工具一样注册进现有工具箱)。
- **操作粒度**:move + click(左/右/双击)+ 打字 + 按键(小白名单,非任意组合键)。
- **截屏范围**:全屏截图 + 查询/切换到指定应用窗口(不做单窗口局部截图)。
- **确认强度**:开关即授权(开启时一次性弹窗告知风险),开启后单次操作不再逐步确认;
  但执行期间屏幕上有明显视觉提示,且开启动作本身有强确认。
- **平台**:仅支持 Windows(本仓库目前也只面向 win32);非 Windows 平台工具直接报错拒绝执行。

### 非目标(明确不做)

- 跨平台(mac/linux)支持。
- 单窗口局部截图(`PrintWindow` 等)——只做全屏截图 + 窗口枚举/前台切换。
- 拖拽、滚轮、任意组合键——`press_key` 限定一个显式白名单,不支持 Alt+F4 / Win 键组合 /
  Ctrl+Alt+Delete 等系统级或破坏性组合。
- 每次点击/输入前的二次弹窗确认(用户明确选择「开关即授权」模式)。
- 独立的「自动化任务」UI/状态机——工具就是普通工具,混在常规聊天工具箱里。

## 2. 架构与组件

新建 `src/main/automation/` 目录(纯逻辑与副作用分层,呼应 `tools/firecrawl/` 的目录组织方式):

| 文件 | 职责 |
|---|---|
| `automation/win32Bridge.ts` | **纯函数**:为每个动作(移动/点击/打字/按键/枚举窗口/前台切换)构造 PowerShell + C#(`Add-Type` P/Invoke user32.dll)脚本文本;解析脚本 stdout 为结构化结果。可单测(输入 → 脚本字符串;fixture stdout → 解析结果)。 |
| `automation/desktopControl.ts` | **副作用外壳**:`execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script])` 执行 `win32Bridge.ts` 生成的脚本。不可单测(同 `screenCapture.ts`/`imagePrep.ts` 先例),靠真机验收。 |
| `automation/screenshotState.ts` | 记录「最近一次截屏」的换算信息(哪个显示器、物理分辨率、发给模型的降采样后分辨率),供 `click_at` 把模型给出的图像坐标换算回物理屏幕坐标。每次新的用户消息(新一轮 `handleSend`)重置。 |
| `automation/keyAllowlist.ts` | 纯函数:按键名 → 虚拟键码(vk code)的白名单映射表 + 校验函数,拒绝不在表中的按键/组合。 |

新建 `src/main/tools/desktopTools.ts`:六个工具的工厂函数(`createTakeScreenshotTool` 等),
遵循既有 `ToolSpec` 接口。**为什么不用一个大工具**:每个动作的 `inputSchema`/错误语义都不同
(截屏无参数、点击需要坐标、按键要过白名单),拆成独立工具更符合模型 function-calling 的调用习惯,
也是本仓库现有工具(web_search / weather / clipboard 等)的一贯做法。

### 2.1 六个工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `take_screenshot` | *(无)* | 截取光标所在显示器(取不到则用主显示器)全屏,经现有 `imagePrep` 降采样/编码,把图像作为工具结果的一部分返回给模型(见 §2.3),同时写入 `screenshotState`。 |
| `list_windows` | *(无)* | 通过 `win32Bridge` 生成的 PowerShell 脚本枚举可见顶层窗口标题,返回标题列表(纯文本)。 |
| `focus_window` | `{ titleContains: string }` | 找到标题包含该子串的第一个窗口,`SetForegroundWindow` 切到前台。找不到则返回明确错误(不静默失败)。 |
| `click_at` | `{ x: number; y: number; button?: 'left'\|'right'; double?: boolean }` | 若本轮尚未调用过 `take_screenshot`(`screenshotState` 为空),**直接报错**要求先截屏——这是防止模型盲点的安全闸。否则把 `(x,y)` 从「最近一次截屏图像坐标系」换算成物理屏幕坐标(见 §2.2),移动光标并点击。 |
| `type_text` | `{ text: string }`(≤2000 字符,超限报错而非静默截断) | 用 `SendInput` 以 Unicode 方式逐字符输入(不用 `SendKeys`,避免其 `+^%~(){}` 转义坑),打给当前焦点控件。 |
| `press_key` | `{ key: string }` | 只接受 `keyAllowlist.ts` 里的键名(Enter/Tab/Escape/Backspace/Delete/方向键/Ctrl+A|C|V|X|Z),不在白名单直接拒绝并报错列出可用键名。 |

### 2.2 坐标换算(关键设计点)

模型只看得到、也只会基于**降采样后**的截屏图像推理坐标,所以 `click_at` 的 `x,y` 被定义为
「最近一次 `take_screenshot` 返回图像」的像素坐标,而不是物理屏幕像素。`desktopControl.ts`
在实际调用 `SetCursorPos` 前,用 `screenshotState` 记录的换算比例(降采样图像分辨率 ↔ 该显示器
物理分辨率 ↔ `scaleFactor`)转换成物理/per-monitor-DPI-aware 屏幕坐标——这类 DPI 换算错误此前
已经在宠物拖拽功能上踩过一次坑(见项目记忆 `electron-isvisible-setresizable-drift` 记录的
DPI 漂移问题),这里需要同样谨慎处理,避免点错位置。

### 2.3 截屏结果如何回灌给模型(工具协议扩展)

现状:`AgentMessage` 的 `tool_result` 分支只有 `content: string`,`ToolRunResult` 同样只有
`content: string`——工具调用的返回值目前不支持带图像。这是本设计**唯一需要改动跨 Provider
协议**的地方:

- `ToolRunResult` 与 `AgentMessage` 的 `tool_result` 分支新增可选 `images?: ImagePart[]`。
- `agentLoop.ts` 把工具返回的 `images` 原样带进对应的 `tool_result` 消息。
- **Anthropic** 序列化(`messageMapping.ts`):`tool_result` 的 `content` 支持数组形式,
  可以在文本块之后追加 `image` 块,Anthropic API 原生支持在 `tool_result` 里带图,直接用。
- **openai-compat** 序列化:Chat Completions 的 `tool` 角色消息**不支持**图像内容(只能是纯文本),
  所以走一个兼容写法——`tool_result` 消息本身只带文本(如"已截屏,见下图"),随后紧跟着插入一条
  **合成的 `user` 消息**携带 `image_url` 内容块。这在 OpenAI 的消息顺序规则下是合法的
  (`tool` 消息必须紧跟在对应的 `assistant.tool_calls` 之后,一一配对;配对完成后续消息不受约束)。
  多数 OpenAI 兼容端点(DashScope/DeepSeek/Moonshot 等)遵循同一规则,此写法可通用。
- `take_screenshot` 工具的 `run` 返回 `{ content: '已截屏,分辨率 <W>x<H>(点击坐标以此为准)', images: [...] }`。

## 3. 风险门控(默认关闭 + 强确认 + 运行时可视提示)

### 3.1 设置模型(`src/shared/llm.ts` + `src/main/config/settings.ts`)

- `AppSettings` 新增 `desktopControl: { enabled: boolean }`,`DEFAULT_SETTINGS.desktopControl = { enabled: false }`。
- `SETTINGS_SCHEMA_VERSION` 6→7,`settingsMigration.ts` 加迁移:旧配置补默认块(`enabled:false`)。

### 3.2 开启前强确认(不是普通勾选框)

设置窗「桌面控制(高风险)」小节的勾选框,勾选事件不直接写入待保存的设置草稿,而是先触发
`dialog.showMessageBox`(warning 图标、明确列出风险的中文文案,例如:「开启后,AI
可以在对话中自主截屏(屏幕内容会发送给你配置的模型服务商)、控制鼠标点击与键盘输入,
可能造成误操作或截取到敏感信息。是否确认开启?」),只有用户点「确认开启」才真正把
`desktopControl.enabled` 置为 `true`;点取消则勾选框视觉上弹回未勾选状态。这比纯静态警告文字
更能保证「手动开启并告知风险」被真正读到、而不是在表单里顺手勾过去。

### 3.3 运行时可视提示

当前对话轮次里任意一个桌面控制工具被调用期间,显示一个置顶、鼠标穿透的小提示窗
(复用 `regionOverlay`/`bubbleWindow` 已有的透明 `BrowserWindow` 手法),文案为
**「`<宠物 displayName>` 正在控制鼠标」**(取自 `petLoader` 已加载的 `PetManifest.displayName`,
不写死成"AI"),回合结束(`pushDone`/`pushError`/用户取消)后立即隐藏。

### 3.4 人工接管即中断(安全网,超出用户原始要求的补充设计)

自动化执行期间轮询真实光标位置;若与 AI 上一次设置的光标位置偏差超过一个小阈值
(意味着人已经用手抓住了鼠标),立即触发现有的 `cancel()` 中止在途请求
(复用聊天已有的取消/`AbortController` 路径)。这是brainstorming 阶段用户已确认可以先做的
补充安全设计,不是产品需求原文,后续如证明不必要可以去掉。

### 3.5 平台守卫

工具 `run` 一开始检查 `process.platform !== 'win32'`,非 Windows 直接返回
`isError: true` 且文案「此功能仅支持 Windows」,不静默变成不可用。

### 3.6 工具条件挂载与轮数上限(`src/main/shell/chat.ts`)

- `handleSend` 构建 registry 时,仅当 `settings.desktopControl.enabled === true` 才
  push 六个桌面控制工具(同 firecrawl 的「开关决定工具是否出现」写法)。
- 仅当桌面控制工具被挂载时,`runAgent` 的 `maxToolRounds` 传 **20**(而非默认 6)——
  一次「截屏→点击→截屏→输入」的真实闭环远不止 6 轮工具调用,但仍是一个硬上限,
  不是无限循环。

## 4. 设置 UI(renderer 设置窗)

新增「桌面控制(高风险)」小节(独立于「搜索」页,建议放在设置窗一个显眼位置,不要和
Firecrawl 混在一起,风险量级不同):

- 勾选框「允许宠物自主截屏与控制鼠标/键盘」→ 触发 §3.2 的确认弹窗流程。
- 勾选框下方常驻一行小字风险提示(即使已开启也保留,提醒用户随时可关闭)。
- 无需额外 key/baseURL 输入(纯本机能力,零外部服务依赖)。

## 5. 测试策略(TDD)

- **纯逻辑先写失败测试**:
  - `win32Bridge.test.ts`:各动作脚本构造的关键片段断言(不执行真实 PowerShell,只测生成的
    脚本文本包含预期的 API 调用/参数);stdout 解析函数(窗口列表 fixture 文本 → 解析结果数组、
    畸形输出不崩溃)。
  - `keyAllowlist.test.ts`:白名单内键名解析出正确 vk code;白名单外(如 `'Alt+F4'`)返回拒绝。
  - `screenshotState.test.ts`:记录/读取/重置的纯状态逻辑,坐标换算函数(已知降采样比例 → 期望
    物理坐标)的单测。
  - `desktopTools.test.ts`:用假的 `automation` 依赖注入,验证六个工具的 `name`/`inputSchema`/
    未先截屏时 `click_at` 报错/`type_text` 超长报错/`press_key` 白名单外报错等边界,
    以及 `take_screenshot` 返回值同时含 `content` 与 `images`。
  - `messageMapping.test.ts` 补充:`tool_result` 带 `images` 时,Anthropic 序列化出 `image` 块、
    openai-compat 序列化出「tool 文本 + 紧随其后的合成 user image 消息」两种断言。
  - `settings.test.ts` / `settingsMigration.test.ts` 补 `desktopControl` 归一化与迁移用例。
- **native/GUI 部分不可单测**(`desktopControl.ts` 的真实 `execFile` 调用、确认弹窗、提示悬浮窗、
  人工接管中断),按项目既有惯例由人工在 `pnpm build && pnpm preview` 下真机验收,且由于风险
  等级高于此前任何一个 MVP,验收清单需格外完整(见 §6)。

## 6. 验收

- `pnpm typecheck` / `pnpm test`(新增全绿、回归不破)/ `pnpm build` 三包通过。
- 真机(务必逐条走查,不可省略):
  - 默认关闭:未开启时模型不会看到这六个工具。
  - 开启流程:勾选 → 出确认弹窗 → 取消则保持未开启;确认开启后设置里状态正确、重启/重开设置
    仍保持开启。
  - 对话触发:「帮我截个屏看看」→ 出图分析;「帮我点一下 xxx 按钮」→ 先截屏、报告点击坐标、
    点击生效、可选再截屏确认;「帮我在这个输入框打字:xxx」→ 输入生效;`list_windows`/
    `focus_window` 能正确列出与切换窗口前台。
  - 视觉提示:执行期间悬浮提示正确显示宠物名+文案,回合结束后消失。
  - 安全闸:未截屏直接要求 `click_at` → 报错提示先截屏;`press_key` 传白名单外键名 → 拒绝;
    `type_text` 超长 → 拒绝;非 Windows(如可模拟)→ 明确报错。
  - 人工接管:执行期间用户手动移动鼠标 → 自动化立即中断,聊天回合停止且无残留悬浮提示。
  - 关闭开关后:六个工具立刻从模型可用清单消失。

## 7. 原则:工具是项目默认注入,不进宠物包

同 MVP-11/12:六个工具的可用性由**项目代码**(`chat.ts` registry + 各工具 `description`)+
`desktopControl.enabled` 门控注入,与选用哪个宠物无关,不放进 `pets/<id>/`、不依赖 `persona.md`
让模型"知道"有这些工具。

## 8. 遗留 / 已知风险(非本期解决,记录以便下一次会话知情)

- 截屏内容会经由用户配置的 LLM Provider(可能是第三方云 API)看到——这是功能本质决定的隐私
  边界,已在确认弹窗文案里明确告知,无法进一步消除,只能靠"默认关闭 + 强确认"降低误开启概率。
- 多显示器下 `take_screenshot` 只截光标所在的那一个;跨显示器操作(比如截 A 屏、点 B 屏)本期
  不支持,模型需要先把目标窗口所在显示器变成光标所在显示器(可通过 `focus_window` 间接达成,
  但不保证跨屏场景体验顺滑)。
- `press_key` 白名单目前只覆盖最常见的编辑类按键,如果真机验收发现明显缺口(比如需要 Home/End),
  按需要在后续小改动里扩充,不必现在预判齐全。
- 人工接管中断(§3.4)的阈值大小、轮询频率需要真机验收时手感调参,当前只是工程判断的起点。
