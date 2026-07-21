# GPU 硬件加速"重启降级"机制设计

## 背景

`src/main/index.ts:36` 当前全局调用 `app.disableHardwareAcceleration()`，是修复过一次真机崩溃留下的约束：某用户机器上硬件 GPU 子进程以 `0xC0000135` 退出，导致 Electron 主进程判定"GPU process isn't usable"后秒退（事件日志 `0x80000003`），表现为"双击打开、任务栏闪一下就消失"。当时的修复是在 `app.whenReady()` 之前强制禁用硬件加速，改用 SwiftShader 软件渲染，问题消失。

现在因为计划给宠物换一套基于 Live2D Cubism Web SDK 的呈现方式（另见同批次的 Live2D 集成工作），而 Cubism Web SDK 是 WebGL2 渲染，软件光栅化下的性能未知，用户想重新考虑"是否要一直全局禁用硬件加速"这件事。

查证后发现两个关键事实：

1. **Chromium 理论上有自动降级机制**（GPU 初始化失败时会自动降级到软件合成/SwiftShader），但**这不保证在所有故障场景下都生效**——`electron/electron#43955` 是一个几乎一样的案例：某公司几十台机器在启动时反复出现 GPU/Network 进程崩溃，开发者试了 `--disable-gpu`、`--disable-software-rasterizer`、`--disable-gpu-compositing`、`--disable-gpu-sandbox`、`--no-sandbox` 等所有常见 flag 组合均无效，Electron 官方最终把这个 issue 关成 "not planned"。这说明"进程内实时捕获 GPU 崩溃事件再动态切换渲染模式"这个思路不现实——真正致命的崩溃发生时主进程可能已经没了，根本没有"捕获事件再降级"的窗口。
2. **`app.getPath('userData')` 在 `app.whenReady()` 之前不保证可用**（Electron 官方文档 + 本项目 `main/index.ts` 里 `logDiag()` 函数自己就用 try/catch 包了这个调用，注释写着"userData 可能取不到"）。而 `app.disableHardwareAcceleration()` 必须在 `app.whenReady()` 之前调用（Electron 硬性要求，本项目现有注释也写明"必须在 app ready 前设置"）。任何依赖读取 `settings.json`（存在 userData 下）来决定是否禁用硬件加速的逻辑，都得在这个"读不到"的可能性下保持安全。

因此本设计采用一个更朴素的、不依赖"进程内捕获崩溃"的模式：**跨启动的标记文件 + 下次启动自动降级**（reboot-degrade）。这类模式在其他产品里也有先例（例如 VSCode 的"安全模式"思路：先记录"这次要正常启动"，成功后清除标记；标记残留说明上次没能正常收尾，下次改用降级模式）。

## 目标

1. 用户可以在设置页勾选"尝试启用硬件加速渲染（实验性）"，默认关闭，跟今天的行为（全局禁用）完全一致，勾选后需要重启生效。
2. 勾选后，本次启动尝试启用硬件加速；如果这次启动能正常跑到"宠物窗口渲染出内容"，就认为这台机器没问题，以后都保持硬件加速开启，不用每次都重新尝试。
3. 如果启用硬件加速导致启动失败（应用崩溃、来不及清除标记），**下一次**启动能自动检测到这个情况，强制改用软件渲染，并把设置里的开关自动关掉（不静默无限重试）。
4. 任何读取 `settings.json`/标记文件失败的情况，都必须安全地退回今天的行为（`disableHardwareAcceleration()`），不能因为这次新增的逻辑本身出错而让应用比今天更不稳定。
5. 核心决策逻辑（"给定开关状态和标记文件是否存在，这次启动该怎么办"）要是一个可独立单测的纯函数。

## 非目标

