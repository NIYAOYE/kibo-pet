# Phase 1 Electron 升级 — 升级前基线

日期:2026-07-20
Worktree:`.claude/worktrees/live2d-phase1-electron-upgrade`(分支 `worktree-live2d-phase1-electron-upgrade`,base = 当时的 `main` @ `e607d16`)
说明:此时 Phase 0(GPU reboot-degrade,worktree `gpu-accel-reboot-degrade`)**尚未合并进 main**,本阶段按计划的 Task 5 Step 3 fallback 走"单一软渲染模式回归"。

## 升级前版本

```
electron:         ^31.0.0
electron-vite:     ^2.3.0
electron-builder:  ^24.13.3
```

## 自动化基线

```
pnpm typecheck   → 通过,无错误
pnpm test        → 89 files / 789 tests 全部通过
                   (首次运行 pets/luluka 缺失导致 petLoader.test.ts 1 个失败——
                    非回归,worktree 是全新 git checkout,pets/luluka 按 CLAUDE.md
                    是有意 gitignore、仅存在于主仓库磁盘;从主仓库 cp -r pets 拷入
                    worktree 后复测,789/789 全绿)
pnpm build       → 三包(main/preload/renderer)均构建成功
```

**基准数字(供 Task 4 对照)**:N = 789(全部通过,0 失败)。

## 手动冒烟基线

本 sandbox 无显示器,升级前手动冒烟由用户在真机完成(按项目既定惯例)。Task 5/6 的真机回归需覆盖:透明置顶窗渲染 idle 动画、拖拽跟手、点击穿透、托盘退出、任务栏不显图标。

## Electron 内置运行时版本(升级前,记录用)

未在本 Task 单独起 Electron 进程探测 `process.versions`;留给 Task 2 Step 5 与升级后版本一并对照记录。

## Task 2:升级后版本(2026-07-20)

```
electron:         43.1.1   (精确 pin,原 ^31.0.0)
electron-vite:     5.0.0   (精确 pin,原 ^2.3.0)
electron-builder: 26.15.3  (精确 pin,原 ^24.13.3)
vite:             ^6.4.3   (被迫最小上调,原 ^5.3.0;原因见下)
```

`npm view` 依据(执行时查得,均非 deprecated):

```
npm view electron@^43.0.0 version   → 43.1.1 是当前最新 43.x patch(43.0.0/43.1.0/43.1.1)
npm view electron-vite version      → 5.0.0(peerDependencies.vite: "^5.0.0 || ^6.0.0 || ^7.0.0",无硬编码 Electron 版本上限——它只在构建/dev 时 externalize 'electron' 模块,不校验 Electron 版本号)
npm view electron-builder version   → 26.15.3(无 electron 版本硬约束,靠自身逻辑适配)
```

### 被迫的 vite 最小上调(electron-vite 5.0.0 的类型定义问题)

pin 好 electron-vite@5.0.0 后,`electron.vite.config.ts` 在原 vite ^5.3.0(实测锁定 5.4.21)下 `pnpm typecheck` 报:

```
electron.vite.config.ts(7,14): error TS2769: No overload matches this call.
  Object literal may only specify known properties, and 'rollupOptions' does not exist in type 'MainBuildOptions'.
```

排查:electron-vite@5.0.0 的 `MainBuildOptions`/`PreloadBuildOptions` 类型继承自 vite 的 `BuildEnvironmentOptions`(vite 6 引入的 Environment API 类型),而 vite 5.4.21(vite 5.x 最新版,已核实无更高 5.x)整个包里**不存在**这个类型导出(`grep -r BuildEnvironmentOptions node_modules/vite` 零命中)。也就是说 electron-vite@5.0.0 虽然 `peerDependencies` 仍声明兼容 vite ^5,但其类型定义实际要求 vite 6+ 才能编译通过——这是 electron-vite 自身的问题,不是本项目 config 写法的问题。

处理:按 Task 2 brief 允许的"仅当 Step4 报不兼容才最小上调"原则,把 `vite` 从 `^5.3.0` 上调到 `^6.4.3`(vite 6.x 最新 patch,而非直接跳到 vite 7,尽量保持改动最小)。`electron.vite.config.ts` 本身**未做任何改动**——升级 vite 后原有 `rollupOptions` 写法就能正常通过类型检查,说明这纯粹是类型定义版本错配,不是配置形状的破坏性变更。

