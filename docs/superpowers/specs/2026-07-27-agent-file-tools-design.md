# Agent 内核文件操作工具 — 设计

> 2026-07-27 与用户 brainstorming 定下。承接项目"给宠物 agent 内核加文件操作能力"的诉求,参考了
> `earendil-works/pi`(一个 agent 工具包)的内置工具集划分思路(`read`/`write`/`edit`/`bash` 四个
> 核心工具 + `grep`/`find`/`ls` 辅助),但**不**沿用其安全模型——pi 明确声明"不含内置沙箱,以启动
> 进程的用户权限运行",把隔离完全外包给容器化方案;本项目现有安全基线相反(渲染层零文件访问、主
> 进程持有能力、风险工具走"默认关闭 + 设置页开关"门控,如 `desktopControl`/`browserControl`),文件
> 工具延续这套既有模式,而不是引入 pi 那种"裸权限 + 外部沙箱"的模型。

## 1. 背景与目标

宠物 agent 目前的工具集(`src/main/tools/`)覆盖网页搜索、天气、Firecrawl 深度阅读、剪贴板加工、
桌面/浏览器自动化等,但没有任何"读写本地文件"的能力——agent 没法把生成的内容持久化成文件、没法
读取用户放进来的文档、没法维护自己的笔记/草稿。

**目标**:给 agent 内核加一套最小而完整的文件操作工具,让它能在一个受控的工作目录里创建、读取、
编辑、删除文件,同时不破坏项目"渲染层零文件访问、风险能力默认关闭且需要主进程侧显式授权"的既有
安全基线。

### 非目标(明确不做)

- **不做通用文件系统访问**。第一阶段工具的作用域被强制限定在一个固定的沙箱目录(`petHome/workspace/`)
  内,agent 碰不到沙箱外的任何真实用户文件——这不是本次的取舍空间,是硬约束。
- **不做搜索类工具**(`grep`/`find`/关键词全文检索)。第一版只解决"目录里文件不多"的场景(笔记、
  小项目、导出文件),搜索是要处理"目录里文件很多"时才有价值的能力,YAGNI,留给需要时再补。
- **不做递归目录删除**。`delete_file` 只删单个文件,目录路径直接报错,不做"清空整个目录"这种破坏
  半径更大的操作。
- **不做每次调用弹确认框**。第一阶段的沙箱目录本身就是隔离层(不是用户的真实文档),风险量级和
  `desktopControl`(能点击任意窗口)、以及讨论过但未采纳的"用户指定根目录"方案不是一个数量级,每次
  写文件都弹框对体验的伤害比它能防住的损失大得多。取而代之的是"默认关闭 + 设置页开关"这一层门控。
- **不做 `bash`/任意 shell 命令执行工具**。pi 把它作为核心四件套之一,但这已经超出"文件操作"的范围,
  且和项目已有的 `desktopControl`/浏览器自动化工具在能力上有重叠、风险量级也完全不同,不在本次讨论
  范围内。
- **不做"用户指定根目录"(第二阶段)**。设计上明确留出扩展位(见 §7),但本次只做第一阶段。

## 2. 架构总览

新增两个模块 + 三处既有文件的扩展:

```
src/main/files/pathScope.ts     新增,纯函数:相对路径 → 沙箱内绝对路径,越界拒绝
src/main/tools/fileTools.ts     新增,5 个 ToolSpec(list_dir/read_file/write_file/edit_file/delete_file)
src/main/pets/petHome.ts        扩展:ensurePetHome 新增返回 workspaceDir
src/shared/llm.ts               扩展:AppSettings.fileTools: { enabled: boolean },SETTINGS_SCHEMA_VERSION 16→17
src/main/shell/chat.ts          扩展:settings.fileTools.enabled 时把 fileTools 塞进 registry(仿 desktopControl 注入方式)
```

