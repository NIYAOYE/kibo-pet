# 折叠态"头顶漫画气泡" + 三处对话框修复 — 设计

日期：2026-07-07
状态：已与用户确认设计，待写实现计划

## 背景与目标

对话框（`dialog.html` / `dialog.ts`，独立于宠物窗的第三方窗口，见 `dialogWindow.ts`）当前在**折叠态**把"回复气泡 + 输入栏"挤在同一个窗口里。用户反馈四点：

1. **Bug — 发送按钮显示一半**：展开对话框时右侧 `#send` 按钮被窗口右边缘裁掉。
2. **优化 — 折叠态回复改为"漫画式头顶气泡"**：未展开对话框时，回复以一个带小尾巴、贴在宠物头顶的对话气泡呈现（内容可上下滚动）；输入栏与回复气泡"解绑"。展开对话框后动态展示**保持原样**。
3. **优化 — 输入支持 Shift+Enter 换行**：当前 Enter 直接发送，无法换行。
4. **Bug — 发送瞬间闪现上一条旧回复**：折叠态唤起对话框时界面是干净的，但输入并发送后会先闪出上一轮回复、再被本轮覆盖。期望发送时界面干净。

本设计一次性解决这四点。核心新增能力是 #2：一个跟随宠物的**气泡伴随窗**。

## 关键决策：气泡用独立"伴随窗"（方案 A）

气泡贴在宠物身上有两种实现。经与用户确认，采用**方案 A：独立伴随窗**。

- **方案 A（采用）**：新建一个透明、无边框、置顶、默认鼠标穿透的小窗口，漂浮在宠物窗口正上方，只在折叠态显示回复。宠物移动时由主进程在既有的移动路径上同步重定位。
  - 好处：**完全不改动**宠物窗（`petWindow.ts` / `main.ts` / `petController`）那套精细的拖拽、`isPetPixel` 点击穿透、走路夹取、`petBounds` 逻辑；也不改动展开态对话框的既有行为。符合仓库"小而内聚、边界清晰的单元"原则。
- 方案 B（否决）：把气泡塞进宠物窗本体，需要加高窗口并改造拖拽命中测试 / 点击穿透 / `petBounds` / 走路夹取边界，风险高、收益等价。

两方案视觉与体感一致。

## 架构与组件

### 新增窗口：气泡伴随窗

- 新文件 `src/renderer/bubble.html` + `src/renderer/bubble.ts`：一个漫画气泡容器（圆角背景 + 朝向宠物的小尾巴），内部 `overflow-y:auto` 可滚动；透明背景，气泡本体之外区域不绘制。
- 新增 `window.bubbleApi`（preload contextBridge 暴露），接收：流式增量、状态、完成、报错、最终回复定格、以及"清空"信号。渲染逻辑复用 `renderMarkdownSafe`（流式期间纯文本，完成时定格为安全 Markdown 子集，和现有对话框一致）。

### 新增主进程控制器：`createBubbleController`

仿照 `createDialogController` 的形态，放在 `src/main/shell/bubbleWindow.ts`：

- 懒建窗口；提供 `show(petBounds)` / `hide()` / `reposition(petBounds)` / `pushStream/pushStatus/pushDone/pushError/pushFinal/clear` / `window()`。
- 内部持有"是否应显示"状态 = `对话框已打开 且 处于折叠态`。

### 主进程接线（`src/main/shell/index.ts`）

- `chat` 的 `pushStream/pushStatus/pushDone/pushError` 与 `pushUpdate` 在原有发往对话框窗口的基础上，**同时**发一份给气泡窗（气泡窗自身按可见性决定是否呈现）。
- 折叠/展开切换（`DIALOG_SET_SIZE` 处理）与对话框开关（`onOpened`/`onClosed`）里，更新气泡窗显隐：折叠+打开→`show`，展开或关闭→`hide`。
- `MOVE_WINDOW` 处理里，若气泡窗可见则调用 `reposition(petBounds())`，使气泡跟随宠物（手动拖拽与自主走路两条分支都覆盖）。
- `messageSent` 事件时清空气泡窗内容（保证发送瞬间干净，见修复 #4）。

### 折叠态对话框窗口"瘦身"

- 折叠态回复移交气泡窗后，`dialog.html` 中的 `#bubble` 元素**退役删除**（展开态本就 `display:none`，折叠态改由气泡窗承担）。
- `dialogWindow.ts` 的 `COLLAPSED` 高度收缩到"仅输入栏（+ 待发图片带）"，于是"输入栏与回复气泡解绑"自然成立。展开态 `EXPANDED` 尺寸不变。

