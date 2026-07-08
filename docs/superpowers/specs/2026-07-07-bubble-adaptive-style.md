# 气泡窗视觉与自适应尺寸 — 设计文档

> 2026-07-07 与用户 brainstorming 定下（用户反馈截图：跟随宠物的对话气泡是"黑黢黢的一个方形，文字少、空的还多，很影响观感"）。不归入 MVP 编号路线图，同"折叠态头顶漫画气泡+3处对话框修复"一样是独立的 UX 打磨分支。

## 1. 背景与问题

跟随宠物的漫画气泡窗（`src/renderer/bubble.html`/`bubble.ts` + `src/main/shell/bubbleWindow.ts`，MVP-13 前一个会话引入，MVP-13 又给它加了自主台词的瞬态显示）当前是**固定尺寸窗口**（`SIZE = {width:240, height:172}`，见 `bubbleWindow.ts:8`）：不论文字多短，气泡框都撑满这个固定框，配色是纯深色实心方块（`background: rgba(45,45,62,0.97)`，`bubble.html:16`）。用户反馈这既显得空、也不好看。

## 2. 目标与非目标

**目标**
- 气泡高度跟着内容走：文字越短气泡越矮，流式聊天回复时**实时**跟手长高。
- 换一套配色/形状（方向 C：宠物主题色——浅紫渐变背景 + 深紫文字），不再是深色实心方块。

**非目标**
- 不改展开对话框（`dialog.html`）、设置窗——用户已确认这次只动气泡窗，深色主题在别处保持不变。
- 不做动态宽度（宽度维持固定 240px），只做高度自适应——避免同时变宽变高的重排复杂度。
- 不改气泡的定位算法（`bubblePlacement.ts`/`fixedWindowBounds`）——这两个纯函数本来就是尺寸无关的，直接复用。

## 3. 视觉风格（方向 C：宠物主题色）

`bubble.html` 的 `<style>` 块里，`#box`/`#tail::before` 的取值改为：

- 背景：`linear-gradient(160deg, #efe3ff, #f7ecff)`
- 文字色：`#4a3a63`
- 圆角：~22px（原 14px）
- 阴影：`box-shadow: 0 4px 14px rgba(150,120,220,0.28)`（原纯黑投影）
- 尾巴：同色渐变收尾（`border-top-color` 取渐变终止色 `#f2e8ff` 左右），带一点投影
- 状态行（`#box.status`，检索中…）沿用现有斜体降透明度处理，配色跟着换（深紫字在浅底上直接降透明度即可，不用改结构）
- Markdown 子集样式（`#box a.md-link`/`code`/`strong`）里硬编码的深色配色数值（如 `color:#9db4ff` 链接色、`rgba(255,255,255,0.14)` 代码背景）需要同步换成浅底可读的对应值

具体像素值以此为起点，真机验收时可微调（同 MVP-13 冷却数值的处理方式）。

## 4. 自适应尺寸

### 4.1 尺寸模型

- 宽度维持常量 `WIDTH = 240`（不变）。
- 高度变成主进程持有的**可变状态**：`bubbleWindow.ts` 内部新增 `let currentHeight = MIN_TOTAL_HEIGHT`，取代原来对常量 `SIZE` 的直接引用。
- 上下限（`bubbleWindow.ts` 内的常量，含义同原 `SIZE.height` —— box+12px 尾巴的**总**高度）：
  - `MIN_TOTAL_HEIGHT = 56`（约一行文字 + padding + 尾巴）
  - `MAX_TOTAL_HEIGHT = 320`（超过则 `#box` 现有的 `overflow-y:auto` 内部滚动，行为不变，只是天花板抬高）

### 4.2 数据流

渲染层每次内容变化（`onStream`/`onLine`/`onStatus`/`onDone`/`onError`）后，测量 `#wrap`（box+tail 整体）的 `scrollHeight`，节流后经新 IPC 通道上报给主进程；主进程夹取范围、更新 `currentHeight`、用 `bubblePlacement` 重算位置并 `setBounds`：