- 不做"进程内实时捕获 GPU 崩溃并动态切换"——已确认这条路线不可靠（见背景第 1 点），不浪费时间在这上面。
- 不改变现有默认用户的行为——不勾选实验性开关的用户，跟今天的代码路径完全一样（`disableHardwareAcceleration()` 无条件调用，标记文件逻辑整个不触碰）。
- 不做侵入式的失败提示弹窗——自动降级后开关本身会变回未勾选状态，这个状态在设置页可见，已经是足够的信号，不需要额外的通知 UI。
- 不涉及 Live2D 集成本身的任何代码——这是一个独立的基础设施改动，Live2D 会在这个机制之上、单独一次 brainstorming/spec/plan 里做。
- 不修改 `src/main/shell/index.ts` 的 `startShell()` 签名或内部逻辑——用 Electron 的 `app.on('browser-window-created', ...)` 全局事件挂"确认成功"的钩子，不需要 `startShell()` 对外暴露 `petWin`。

## 方案选择

### 采用：设置开关 + userData 标记文件 + `browser-window-created` 确认钩子

**持久化状态（两处，职责分开）：**

- `settings.json` 新增 `gpuAcceleration: { experimental: boolean }`（默认 `{ experimental: false }`），跟随现有 `AppFocusLlmOpenerSettings { enabled: boolean }` 的写法，`SETTINGS_SCHEMA_VERSION` 13→14。这是**用户的意愿**，走正常的 schema 迁移/normalizeSettings 流程。
- `userData` 下一个独立文件 `gpu-accel-boot.marker`（内容不重要，只看存在与否），代表"这次启动正在试硬件加速，还没确认成功"。这是**运行时的临时状态**，不属于用户配置，不进 `settings.json`。

**决策时机（`main/index.ts`，`app.whenReady()` 之前，`app.disableHardwareAcceleration()` 原本调用的位置）：**

1. 用 try/catch 包住"读 `userData` 路径 → 读 `settings.json` → 检查标记文件是否存在"这一整段；任何一步抛错，直接 `app.disableHardwareAcceleration()`（今天的行为），只记日志，不让新逻辑本身的失败影响启动。
2. 拿到 `{ experimentalHardwareAcceleration, markerPresent }` 后调用纯函数 `decideGpuBoot()` 得到决策，按决策执行：调不调用 `disableHardwareAcceleration()`、要不要写/清标记文件、要不要把设置里的开关改回 `false`。
3. 如果这次决定"尝试硬件加速"（写了标记文件），额外注册一次性的 `app.on('browser-window-created', (_e, win) => {...})`：拿到第一个被创建的窗口后，监听它的 `did-finish-load`，触发后再等几秒安全边际（原崩溃是"秒退"，几乎瞬间发生，几秒的延迟足够覆盖），才清掉标记文件——不是一渲染出来就立刻清。用一个闭包内的布尔值确保只清一次（哪怕后续还创建了别的窗口，比如对话框/设置窗）。

### 不采用：监听 `gpu-process-crashed`/`render-process-gone` 事件后动态切换

已通过 `electron/electron#43955` 确认这条路线在"GPU 完全不可用"这类致命场景下不可靠——问题恰恰是"根本走不到能触发这些事件的阶段就整体退出了"。这类事件适合处理"运行中途 GPU 进程偶发崩溃、Chromium 自动重启 GPU 进程"这种更温和的场景，但解决不了本设计要处理的"启动阶段直接 FATAL 退出"问题。

### 不采用：每次启动都无条件先试硬件加速，出问题再退回

如果不经过设置开关而是默认对所有用户（包括已安装的老用户）生效，第一次升级到这个版本的、曾经真的遇到过崩溃的那台机器，会先经历一次"打开又闪退"才能在下一次启动时自愈——用户体验上等于又崩溃了一次，哪怕最终会自动恢复。做成默认关闭、用户主动勾选的实验性选项，符合本项目一贯的"有风险的新能力默认关、用户自愿开启"惯例（`app_focus` LLM 开场白、TTS 后端手动选择、桌面控制确认弹窗都是这个模式），也避免了这个"先崩一次再自愈"的糟糕首次体验。

## 架构与组件

### 纯逻辑：`src/shared/gpuBootDecision.ts`

