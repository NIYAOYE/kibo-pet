# 宠物渲染流畅度重构 · Phase 0：覆盖窗口性能 Spike 设计

## 背景

用户反馈当前宠物动画/移动存在三类不流畅现象：

1. **移动卡顿/跳帧**：`petController.ts` 每 33ms 触发一次逻辑 tick，自主行走期间每 tick 都经 IPC 请求主进程 `setBounds` 真实移动 OS 窗口（`src/main/shell/index.ts` `IPC.MOVE_WINDOW` handler）；坐标最终经 `fixedWindowBounds` 取整（`src/shared/windowPlacement.ts`），40px/s 的行走速度每 tick 只推进约 1.3px，取整误差逐 tick 忽大忽小，视觉上表现为顿挫。
2. **动作切换生硬**：`spritePlayer.ts` 纯离散换帧，无过渡（本次不处理，超出本设计范围）。
3. **帧调度抖动**：`SpritePlayer.tick()` 用逐帧 `window.setTimeout` 链排程，而非 `requestAnimationFrame`，容易被事件循环/IPC 流量抢占产生时序抖动。

经brainstorming 讨论，选定的重构方向是**方案B**：把"跟随精灵移动的小窗口(256×288，逐帧 `setBounds`)"换成"覆盖当前屏幕 workArea 的单个透明大窗口 + 画布内浮点坐标移动精灵"，日常行走/拖拽都只在渲染进程内部改变绘制坐标，不再逐帧调用原生窗口移动。

这个架构上限最高（彻底消除"每帧一次原生窗口移动"的开销），但项目当前**全局禁用了硬件加速**（`app.disableHardwareAcceleration()`，`src/main/index.ts:36`，是修复过真机 GPU 崩溃 0xC0000135 留下的约束，不可撤销），意味着新的大尺寸透明覆盖窗口完全走软件合成，合成开销是否可接受目前没有实测数据。

因此本设计**只覆盖 Phase 0：一个独立的最小原型 spike**，目的是在真机上验证"整屏透明覆盖窗口 + rAF 内绘制移动图形 + 逐像素点击穿透"这个组合的合成性能是否可接受。Phase 0 通过后才会另写 Phase 1（正式重构 `petController`/`spritePlayer`/IPC 等组件）的设计文档；Phase 0 不通过则回退到方案A（不改窗口架构，只把帧调度统一为 `requestAnimationFrame` 并分散取整误差）。

## 目标

1. 用最小代码量验证：覆盖当前屏幕 workArea 的透明 `BrowserWindow`，在硬件加速被禁用的前提下，日常合成开销（CPU、掉帧）是否明显劣于现有 256×288 小窗口方案。
2. 验证逐像素点击穿透（`setIgnoreMouseEvents` + mousemove 命中测试）在整屏画布上依然可靠——穿透区域鼠标事件正常传给桌面下层窗口，图形区域正常拦截。
3. 验证 `requestAnimationFrame` 驱动的浮点坐标移动，在软件合成下视觉是否比现有 33ms tick + 取整 `setBounds` 更顺滑。
4. 给出一个可由用户在真机上直接跑起来观察的 demo（不需要动现有 `pets/`、`petController` 等生产代码）。

## 非目标

- 不改动现有生产环境的 `petController.ts` / `spritePlayer.ts` / `MOVE_WINDOW` IPC / 气泡窗口 / 控制指示器窗口——这些改动留给 Phase 1。
- 不处理多屏漫游（本次 spike 和 Phase 1 都只覆盖当前主屏/使用中的屏幕）。
- 不处理动作切换过渡/融合。
- 不重新评估或改动 `app.disableHardwareAcceleration()`。
- 不做自动化测试（spike 本身是探索性质，成功判据是真机观感 + 数据，不是单元测试）。

## 方案选择

### 采用：独立 spike 入口，复用真实 pet 精灵图但不接入生产状态机

新建一组独立的 dev-only 演示文件：`src/renderer/overlaySpike.ts` + 一个独立的 `overlaySpike.html` 入口 + 主进程侧一个独立的临时窗口创建函数（不改动 `petWindow.ts`）。加载真实的宠物 spritesheet 素材，但移动逻辑是最简单的"水平匀速来回走"，不接 `petBrain`/`petController` 状态机，不复用生产 IPC 通道。验证结束后（无论 Go 还是 No-Go）这组文件整个删除。

理由：spike 的唯一目的是判断"整屏透明窗口 + rAF 浮点绘制"这个组合本身是否可行，接入完整状态机只会增加变量、拖慢验证速度，且这部分代码大概率要在 Phase 1 推倒重写。

### 不采用：直接在 `petWindow.ts`/`petController.ts` 上原地改造

如果 spike 结果是"合成开销不可接受，回退方案A"，原地改造需要先改回去，代价更高；独立 spike 文件在验证完成后可以直接整个删除，不留痕迹，风险最低。

### 不采用：先做自动化性能基准测试（如无头 Electron + trace 采集）

真正决定"流不流畅"的是真机上肉眼可见的合成表现和实际 CPU 占用，无头环境测不出合成路径的真实开销，且当前 agent 会话本身没有真实显示器/GPU 环境可用（参见既往经验：真机 GPU 崩溃、真机拖拽漂移等问题都无法在 agent 会话内复现）。直接让用户在真机跑 demo 更快得到可信结论。

## 架构与组件

### 主进程：临时覆盖窗口

```ts
// 临时文件，验证通过后删除或迁移进 petWindow.ts
function createOverlaySpikeWindow(workArea: Bounds): BrowserWindow {
  return new BrowserWindow({
    x: workArea.x, y: workArea.y,
    width: workArea.width, height: workArea.height,
    transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
}
```