```
bubble.ts 内容变化
  → scheduleReportSize()（rAF 合并，避免逐 token 高频 IPC）
  → bubbleApi.reportSize(wrap.scrollHeight)
  → 主进程 BUBBLE_RESIZE 处理器：validateBubbleHeight 校验类型
  → bubble.resize(rawHeight, petBoundsFull(), petWorkArea())
  → bubbleWindow 内部：currentHeight = clamp(rawHeight, MIN_TOTAL_HEIGHT, MAX_TOTAL_HEIGHT)
  → 若当前可见（shown）：place() 用新 currentHeight 重算 bubblePlacement + win.setBounds()
```

**节流**：`bubble.ts` 用一个"已排期"布尔量 + `requestAnimationFrame` 合并高频调用，效果是最多每帧（~16ms）上报一次，逐 token 流式文字在人眼看来仍是实时长高，但不会把主进程 IPC 打爆。

**测量口径**：直接读 `wrap.scrollHeight`（不是 `box.scrollHeight`）——`scrollHeight` 会返回内容的自然高度，即使当前 CSS 把 `#box` 用 `flex:1` 约束在旧的窗口高度里也不受影响（`scrollHeight` 语义就是"不管容器多高，内容实际需要多高"），所以**不需要改动现有 flex 布局结构**，只需要新增测量+上报的那几行代码。

### 4.3 清空态与首次显示

- `bubbleWindow.ts` 的 `clear()` 方法在发 `IPC.BUBBLE_CLEAR` 的同时，**主进程自己同步把 `currentHeight` 重置为 `MIN_TOTAL_HEIGHT`**（不等渲染层报回来）——这样下一次 `show()` 用的就是最小尺寸,新内容再把它撑起来,天然呈现"从小长到大"的效果,不会先闪一下旧尺寸的大方块。
- 初始建窗（`new BrowserWindow({...})`）的 `width/height` 也改用 `WIDTH`/`MIN_TOTAL_HEIGHT`。
- **已知的可接受的微小时序**：`show()` 是同步调用、用当前（可能还是上一轮遗留）的 `currentHeight` 摆放窗口;渲染层测量+上报是异步 IPC 往返,会在 `show()` 之后的下一拍才生效并重新摆放。也就是说气泡弹出瞬间可能有一次几毫秒的尺寸微调,肉眼基本不可察觉,且这正是"长高动画感"的自然延伸,不是缺陷。

### 4.4 `bubbleWindow.ts` 结构变化

`place()` 从读常量 `SIZE` 改为读 `{width: WIDTH, height: currentHeight}`；`BubbleController` 接口新增 `resize(rawHeight: number, pet: Bounds, workArea: Bounds): void`。`reposition()`（宠物拖拽时用）不用改——它本来就是"用当前尺寸重新摆位"，现在"当前尺寸"变成可变的 `currentHeight` 而已。

## 5. IPC 契约（四文件同步）

新增单向通道 `BUBBLE_RESIZE`（renderer→main）：

1. `src/shared/ipc.ts`：`IPC.BUBBLE_RESIZE = 'bubble:resize'` + `BubbleApi.reportSize(height: number): void`（这是 `bubbleApi` 第一个"发往主进程"的方法，此前全是 `on*` 单向下行）。
2. `src/shared/ipcValidation.ts`：`validateBubbleHeight(v: unknown): number | null`——只做**类型/合理性**校验（`typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5000` 防御性上限，防一个被攻破的渲染层灌入离谱数值），不做业务夹取；业务夹取（`MIN_TOTAL_HEIGHT`/`MAX_TOTAL_HEIGHT`）留在 `bubbleWindow.ts` 里，与既有"校验管类型安全、领域模块管业务规则"的分工一致。
3. `src/preload/index.ts`：`bubbleApi.reportSize` 暴露（`ipcRenderer.send(IPC.BUBBLE_RESIZE, height)`）。
4. `src/main/shell/index.ts`：`ipcMain.on(IPC.BUBBLE_RESIZE, ...)` 处理器——校验→`bubble.resize(rawHeight, petBoundsFull(), petWorkArea())`（沿用 shell/index.ts 里已有的 `petBoundsFull()`/`petWorkArea()` 帮手，和 `PET_SPEAK`/`MOVE_WINDOW` 处理器同款写法）。