风险提示(留给 Task 4,**Task 2 复审已解除**):`vitest@2.1.9` 的 `dependencies.vite` 硬依赖 `^5.0.0`,与项目顶层 `vite@^6.4.3` 版本不一致;`node-linker=hoisted` 下 pnpm 为 vitest 单独嵌套安装了它自己的 vite@5。复审时已实测 `pnpm test`:789/789 通过,与升级前基线完全一致——该版本错配不影响测试运行,Task 4 无需为此单独排查。

`electron-builder.yml` 未做任何改动——升级到 26.15.3 后本 Task 范围内(`pnpm typecheck`/`pnpm build`)未触发它,`pnpm dist`(实际打包)未在本 Task 验证。

### Electron 43.1.1 内置运行时版本(实测)

通过 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "console.log(JSON.stringify(process.versions))"` 探测(仅用于一次性诊断,非常规启动方式):

```
electron: 43.1.1
node:     24.18.0
chrome:   150.0.7871.114
v8:       15.0.245.15-electron.0
```

宿主 `node -e "process.version"` = v24.15.0(与内置 node 24.18.0 接近但不同,属预期——Electron 内置 Node 是独立编译的)。

补充:Electron ≥42 起不再通过 npm `postinstall` 生命周期脚本下载二进制(`node_modules/electron/package.json` 没有 `scripts` 字段),而是改为 `require('electron')`(即 `node_modules/electron/index.js`)首次被调用时懒下载。`pnpm install` 本身**不会**触发下载——这与 plan 里"通常 pnpm install 仍会拉到二进制"的预期不符,已在此记录更正。`pnpm typecheck`/`pnpm build` 也不触发下载(只用 vite/tsc,不 spawn electron 二进制)。本 Task 为了拿到 process.versions,手动跑了一次 `node node_modules/electron/install.js` 触发下载。后续 `pnpm dev`/`pnpm preview`/`pnpm dist` 第一次运行时会自动懒下载(需要网络访问 Electron 的二进制分发源)。

### 自动化验证结果(Task 2)

```
pnpm typecheck   → 通过,无错误
pnpm build       → 三包(main/preload/renderer)均构建成功(vite v6.4.3)
pnpm test        → 本 Task 未运行(不在 brief Step4 范围,回归修复留给 Task 4)
```

## Task 3:breaking-change 审计(2026-07-20)

在 Electron 43.1.1 已装好(Task 2)的状态下,对 brief 审计表逐条 grep 复核(而非照抄 plan 预判)。全部命令针对 `src/` 目录运行,结果如下。

### Step 1 grep 结果

```
Grep 'File\.\w*\.path|\.file\.path|files\[\d+\]\.path|\bfile\.path\b'  src/
  → No matches found

Grep '\.path\b'  src/
  → 仅 2 处命中,均在 src/main/voice/realVoiceTransport.ts 的注释里,
    是 Python 侧 `os.path.exists(...)` 的引用说明文字,与 Electron File 对象无关。

Grep 'getPathForFile'  src/
  → No matches found

Grep 'setPreloads|getPreloads'  src/
  → No matches found

Grep 'getBitmap'  src/
  → No matches found

Grep 'toBitmap'  src/
  → No matches found

