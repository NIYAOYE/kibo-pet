# Windows DPI 稳定窗口定位修复设计

## 背景

当前宠物窗和气泡窗都通过 Electron `BrowserWindow.setPosition(x, y)` 高频移动。在 Windows 150% DPI 下，部分 DIP 坐标不能精确映射到物理像素。例如请求 `x=933` 后，Electron 实际位置稳定在 `x=932`。后续帧持续请求无法落地的 `933` 时，窗口左边缘不再移动，但实际宽度每次增加 1px。

当前实现又始终使用固定设计尺寸计算相对位置：宠物窗 `256×288`，气泡窗 `240×172`。实际窗口逐步膨胀后，定位公式仍按旧尺寸计算，最终产生以下现象：

- 气泡宽度或高度持续增长；
- 气泡视觉中心逐渐偏离宠物；
- 屏幕边界夹取基于失真的尺寸，气泡可能继续越界；
- 长按拖拽产生的零位移事件持续放大问题。

`eeec42f` 用 `setPosition()` 替换了显式 `setBounds()`，并用自持 `shown` 状态替代 `win.isVisible()`。这修复了可见性判断失真，但没有约束窗口尺寸，因此没有解决 DPI 坐标舍入导致的尺寸累积。

## 目标

1. 宠物窗在手动拖拽和自主行走期间始终保持固定尺寸。
2. 气泡窗在跟随、边界夹取和长按拖拽期间始终保持固定尺寸。
3. 保持现有产品行为：手动拖拽可自由出屏，自主行走仍限制在工作区，气泡仍优先位于宠物上方并按边界翻转或夹取。
4. 不恢复高频 `setResizable(true/false)`，避免重新引入可见性状态问题。
5. 零位移拖拽事件不触发原生窗口调用。

## 非目标

- 不改变宠物动画、拖拽阈值或鼠标穿透行为。
- 不改变气泡视觉样式、文本布局或流式回复逻辑。
- 不重新设计跨显示器移动策略。
- 不升级 Electron 版本。

## 方案选择

### 采用：固定尺寸完整 bounds 定位

宠物窗和气泡窗移动时都提交完整 `{ x, y, width, height }`，而不是只调用 `setPosition(x, y)`。每次原生窗口操作都重新声明尺寸不变量，从源头阻止 DPI 舍入误差累积。

窗口保持 `resizable:false`，定位过程中不切换窗口样式。修复只使用程序化 bounds 更新。

### 不采用：缓存请求坐标与实际坐标

缓存能跳过对同一个无法落地坐标的重复请求，但连续拖动会持续产生新目标坐标，仍可能逐帧膨胀；同时引入额外状态和跨屏失效条件。

### 不采用：按 `scaleFactor` 吸附物理像素网格

该方案必须自行处理显示器原点、旋转、跨屏和 Electron 无边框窗口的额外舍入。它复制了 Electron/Windows 的坐标转换职责，风险高于直接声明窗口尺寸不变量。

## 架构与组件

### 共享纯逻辑

在 `src/shared` 增加一个小型纯函数，输入目标坐标和固定尺寸，输出完整 bounds：

```ts
interface FixedSize {
  width: number
  height: number
}

function fixedWindowBounds(
  x: number,
  y: number,
  size: FixedSize
): Bounds
```

该函数负责整数化坐标并始终复制固定宽高。主进程窗口代码只消费结果，不重复拼装尺寸。

### 宠物窗口

`petWindow.ts` 导出宠物窗口尺寸常量，创建窗口和后续移动复用同一常量。`MOVE_WINDOW` 处理器计算目标位置后，用完整 bounds 移动宠物窗。

手动拖拽分支仍不夹取。自主行走分支先按工作区夹取目标坐标，再生成完整 bounds。

### 气泡窗口

`bubbleWindow.ts` 的 `place()` 保留 `bubblePlacement()` 计算结果和自持 `shown` 状态，但使用完整固定 bounds 更新窗口。气泡固定尺寸继续作为边界计算的唯一输入。

### 零位移防线

`MOVE_WINDOW` 在校验后检测 `dx === 0 && dy === 0`。零位移直接返回，不调用宠物窗或气泡窗的任何原生定位 API。

这不是主修复；主修复仍是每次重新声明固定尺寸。零位移过滤用于消除长按状态下无意义的高频调用。

## 数据流

```text
renderer mousemove / petBrain move
  -> IPC MOVE_WINDOW
  -> validateMoveDelta
  -> zero-delta guard
  -> calculate target pet x/y
  -> fixedWindowBounds(target, PET_WINDOW_SIZE)
  -> petWin.setBounds(full bounds)
  -> bubblePlacement(actual pet bounds, workArea, BUBBLE_SIZE)
  -> fixedWindowBounds(target, BUBBLE_SIZE)
  -> bubbleWin.setBounds(full bounds)
```

## 测试策略

### 自动化回归测试

1. `fixedWindowBounds` 对任意坐标始终返回固定宽高。
2. 小数坐标被稳定整数化，不产生随调用次数变化的状态。
3. `MOVE_WINDOW` 的零位移判断作为纯逻辑测试覆盖。
4. 现有 `bubblePlacement` 边界、翻转和副屏偏移用例必须继续通过。

### 构建验证

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

### Windows 150% DPI 真机验证

通过 Electron Inspector 直接读取 `BrowserWindow.getBounds()`：

1. 连续移动宠物窗至少 200 次，宠物窗尺寸保持固定。
2. 气泡可见时连续跟随至少 200 次，气泡窗尺寸保持固定。
3. 连续发送零位移事件，两个窗口 bounds 不变化。
4. 在主屏和竖置副屏内部各验证一次。
5. 将宠物拖到上下左右边界，气泡翻转/夹取正确，且不因持续拖动膨胀。

## 成功标准

- 宠物窗和气泡窗的真实 Electron bounds 在整个测试期间不累计增长。
- 非边界区域内，气泡相对宠物的位置保持稳定。
- 触碰工作区边界时，只发生既定的翻转或夹取。
- 不再依赖 `win.isVisible()` 决定逻辑显示状态，也不高频切换 `resizable`。
- 所有自动化检查和 Windows 150% DPI 真机检查通过。