## 6. 涉及文件清单

**修改**
- `src/shared/windowPlacement.ts` 追加导出 `clamp(value: number, min: number, max: number): number`（通用纯函数，与该文件已有的 `fixedWindowBounds`/`isZeroMove` 同属"通用窗口几何"而非"气泡专属定位"，故放这里而非 `bubblePlacement.ts`；含测试——`src/shared/windowPlacement.test.ts` 追加用例）
- `src/renderer/bubble.html`（配色/圆角/阴影/Markdown 子集配色，方向 C 数值）
- `src/renderer/bubble.ts`（`scheduleReportSize()` rAF 节流 + 在 5 个内容处理器末尾调用）
- `src/main/shell/bubbleWindow.ts`（`WIDTH`/`MIN_TOTAL_HEIGHT`/`MAX_TOTAL_HEIGHT` 常量、可变 `currentHeight`、新增 `resize()` 方法、`clear()` 同步重置 `currentHeight`、`place()` 改读可变尺寸、初始建窗尺寸改用新常量）
- `src/shared/ipc.ts`（`IPC.BUBBLE_RESIZE` + `BubbleApi.reportSize`）
- `src/shared/ipcValidation.ts`（`validateBubbleHeight`）
- `src/preload/index.ts`（`bubbleApi.reportSize` 暴露）
- `src/main/shell/index.ts`（`BUBBLE_RESIZE` 处理器）

## 7. 测试策略

- `clamp`（Vitest 纯函数）：低于下限夹到下限、高于上限夹到上限、区间内原样返回、边界值（恰好等于 min/max）。
- `validateBubbleHeight`（Vitest 纯函数）：合法数字通过、负数/NaN/Infinity/超防御性上限/非数字类型全部拒绝。
- `bubbleWindow.ts` 的 `resize()`/`currentHeight` 状态管理、渲染层的测量+节流上报：均为 Electron/DOM glue，无法单测，走**真机肉眼验收**（本仓库既定惯例）。验收清单：
  - 短句自主台词（MVP-13 的 click/drag/idle 台词）气泡矮、贴合文字，不再是大空方块。
  - 长句聊天回复流式输出时，气泡跟手实时长高，不闪烁、不抖动、不越过工作区边界。
  - 超长回复达到 `MAX_TOTAL_HEIGHT` 天花板后内部可滚动，不无限变高。
  - 配色确认符合方向 C（浅紫渐变、深紫字），链接/代码/加粗等 Markdown 子集在新配色下依然清晰可读。
  - 拖拽宠物时气泡跟随重定位正常（复用现有 `reposition()`，尺寸不会在拖拽过程中意外跳变）。

## 8. 风险与遗留

- 具体像素值（`MIN_TOTAL_HEIGHT`/`MAX_TOTAL_HEIGHT`/配色透明度等）为设计阶段估算，真机验收时可能需要微调——数值集中在 `bubbleWindow.ts`/`bubble.html` 顶部，改动成本低。
- `bubble.html` 里 Markdown 子集渲染的配色（链接蓝、代码背景）目前是为深色主题调的，换成浅底后必须同步检查对比度，不能照抄深色值。
- 展开对话框（`dialog.html`）与气泡窗即将出现两套视觉语言（深色 vs 浅紫）——用户已确认接受这个不统一，作为本次的明确非目标记录在案，避免后续被误当成遗漏。
