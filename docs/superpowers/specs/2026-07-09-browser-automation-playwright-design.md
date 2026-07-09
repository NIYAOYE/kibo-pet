# 浏览器自动化(Playwright)工具集 — 设计

> 2026-07-09 与用户 brainstorming 定下。承接前一天(2026-07-08)的「Agent 工具调用循环健壮性改进」——那次修复
> 解决了"能不能稳定执行"的问题,这次解决"用什么手段执行更靠谱"的问题:用户提出用 Playwright 给宠物加一套
> **浏览器专用**自动化能力,取代 `desktopControl`(OS 级截屏+鼠标+键盘)在浏览器场景下"看图猜坐标点击"的角色。

## 1. 背景与目标

已有 `desktopControl`(`src/main/automation/` + `src/main/tools/desktopTools.ts`,见
`2026-07-08-desktop-control-tools-design.md`)可以驱动任意桌面软件,包括浏览器——但走的是
"截屏 → 模型看图给坐标 → `click_at` 物理点击"的通用路径,对工具调用能力弱的模型(gpt-5.4/
gpt-5.4-mini)不友好,坐标误判、点不中地址栏等问题在真机验收中已经出现过。Playwright 能通过
DOM/可访问性树按**文字/角色**定位元素,不需要模型猜坐标,对弱模型更友好,而且能读取页面正文、
等待动态加载、管理多标签页——这些是纯 OS 级鼠标键盘做不到或很难做到的。

同时项目里已有 Firecrawl(`read_url`/`extract_from_url`)做"一次性网页正文抓取",但它不支持点击/
填表/登录态,不能覆盖"帮我在某个网站上点几下、填个表单"这类交互式任务。

**目标**:新增一套浏览器专用工具集,与 `desktopControl`、Firecrawl **并存**,面向"需要点击/填表/
翻页/登录态"的交互式网页任务;`desktopControl` 继续覆盖非浏览器软件,Firecrawl 继续覆盖只读正文
场景,三者分工不重叠。

### 非目标(明确不做)

- 不用 Playwright 取代 Firecrawl 的一次性正文抓取能力(Firecrawl 已完成并验收,场景不同,没必要重做)。
- 不下载/打包独立的 Chromium 二进制——用 `playwright-core` + `channel:'chrome'` 复用用户已装的
  Chrome/Edge,不做"机器上没有 Chrome 也能用"的兜底(不常见场景,超出本次范围)。
- 独立实例模式不做 profile 跨对话/重启持久化(不缓存登录态),需要登录态的任务走 CDP 模式。
- CDP 模式不自动帮用户关闭/重启已经打开且未带调试参数的浏览器(避免强杀用户未保存的标签页/表单)。
- 不在浏览器场景复刻 `desktopControl` 的"正在控制鼠标"悬浮条视觉提示——浏览器窗口本身(尤其独立
  实例模式的 headed 窗口)已经是最直观的反馈,重复做一层意义不大。
- 不做跨平台(mac/linux)专门适配——`channel:'chrome'` 本身跨平台,但本仓库目前只面向 Windows,
  沿用现有约定不额外验证。

## 2. 两种接管模式

用户在设置里选择,默认关闭 + 默认「独立实例」模式:

### 2.1 独立实例模式(默认)

`playwright-core` 的 `chromium.launch({ channel: 'chrome', headless: false, ... })`:
- **复用用户已安装的 Chrome/Edge 可执行文件**,但不指定 `userDataDir` 复用真实 profile —— Playwright
  默认会用一个全新的临时用户数据目录,天然与用户真实登录态、书签、扩展隔离。
- **headed(窗口可见)**:用户能实时看到 AI 在浏览器里做什么,与 `desktopControl` 的"透明可见"理念
  一致,不需要额外悬浮标识。
- **不持久化**:每次这套浏览器被启动都是全新环境(临时 profile 用完即弃),没有跨对话/跨重启保留的
  登录凭据——与项目里"图片/剪贴板原文不落盘"的一贯克制取向一致。
- 需要登录态的网站在这个模式下每次都得重新登录——这是刻意的取舍,不是遗漏。

### 2.2 CDP 接管模式(可选,风险更高)

`playwright-core` 的 `chromium.connectOverCDP('http://127.0.0.1:<port>')` 连上用户**已经用**
`--remote-debugging-port=<port>` 启动的真实 Chrome/Edge:
- 能操作用户真实登录的账号/会话——风险明显高于独立实例模式(可能被诱导在已登录网站上做误操作)。
- 连接失败(目标浏览器没带调试参数在跑)时,**不自动帮用户关闭重启**——给出清晰报错 + 手动操作指引
  (提示用户手动关闭现有 Chrome,用给出的命令行参数重新打开,再重试)。