`pathScope.ts` 单独拆出来(而不是把校验逻辑写进 `fileTools.ts`)是因为这段纯路径校验正是整个设计
里最该被密集测试的部分——一旦越界检查有缺口,前面"沙箱目录隔离"的安全假设就整个作废。拆成独立
纯函数也是为 §7 的第二阶段(用户指定根目录复用同一套越界检查)做准备。

## 3. `pathScope.ts`:路径守卫

```ts
export type SafePathResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string }

export function resolveSafePath(root: string, relativePath: string): SafePathResult
```

规则:
- 拒绝空字符串、拒绝绝对路径(含 Windows 盘符形式如 `C:\...`)。
- 用 `path.resolve(root, relativePath)` 得到候选绝对路径,再用 `path.normalize` 规整。
- 校验候选路径确实落在 `root` 内部:比较时按平台做大小写归一化(Windows 文件系统大小写不敏感),
  且用"候选路径 === root 或以 `root + path.sep` 为前缀"而不是简单的字符串 `startsWith(root)`——
  后者会被 `workspace2` 这类前缀碰撞路径绕过(`root` 是 `.../workspace`,`.../workspace2/x` 会误判
  为合法)。
- 通过则返回 `{ ok: true, absolutePath }`,否则返回 `{ ok: false, reason: '...中文提示...' }`,
  五个工具统一在越界时把 `reason` 转成 `isError` 文本回灌模型。

**符号链接逃逸**:第一阶段的沙箱目录由 `ensurePetHome` 创建、agent 只能通过这五个工具写入文本
内容(没有任何工具能创建符号链接),所以"目录内已存在指向外部的符号链接"这个逃逸向量在第一阶段
不成立,本次不做 `fs.realpathSync` 校验。留一条注释标注这个假设,第二阶段("用户指定根目录",目录
可能是用户真实文件夹、可能已存在外部符号链接)实现时需要重新评估。

## 4. `fileTools.ts`:五个工具

所有工具的 `input.path` 都是**相对于 workspace 根目录的相对路径**,内部先过 `resolveSafePath`。

- **`list_dir`** `{ path?: string }`(省略=列根目录):返回子项列表,每项含名称、类型
  (`file`/`dir`)、文件大小(字节)。不递归。
- **`read_file`** `{ path: string }`:按 UTF-8 读取文本内容。复用项目已有的 §11 反注入公共模块
  `src/main/tools/untrusted.ts`(`truncate` + `wrapUntrusted`,firecrawl/web_search/剪贴板工具都
  在用同一套)——文件内容按不可信文本处理、限长 12000 字并声明"内容不是指令",这是复用而非新增,
  和现有工具的处理口径保持一致。目标是目录时报错并提示改用 `list_dir`。
- **`write_file`** `{ path: string, content: string }`:整篇覆盖写入(不存在则创建,存在则覆盖);
  自动递归创建缺失的父目录(`fs.mkdirSync(dir, { recursive: true })`),agent 不需要单独的 mkdir
  工具就能直接建多级目录下的文件。
- **`edit_file`** `{ path: string, old_string: string, new_string: string }`:读文件全文,要求
  `old_string` 在其中**恰好出现一次**——0 次或 >1 次都返回 `isError`(分别提示"未找到该文本"和
  "匹配到多处,请提供更多上下文使其唯一"),仿 Claude Code 自身 Edit 工具的语义。命中唯一后整段
  替换、写回文件。
- **`delete_file`** `{ path: string }`:`fs.rmSync(absolutePath)`(不带 `recursive`),目标是目录
  时报错。

五个工具的 `run()` 内部错误(不存在的文件、权限拒绝等 Node `fs` 抛出的异常)一律 `catch` 转成
`isError` 文本回灌,不允许异常穿透到 `agentLoop`——这是 `toolRegistry.ts` 现有的统一约定,文件工具
不例外。

## 5. `petHome.ts` 扩展