```ts
export interface GpuBootDecision {
  useHardwareAcceleration: boolean
  markerAction: 'write' | 'clear-and-disable-setting' | 'none'
}

export function decideGpuBoot(opts: {
  experimentalHardwareAcceleration: boolean
  markerPresent: boolean
}): GpuBootDecision {
  if (!opts.experimentalHardwareAcceleration) {
    return { useHardwareAcceleration: false, markerAction: 'none' }
  }
  if (opts.markerPresent) {
    // 上次启动写了标记但没能清掉,大概率是崩了——强制降级,且不再静默重试
    return { useHardwareAcceleration: false, markerAction: 'clear-and-disable-setting' }
  }
  return { useHardwareAcceleration: true, markerAction: 'write' }
}
```

三个分支覆盖全部输入组合，是一个完整、确定性的纯函数，可以直接 TDD。

### 主进程 IO 胶水：`src/main/index.ts`

在原本 `app.disableHardwareAcceleration()` 那一行的位置，改成类似（细节以实际实现为准）：

```ts
const markerFile = /* join(userData, 'gpu-accel-boot.marker') */
let decision: GpuBootDecision = { useHardwareAcceleration: false, markerAction: 'none' } // 安全默认值
try {
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  const settings = loadSettings(settingsFile)
  const markerPresent = existsSync(markerFile)
  decision = decideGpuBoot({
    experimentalHardwareAcceleration: settings.gpuAcceleration.experimental,
    markerPresent
  })
  if (decision.markerAction === 'clear-and-disable-setting') {
    rmSync(markerFile, { force: true })
    saveSettings(settingsFile, { ...settings, gpuAcceleration: { experimental: false } })
    logDiag('gpu-accel', '检测到上次启动的标记文件残留,判定硬件加速导致启动失败,已自动降级并关闭设置')
  } else if (decision.markerAction === 'write') {
    writeFileSync(markerFile, String(Date.now()))
  }
} catch (err) {
  logDiag('gpu-accel decision failed, falling back to safe default', err)
}

if (!decision.useHardwareAcceleration) app.disableHardwareAcceleration()

if (decision.markerAction === 'write') {
  let cleared = false
  app.on('browser-window-created', (_e, win) => {
    if (cleared) return
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (cleared) return
        cleared = true
        try { rmSync(markerFile, { force: true }) } catch (err) { logDiag('gpu-accel marker clear failed', err) }
      }, 3000)
    })
  })
}
```

不修改 `src/main/shell/index.ts`：`browser-window-created` 是 Electron 全局事件，任何地方创建的 `BrowserWindow`（宠物窗、引导导入窗等）都会触发，不需要 `startShell()` 对外暴露 `petWin`。

### 设置：`src/shared/llm.ts` + `src/main/config/settings.ts`

- `AppSettings` 新增字段 `gpuAcceleration: GpuAccelerationSettings`，`GpuAccelerationSettings { experimental: boolean }`，`DEFAULT_SETTINGS.gpuAcceleration = { experimental: false }`。
- `SETTINGS_SCHEMA_VERSION` 13→14。
- `normalizeSettings()` 里按现有 `appFocusLlmOpener` 的写法加一段防御式解析：`const ga = (r.gpuAcceleration ?? {}) as Record<string, unknown>; const gpuAcceleration = { experimental: ga.experimental === true }`。

### 设置页 UI：`src/renderer/settings.ts` / `settings.html`

新增一个默认不勾选的复选框"尝试启用硬件加速渲染（实验性）"，文案注明"需要重启生效"。跟现有换宠物（改 `activePetId` 后重启）走的是同一套已有约定，不需要发明新的"重启提示"UI 模式。

## 数据流

```text
main/index.ts 顶层(app.whenReady() 之前)
  -> try: 读 userData -> loadSettings -> 检查标记文件是否存在
       -> decideGpuBoot({experimental, markerPresent}) -> 决策
       -> markerAction=clear-and-disable-setting: 清标记 + saveSettings(关开关) + 记日志
       -> markerAction=write: 写标记
     catch: 记日志,decision 保持安全默认值(不用硬件加速)
  -> !decision.useHardwareAcceleration -> app.disableHardwareAcceleration()
  -> decision.markerAction=write -> 注册一次性 browser-window-created 钩子
       -> 首个窗口 did-finish-load -> 等 3s -> 清标记文件(确认这次启动成功)
  -> app.whenReady().then(() => startShell()) (不变)
```