- 切换到这个模式时,在下面 §4 的基础风险确认弹窗之外,**额外**弹一次强确认,专门提示"会操作你已
  登录的真实账号"。

## 3. 工具集

沿用现有 `src/main/tools/toolSpec.ts` 的 `ToolSpec` 接口(与 `desktopTools.ts`/`webSearch.ts` 等同一套
机制),新文件 `src/main/tools/browserTools.ts`。工具名统一 `browser_` 前缀,与 `desktopTools.ts` 的
`click_at`/`type_text` 等区分开,避免模型混用两套坐标体系。

| 工具 | 入参 | 行为 |
|---|---|---|
| `browser_navigate` | `{ url }` | 跳转当前活动标签页到指定 URL;若浏览器尚未启动,首次调用触发懒启动。 |
| `browser_click` | `{ text, selector? }` | 按可见文字定位并点击;优先常见可交互角色(按钮/链接)匹配 `text`,退化到纯文本匹配;传了 `selector` 则直接按 CSS 选择器定位(高级/兜底用法)。不需要模型给坐标。 |
| `browser_fill_text` | `{ text, value }` | 按标签/占位符/附近文字定位输入框(`text`)并填入 `value`。 |
| `browser_read_text` | *(无)* | 读取当前页面可见正文,截断(参考 Firecrawl `truncate()` 的做法),给模型判断页面内容/验证操作结果用。 |
| `browser_screenshot` | *(无)* | 当前页面截图,复用现有 `ToolRunOutput.images` 回灌机制(同 `take_screenshot`/Firecrawl 的图像返回方式)。 |
| `browser_scroll` | `{ direction: 'up'\|'down', amount?: 'page'\|'small' }` | 上下滚动当前页面。 |
| `browser_wait_for` | `{ text }` | 等待指定文字出现在页面上(应对 SPA 动态加载),有限超时(如 10s),超时给明确报错而不是挂起。 |
| `browser_list_tabs` | *(无)* | 列出当前打开的标签页(序号+标题+URL)。 |
| `browser_open_tab` | `{ url? }` | 新开一个标签页并设为当前活动标签页,可选立即导航。 |
| `browser_switch_tab` | `{ index }` | 把已有的某个标签页切为当前活动标签页,后续动作作用于它。 |
| `browser_close` | *(无)* | 主动结束本次浏览器自动化会话(关闭浏览器进程/连接)。 |

## 4. 生命周期与模块结构

新目录 `src/main/browserAutomation/`,呼应 `src/main/automation/` 的纯函数/副作用分层:

| 文件 | 职责 |
|---|---|
| `browserAutomation/browserLifecycle.ts` | **纯函数**:根据 `settings.browserControl`(`enabled`/`mode`)算出启动参数——独立实例模式的 `launch()` 选项,或 CDP 模式的连接目标 URL。可单测(输入 settings → 输出启动配置对象)。 |
| `browserAutomation/browserControl.ts` | **副作用外壳,但边界可注入、逻辑可单测**(同 `automation/automationControl.ts` 先例——那个文件注入 `execFile` 后用假 stdout 测分支逻辑,不需要真的跑 PowerShell;这里同理注入一个最小的 Playwright 驱动接口,用假 Page/Browser 桩测状态管理与分支逻辑,不需要真的起浏览器):持有当前 Playwright `Browser`/`BrowserContext`/`Page` 状态,包装成 `navigate`/`click`/`fill`/`readText`/`screenshot`/`scroll`/`waitFor`/`listTabs`/`openTab`/`switchTab`/`close` 方法。浏览器被用户手动关闭(点了窗口的 ✕)后,下一次调用要给清晰的"浏览器已关闭"报错(下次 `browser_navigate` 时允许重新懒启动),不能让整个工具调用崩溃或悬挂。 |

**生命周期(关键设计点)**:浏览器实例是**主进程单例、跨对话轮次存活**——不是每次 `handleSend` 都
重新创建。理由:多步网页任务天然跨越多条用户消息("打开B站"→下一句"点第一个视频"),如果每轮对话
都重开浏览器,当前标签页/导航状态就会丢失,交互式浏览器自动化的核心价值就没了。这与 `screenshotState`
("每次 `handleSend` 都是全新一个 —— 每轮对话自然重置",见 `chat.ts:253` 注释)是**不同的生命周期
模型**,实现时要分清楚,不要照抄 `screenshotState` 的每轮重建模式。

浏览器控制单例在 `shell/index.ts` 里和 `automationControl` 一样在启动时创建一次(懒启动实际浏览器
进程,创建时只是构造控制对象)。关闭时机:
- 模型显式调用 `browser_close`;
- 用户在设置里关闭 `browserControl.enabled` 开关时主动关闭,不留孤儿浏览器进程;
- app 退出时,接入现有 `app.on('will-quit', ...)` 清理链(`shell/index.ts:580`,与
  `unregisterHotkeys()`/`scheduler.stop()`/`idleWatcher.stop()` 同一处一起清理)。