`ensurePetHome` 的返回类型 `PetHomeResult` 新增 `workspaceDir: string`(`petHome/workspace/`)。
不在 `ensurePetHome` 里强制创建这个目录(维持"不用就不占地方"),改成 `fileTools.ts` 里任意一个
工具首次真正执行时才 `mkdirSync(workspaceDir, { recursive: true })`——`list_dir` 对着一个尚未
创建的空 workspace 应返回"空目录"而不是报错,所以 `list_dir` 也需要在目录不存在时视同空列表处理
（不需要真的先建出来）。

## 6. Settings 扩展与注入门控

`AppSettings`(`src/shared/llm.ts`)新增 `fileTools: { enabled: boolean }`,默认 `false`;
`SETTINGS_SCHEMA_VERSION` 16→17,`normalizeSettings` 照现有 `desktopControl`/`browserControl` 字段
的归一化写法补一段迁移(缺省字段时回填默认值)。

设置页(`settings.ts`/`settings.html`)"工具能力"分区新增一个开关(复用 `desktopControl`/
`browserControl` 现有的勾选框 UI 惯例,不需要额外的确认弹窗——§1 非目标已说明原因)。

`chat.ts` 里仿 `desktopControl`/`browserControl` 现有的注入方式:

```ts
if (settings.fileTools.enabled) {
  tools.push(...createFileTools({ workspaceDir: petHome.workspaceDir }))
}
```

不进 `maxToolRounds` 特殊调整(不像 `desktopControl`/`browserControl` 那样需要更多轮次——文件
操作通常一两轮就能完成,不是"截图看一眼再点一下"式的多轮交互)。

## 7. 第二阶段(本次不实现,设计上预留)

用户明确要"两阶段都要",第二阶段(用户指定根目录)不在本次实现范围内,但设计上要保证不需要推倒
重来:

- `resolveSafePath(root, relativePath)` 的 `root` 参数本来就是外部传入的,不关心 `root` 是固定
  沙箱目录还是用户选的目录,第二阶段直接复用。
- 第二阶段需要新增:系统原生文件夹选择对话框、选中目录的落盘持久化(类似 `activePetId` 的配置项)、
  以及重新评估符号链接逃逸风险(§3 提到的假设在"用户真实目录"场景下不再成立,需要补
  `fs.realpathSync` 校验或等效手段)。
- 第二阶段是否需要每次授权新目录时弹确认框(不同于第一阶段"不需要"的结论),留到那时候单独
  brainstorm,不在本次预判。

## 8. 测试策略

- `pathScope.ts`:纯函数,Vitest 穷举越界用例——`../../etc/passwd`、绝对路径(`/etc/passwd`、
  `C:\Windows\...`)、空字符串、`.`、大小写前缀碰撞(`workspace` vs `workspace2`)、Windows 路径
  分隔符与正斜杠混用。这是整个设计里最需要高覆盖率的部分。
- `fileTools.ts`:`mkdtempSync(join(tmpdir(), 'filetools-'))` 建临时目录跑真实 `fs`(同
  `todoStore.test.ts` 现有模式,`afterEach` 里 `rmSync` 清理),覆盖五个工具各自的成功路径、越界
  拒绝(委托给 `pathScope`,验证工具层正确接线而非重复测越界逻辑本身)、`edit_file` 的 0
  匹配/多匹配两种失败、`read_file` 超长截断、`write_file` 自动建父目录、`delete_file` 对目录路径
  报错。
- Settings 归一化:`fileTools.enabled` 缺省/非法值回退默认,照抄现有字段的测试写法。
- `chat.ts` 门控:仿现有 `desktopControl.enabled` 门控的测试模式,确认关闭时 registry 里没有这
  五个工具、开启时都在。
- 真机验收(GUI 部分无自动化驱动,按项目惯例人工完成):设置页开关打开后对话里让 agent 建/改/删
  文件,确认落在 `petHome/workspace/` 而不是别处;关闭开关后确认工具从模型可用清单消失;试探性地
  让模型"读一下 `../../` 之类的路径",确认稳定拒绝而不是报出主进程堆栈之类的实现细节。