## 测试策略

### 自动化回归测试

1. `decideGpuBoot()` 的三个分支（关闭开关、开启且无残留标记、开启且有残留标记）各写一个 Vitest 用例，覆盖全部输入组合。
2. `normalizeSettings()` 对 `gpuAcceleration` 缺省/畸形输入的防御式解析，参照现有 `appFocusLlmOpener` 测试的写法补一组用例。

### 构建验证

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

### 真机验证

1. **正常路径**：勾选实验性开关，重启，确认应用正常打开且宠物正常显示；检查 `userData` 下的标记文件在几秒后消失（说明确认成功的钩子生效了）；再重启一次，确认标记文件不会无意义地反复出现又消失。
2. **恢复路径（不需要真的复现原始崩溃）**：手动在 `userData` 下预先放一个 `gpu-accel-boot.marker` 文件，同时把 `settings.json` 的 `gpuAcceleration.experimental` 设为 `true`，然后启动应用——预期这次启动会强制走软件渲染、清掉标记文件、并把 `settings.json` 里的 `experimental` 自动改回 `false`。这条路径可以在真机上直接摆出这个前置状态来验证，不需要等一次真实的 GPU 崩溃。
3. **默认路径不受影响**：不动这个新开关，确认应用行为跟今天完全一样（全程走 `disableHardwareAcceleration()`，不产生任何标记文件）。
4. **真正的 GPU 致命崩溃触发这套机制**这件事本身，跟以往的经验一样无法在 agent 会话或普通开发机上主动复现，只能靠这套机制的逻辑本身经得起推敲（已通过上面两条真机验证覆盖了"能不能正确识别标记残留并降级"），不强求真的诱发一次真实崩溃来验证。

## 成功标准

- 不勾选实验性开关时，应用行为、设置项、启动流程与改动前完全一致。
- 勾选后能在真机上跑通"启用硬件加速 → 成功启动 → 标记文件自动消失 → 下次启动继续保持硬件加速"的正常循环。
- 手动摆出"标记文件残留"的前置状态时，能验证到应用正确地强制降级、清标记、且把设置开关自动关闭。
- 所有自动化检查（typecheck/test/build）通过。

## 实施结论（已完成，供 Live2D 阶段参考）

真机验证（用户执行）三项全部符合预期：默认路径不受影响、正常路径能跑通完整循环、恢复路径能正确识别标记残留并自动降级+关闭设置。全过程 subagent-driven-development，任务级审查抓到过 2 个真实的时序 bug（`useHardwareAcceleration` 在标记文件写入成功前就被置位、`clear-and-disable-setting` 分支里 `rmSync` 先于 `saveSettings` 执行，两者都可能导致失败时误判为安全）并已修复；最终 whole-branch review（opus）确认 Ready to merge，3 条 Minor（魔法数字、残留标记边界情况注释、可选的胶水层测试）已处理前两条。

**给 Live2D 集成阶段的提醒**：这套机制"确认这次启动成功"的判定窗口是"首个窗口 `did-finish-load` 后 3 秒"，这个时长是针对现有透明精灵窗口（渲染极轻量，崩溃"秒退"）校准的。Live2D 换成 Cubism Web SDK 的 WebGL2 渲染后，GPU 相关的故障可能在渲染更重的模型、加载纹理/物理运算等更晚的时机才暴露，有可能发生在这 3 秒确认窗口关闭之后——届时值得重新评估这个延迟是否还够用，或者是否需要一个跟 Live2D 渲染管线本身绑定的、更贴近"实际开始重度 GPU 工作"时机的确认信号，而不是继续用"任意窗口 did-finish-load + 固定延迟"这个对轻量精灵窗口成立、但不一定对 Live2D 成立的判定标准。