## 5. 设置与风险确认

`src/shared/llm.ts` 新增:

```ts
export type BrowserControlMode = 'isolated' | 'cdp'
export interface BrowserControlSettings { enabled: boolean; mode: BrowserControlMode }
```

`AppSettings` 新增 `browserControl: BrowserControlSettings` 字段,默认
`{ enabled: false, mode: 'isolated' }`。`SETTINGS_SCHEMA_VERSION` 7→8,迁移逻辑仿照
`desktopControl` 当年 6→7 的写法(缺省字段按默认值补齐)。

设置窗口新增一节(仿 `desktopControlEnabled` 的现有交互模式,`src/renderer/settings.ts`):
- 开启总开关(`enabled`)时,复用现有 `confirmDesktopControl` 那一套原生
  `dialog.showMessageBox` 确认弹窗模式,新增 IPC `CONFIRM_BROWSER_CONTROL`,文案说明"AI 可以自主
  打开独立浏览器窗口浏览/操作网页"。
- 模式选择器切到 `'cdp'` 时(无论是开启时选的还是之后改的),**额外**弹一次确认,新增 IPC
  `CONFIRM_CDP_MODE`,文案专门提示"会操作你已登录的真实浏览器账号,请确认目标浏览器已用调试参数
  启动"。

## 6. 依赖与打包

新增运行时依赖 `playwright-core`(不是完整 `playwright`,不含浏览器下载器)。这是 `src/main/automation/`
系列自动化模块第一次引入真正的新增 npm 依赖(此前 `desktopControl` 刻意做到零新增依赖,纯 PowerShell
+ Win32 P/Invoke)——需要向用户明确指出这个取舍,不是隐含决定。

打包方面(`electron-builder.yml`):
- `playwright-core` 自带一个 Node 驱动进程(通过 stdio 与主进程通信,负责实际发 CDP 协议指令),
  需要在 `electron-builder.yml` 补 `asarUnpack` 覆盖其驱动文件所在路径,否则打包进 `app.asar`
  后可能无法作为子进程正常启动。
- **必须**做一次真实的 `pnpm build` + 打包产物(NSIS 安装或至少 `dist/win-unpacked/`)冒烟测试,
  不能只信 `pnpm dev`/`pnpm preview`——参考项目记忆里 `packaged-gui-gpu-crash` 的教训:某些问题只在
  真实打包产物里出现,开发模式发现不了。这一步应作为实现计划的一个独立、明确的验收任务,而不是顺带
  一提。

## 7. 测试策略

- `browserAutomation/browserLifecycle.ts`:纯函数,TDD 单测(不同 `settings.browserControl` 输入 →
  正确的 launch 参数 / CDP 连接目标)。
- `browserAutomation/browserControl.ts`:与 `automation/automationControl.ts` 同一先例——注入一个最小
  的 Playwright 驱动接口(launch/connectOverCDP + Page 用到的那几个方法),单测用假驱动/假 Page 桩
  覆盖状态管理与分支逻辑(活动标签页切换、浏览器已关闭后的报错、`waitFor` 超时等),不需要真的起
  浏览器。真实 Playwright 驱动接口本身(`chromium.launch`/`connectOverCDP` 是否真的能连上真实浏览器)
  不做单测,靠真机验收。
- `tools/browserTools.ts`:仿 `desktopTools.test.ts` 的做法——注入假的 `BrowserControl` 实现,单测
  每个工具的入参校验、成功/失败文案、`ToolRunOutput.images` 透传(`browser_screenshot`)等纯逻辑,
  不启动真实浏览器。
- 设置/IPC/风险确认弹窗:仿 `chat.test.ts`/现有 `confirmDesktopControl` 的测试方式。
- **真机验收清单**(自动化测试覆盖不到,需人工在真实 Windows 环境执行):
  - 独立实例模式:开启开关(触发确认弹窗)→ 让模型完成一个多步任务(如"打开B站搜索XX并点第一个
    视频")→ 确认浏览器窗口可见、每步都是真实点击/导航而非坐标蒙猜、任务跨多轮对话时标签页状态
    保持、`browser_close` 后浏览器进程真的退出、app 退出时没有孤儿浏览器进程残留。
  - CDP 模式:按提示手动带调试参数重启 Chrome → 触发额外的强确认弹窗 → 确认能操作到用户真实已登录
    的页面 → 验证"目标浏览器未带调试参数"时的报错文案和操作指引清晰可执行。
  - 打包产物冒烟:`pnpm build` 后的可执行文件里,浏览器自动化工具能正常触发(验证 §6 的 `asarUnpack`
    配置生效)。