## 气泡定位与越界处理（纯函数，重点）

抽出纯函数 `bubblePlacement(pet, workArea, bubble)`（放 `src/shared/` 便于单测复用），输入宠物窗 bounds、目标显示器工作区、气泡窗尺寸，输出 `{ x, y, tailSide, tailOffsetX }`：

- **默认**：气泡放宠物头顶（`y = pet.y - bubble.height - GAP`），水平方向以宠物中心对齐（`x = petCenter - bubble.width/2`），尾巴在**底部**（`tailSide:'bottom'`）指向下方宠物。
- **上边界越界**（头顶放不下，`y < workArea.top`）：**翻到宠物下方**（`y = pet.y + pet.height + GAP`），尾巴改在**顶部**（`tailSide:'top'`）指向上方宠物。
- **左右边界越界**：水平方向把 `x` 夹进工作区（`clamp` 到 `[workArea.left, workArea.right - bubble.width]`）。夹取后气泡不再以宠物为中心，故**尾巴水平偏移** `tailOffsetX` 单独计算 = 宠物中心相对气泡左缘的位置，再夹到气泡内边距范围内，保证尾巴始终指向宠物。
- **下方也放不下**（极端：上下都不够）：夹进工作区，取可见性优先（可能与宠物略有重叠，可接受）。
- 所有分支输出的 `x/y` 最终都夹进 `workArea`，确保气泡窗**任何时候完全在屏内**。

单测覆盖：头顶正常、贴屏幕顶、贴左缘、贴右缘、贴四角、宠物跨到副屏工作区等用例，断言 `x/y` 不越界且 `tailSide/tailOffsetX` 指向正确。

## 三处修复细节

1. **发送按钮显示一半**：`#input`（[dialog.html](../../../src/renderer/dialog.html)）加 `min-width: 0`，解开 flex 子项 `min-width:auto` 不肯收缩到内容宽度以下、把 `#send` 挤出窗口的陷阱（与 `#history` 已用的同款处理）。
2. **Shift+Enter 换行**：`<input type="text">` 换成 `<textarea>`；`keydown` 里 `Enter && !shiftKey` → `submit()` 并 `preventDefault()`，`Shift+Enter` → 走默认插入换行；`textarea` 限制最大高度约 3 行、超出内部滚动；保留 placeholder 与既有粘贴/拖拽图片逻辑。
3. **发送闪现旧回复**：`render()` 仅当**消息数组最后一条是 pet 回复**时才展示气泡（原逻辑用 `reverse().find(role==='pet')` 会捞出上一轮旧回复）。气泡窗侧同理，`messageSent` 到达即 `clear`，`onStream` 起才重新填充，保证发送瞬间干净。

## IPC 契约变更（`src/shared/ipc.ts`）

- 新增气泡相关 IPC 常量（如 `BUBBLE_STREAM / BUBBLE_STATUS / BUBBLE_DONE / BUBBLE_ERROR / BUBBLE_FINAL / BUBBLE_CLEAR`，或复用现有 chat 通道 + 新增窗口目标——实现计划里定）。
- 新增 `BubbleApi` 接口与 `window.bubbleApi` 声明；preload 暴露。
- 四文件同步改动纪律照旧：`shared/ipc.ts` 常量+类型、`main/shell/*` 发送、`preload/index.ts` 暴露、`renderer/bubble.ts` 消费。

## 测试与验收

- **纯逻辑**：`bubblePlacement` 走 Vitest（TDD，先写失败用例，重点是越界/翻转/夹取/尾巴指向）。
- **GUI/窗口/CSS/交互**：自动化检查通过 ≠ 应用可跑。改完必须 `pnpm build && pnpm preview` 真机目视确认：
  - 展开态发送按钮完整可见；
  - 折叠态发送后回复出现在宠物头顶气泡、可滚动、输入栏独立；
  - 把宠物拖到屏幕上/左/右/四角，气泡不越界、尾巴指向正确；
  - Shift+Enter 换行、Enter 发送；
  - 折叠态唤起并发送，发送瞬间无旧回复闪现。

## 不做（YAGNI）

- 不做气泡的进出场动画 / 主题化 / 富交互（超出四点诉求）。
- 不改展开态对话框的任何呈现。
- 不改宠物窗的拖拽/穿透/走路逻辑。