窗口默认 `setIgnoreMouseEvents(true, { forward: true })`，由渲染进程按命中测试结果动态切换（复用现有 `main.ts` 里 `setIgnore()` 的思路）。

### 渲染进程：rAF 循环 + 浮点坐标 + 命中测试

- 单个 `requestAnimationFrame` 循环：每帧用时间戳算出 `dt`，`spriteX += vx * dt` 匀速左右往返，触边界反向；同一循环里判断是否需要推进精灵动画帧（复用真实 spritesheet 的 `frameDurationMs` 节奏）。
- `drawImage` 目标坐标使用浮点 `spriteX/spriteY`，不取整。
- mousemove 命中测试：把 `clientX/clientY` 减去当前 `spriteX/spriteY` 偏移，复用现有 `isPetPixel` 的透明度判定逻辑，决定是否 `setIgnoreMouseEvents`。

### 观测输出

Demo 里叠加一个简单的调试文字层（画布右上角），实时显示：当前 rAF 实际帧间隔（ms）、最近 1 秒的平均/最差帧间隔。用户真机验证时口头/截图反馈观感是否顺滑、CPU 占用（任务管理器）是否明显高于现有版本。

## 数据流

```text
主进程启动 -> 获取当前屏幕 workArea -> createOverlaySpikeWindow
  -> 渲染进程 boot：加载真实 spritesheet -> requestAnimationFrame 循环
       -> 计算 dt -> 推进 spriteX（匀速往返）-> 推进动画帧索引（如需要）
       -> drawImage(spriteX, spriteY) -> 更新调试文字层
       -> mousemove -> isPetPixel(clientX - spriteX, clientY - spriteY) -> setIgnoreMouseEvents
```

不涉及 `MOVE_WINDOW` IPC、不涉及 `petBrain`/`petController`/气泡窗口。

## 测试策略

### 构建验证

- `pnpm typecheck`：demo 代码本身要类型检查通过。不要求接入 `pnpm build`/`pnpm preview` 的生产打包三件套——spike 只通过 `pnpm dev` 验证，因为这组文件本身是临时的，验证后即删除。

### 真机验证（本次 spike 的核心，也是唯一的成功判据来源）

1. 用户在自己机器上通过 `pnpm dev` 启动 demo，肉眼观察精灵水平往返移动是否顺滑，与当前正式版本的行走观感对比。
2. 观察调试文字层的帧间隔数据，是否稳定接近显示器刷新间隔（如 60Hz≈16.7ms），有无持续性的大幅波动或掉帧。
3. 打开任务管理器观察该 Electron 渲染进程 + GPU/合成相关进程的 CPU 占用，与现有小窗口版本运行时的占用做对比。
4. 把鼠标移入/移出精灵区域，确认穿透行为正确（穿透区域可以点击到桌面下层窗口，图形区域能正常拦截 mousedown）。

## 成功标准（Go / No-Go 判据）

- **Go（转入 Phase 1 正式重构）**：真机运行下，帧间隔稳定、无明显掉帧，CPU 占用相比现有小窗口方案没有显著恶化，点击穿透正确无误。
- **No-Go（回退方案A）**：出现明显更卡顿的合成表现，或 CPU 占用显著上升，或点击穿透在整屏画布上出现可感知的失灵/延迟。此时放弃方案B，改为方案A（`spritePlayer.ts`/`petController.ts` 原地改造：统一 `requestAnimationFrame` 驱动 + 定步长逻辑/插值渲染，取整误差分散到更高频的 tick 上），不改变窗口跟随架构。

Go/No-Go 由用户根据真机观感和以上数据自行判断，本设计不预设默认结论。

## Phase 0 结论（真机验证）

用户在真机上通过 `pnpm build && pnpm preview`、`SPIKE_OVERLAY=1` 跑起了 demo（`pnpm dev` 先撞到 `PROGRESS.md` 记录过的沙箱内 `localhost:5173 ERR_CONNECTION_REFUSED` 已知问题，换 `pnpm preview` 后正常起来），反馈如下：

- **移动流畅度**：整体大部分时间顺滑，但偶发能看到明显的卡顿/掉帧，不是持续稳定的表现。
- **内存占用**：相比当前正式版本（256×288 小窗口方案）增加了约 40MB。
- **视觉缺陷（决定性因素）**：整屏透明覆盖窗口的边缘出现了水平和底部滚动条（截图已确认），单是这一点观感就比现有小窗口方案更糟，与性能数据无关。
- **综合判断**：方案B 整体不如现有方案，帧调度和内存都没有换来足够的收益，反而多了一个明显的视觉瑕疵。

**结论：No-Go。放弃方案B。**

同时，用户明确表示**不希望自动回退到方案A**（原地把 `spritePlayer.ts`/`petController.ts` 的帧调度统一为 `requestAnimationFrame`）。用户的意向是：现有"跟随精灵移动的小窗口"这个呈现范式本身可能也不是终点，希望之后另开一次 brainstorming，探索不受当前小窗口/精灵贴图形态限制的、完全不同的宠物呈现方式。这次探索不在本 spike 和本 plan 的范围内，此处仅作记录，不在本任务中展开或启动。

**给未来重新尝试者的提醒**：本次 spike 的实施计划文档（已随分支丢弃，未保留在 git 历史中）在 Task 6 里写的 `isSpritePixel` 点击穿透代码有一处坐标系 bug——采样了精灵图集里的源坐标而不是精灵实际画在画布上的坐标，会让点击穿透判定形同虚设；这个 bug 在任务审查时被发现并改成采样 `Math.floor(clientX), Math.floor(clientY)`。如果以后重新实现类似方案，直接用修正后的采样方式，不要重新踩这个坑。