Grep 'appendSwitch|commandLine'  **/*.ts (repo 根,非仅 src/)
  → No files found

Grep 'nativeImage|NativeImage'  src/
  → 4 处真实用法,均为 createFromBuffer / createFromPath / createEmpty:
    - src/main/media/imagePrep.ts:14   nativeImage.createFromBuffer(buf)
    - src/main/pets/petAvatar.ts:29    nativeImage.createFromPath(sheetPath)
    - src/main/shell/tray.ts:8-9       nativeImage.createFromPath / createEmpty
    - src/main/screenCapture.ts:23     注释提及 nativeImage,非直接调用
    实读 imagePrep.ts / petAvatar.ts 全文确认:仅用
    getSize/resize/crop/toPNG/toJPEG/toDataURL/isEmpty,
    未用 getBitmap()/toBitmap(),v36/v43 两条 NativeImage 变更均不命中。

Grep 'clipboard'  src/
  → 命中 8 个文件。逐一核实:
    - src/renderer/dialog.ts:286        `e.clipboardData?.items`,DOM ClipboardEvent API,非 Electron 模块
    - src/main/tools/clipboardTools.ts  仅定义 `{ readText: () => string }` 依赖注入接口,未直接 import electron
    - src/main/shell/index.ts:1,430     `import { ..., clipboard, ... } from 'electron'`
                                         `clipboard.readText()/writeText()` ——仅在主进程使用,
                                         注入给 clipboardTools 的依赖对象。
    确认:Electron `clipboard` 模块仅存在于主进程;渲染层是纯 DOM clipboardData。v40 渲染层弃用条目不命中。

Grep 'showOpenDialog'  src/
  → 命中 src/main/shell/index.ts 共 7 处调用(选图 MEDIA_PICK_IMAGE、importPet 选文件夹/zip、
    语音安装路径选择器、运行时压缩包选择器等),均未传 defaultPath。
    v43 起无 defaultPath 时默认起始目录变为 Downloads(不再记忆上次选择目录)——
    这条**确认命中**,但性质是纯运行时 UX 行为变化(用户每次打开对话框看到的默认文件夹变了),
    不是编译期/类型破坏,代码无需改动。留 Task 5 真机验收时确认可接受。
```

### 逐行判定

| 版本 | 变更 | grep 复核结果 |
|---|---|---|
| v32 | `File.path` 移除 | 确认 no-op(零命中,`.path` 仅命中不相关的 Python 注释) |
| v32 | navigationHistory API 迁移 | 确认 no-op(未用) |
| v33 | 原生模块需 C++20 | 确认 no-op(无原生模块,`package.json` 无 node-gyp 依赖) |
| v33 | 自定义协议 Windows 路径处理变化 | 确认 no-op(`kibo-pet://` 未在本仓库出现,Phase 2 事项) |
| v35 | preload 注册 API 替换 | 确认 no-op(`setPreloads`/`getPreloads` 零命中,用的是 `webPreferences.preload`) |
| v36 | `NativeImage.getBitmap()`→`toBitmap()` | 确认 no-op(`getBitmap`/`toBitmap` 零命中;imagePrep/petAvatar 实读确认只用 createFromBuffer/createFromPath+toPNG/toJPEG/toDataURL) |
| v36 | `app.commandLine` switch 转小写 | 确认 no-op(`appendSwitch`/`commandLine` 全仓库零命中) |
| v39 | desktopCapturer macOS 权限 | 确认 no-op(macOS-only,本项目 Windows-only) |
| v40 | 渲染层 Electron `clipboard` 弃用 | 确认 no-op(渲染层用 DOM `clipboardData`;Electron `clipboard` 只在 `src/main/shell/index.ts` 主进程使用) |
| v42 | electron 不再 postinstall 下载 | Task 2 已记录(懒下载改为 `require('electron')` 首次触发),非本 Task 范围 |
| v43 | dialog 默认目录改 Downloads | **确认命中**(7 处 `showOpenDialog` 调用均无 `defaultPath`),但为非破坏性运行时 UX 变化,不改代码,留 Task 5 真机验收 |
| v43 | `NativeImage.toBitmap()` 归一化 sRGB | 确认 no-op(`toBitmap` 零命中) |

### 结论

代码侧 breaking-change **零命中**,与 plan 预判一致。唯一真实命中项(v43 dialog 默认目录变 Downloads)是运行时 UX 行为变化,非代码破坏,本 Task 不做代码改动,留 Task 5 手动验收确认可接受。

Step 3(imagePrep/petAvatar 图像往返健全性)因二者 import electron 无法被 Vitest 直接跑,按既定约定留待 Task 5 真机手动验收:识图选 png + jpg 能正常降采样识别、宠物头像在聊天左栏正常显示、托盘图标正常。

本 Task 未运行 `pnpm typecheck`/`pnpm test`/`pnpm build`(brief 允许:无代码改动时无需重新验证;Task 2 已验证过 typecheck/build 绿,Task 4 会跑一次完整 789 用例回归)。

## Task 4:自动化回归复跑(2026-07-20)

在 Task 3 无代码改动的 HEAD(`12c8504`)上按 brief 逐条重跑:

```
pnpm test        → 89 files / 789 tests 全部通过,与基线 N=789 完全一致,0 新增失败
pnpm typecheck    → 通过,无错误
pnpm build        → 三包(main/preload/renderer)均构建成功
```

零改动、无需提交(与升级前基线逐条对齐,Electron 31→43 升级对现有 789 个测试零回归)。

## Task 5:开发态手动回归矩阵(2026-07-20)

本 Task 绝大部分要求真实 Windows 显示器/键鼠交互(拖拽跟手、DPI、多屏、TTS 实际发声等),按项目既定惯例由用户在真机完成——下方"待用户验收清单"列出全部未验证项。

**但本次 controller 探测发现,当前 agent 会话环境与以往记录的"全程无显示 sandbox"不同**:`Session: 1`(非 Session-0 服务会话)、`[Environment]::UserInteractive = True`。据此直接执行了一次可行的自动化子集——**冒烟启动验证**(区别于完整肉眼 GUI 走查):

```
1. unset ELECTRON_RUN_AS_NODE(shell 里此变量默认被设为 1,是 CLAUDE.md 记录的已知坑;
   不 unset 会导致 Electron 以纯 Node 跑并崩溃)
2. pnpm preview 后台启动
3. 8 秒后:tasklist 确认 7 个 electron.exe 进程存活(browser+GPU+renderer+utility 的正常
   Electron 多进程模型,内存占用量级合理,45MB~167MB/进程)
4. PowerShell Get-Process 确认存在一个真实 MainWindowTitle="kibo-pet" 的窗口
   (证明不只是后台进程存活,而是真的创建并渲染了一个 OS 窗口——这是 typecheck/build
   通过之外的额外证据,证明升级后应用能真正跑起来而非仅编译通过)
5. 又等 4 秒(共 12 秒存活),复查窗口仍在、日志无新增错误
6. 检查 userData 目录(`%LOCALAPPDATA%\Kibo\` / `%APPDATA%\Pet-Agent\`)均不存在
   ——即没有触发 `src/main/index.ts` 的 uncaughtException/startup-crash.log 兜底写盘,
   与"零崩溃"一致
7. taskkill //F //IM electron.exe 干净终止全部 7 个进程,复查确认无残留
```

**结论**:Electron 31→43 升级后应用真实启动、创建窗口、运行 12 秒无崩溃、无错误日志——这是比自动化测试更强的运行时证据,但**不等于**完整 GUI 验收(未做任何鼠标/键盘交互,未肉眼确认宠物精灵渲染正确、透明背景生效、点击穿透生效等)。

### 待用户验收清单(仍需真机人工完成,未被上述冒烟测试覆盖)

- 透明置顶窗渲染 luluka + idle 动画(冒烟测试只confirm窗口存在,未确认内容正确渲染)
- 点击穿透:透明区域点击穿透、宠物像素上不穿透
- 拖拽移窗:跟手、跨屏/不同 DPI 不漂移
- 托盘:右键菜单、退出;任务栏不显图标
- 全局热键呼出/关闭对话框
- 设置窗、聊天流式回复、Markdown 渲染、来源链接外开
- 气泡窗跟随 + 自适应高度
- 待办面板增删改 + 到点提醒
- 截屏 + 桌面控制(click_at/type_text/focus_window 实际生效、提示条显示、人工接管中断)
- 浏览器控制(Playwright 隔离 profile)
- 语音 Sidecar 实际发声 + 切宠物端口释放重启
- 图像往返(承 Task 3):png/jpg 识图、宠物头像、托盘图标
- **v43 dialog 目录变化**(承 Task 3 发现):选图/导入宠物文件夹/选语音安装路径默认目录变 Downloads——确认可接受
- **GPU 两模式回归**:Phase 0(`gpuBootDecision`)尚未合并进 main,本阶段仅验证了默认软件渲染模式的冒烟启动;硬件加速实验开关模式的回归留待 Phase 0 合并后补做(按 plan Task 5 Step 3 fallback)
