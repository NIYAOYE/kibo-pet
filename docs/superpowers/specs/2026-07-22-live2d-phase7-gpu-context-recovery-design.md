# Live2D Phase 7 — GPU Context Lost 恢复 设计文档

> 2026-07-22 与用户 brainstorming 确认。承接 `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`
> §12(错误与 GPU 恢复)。Phase 7 按用户要求拆成三条独立线,本文件只覆盖其中的
> 「GPU Context Lost 恢复」这条新功能线;安全复查、性能基准/FPS 策略文档更新/
> THIRD_PARTY_NOTICES/真机验收清单三项走轻量流程,不各写一份 brainstorming 设计文档。

## 1. 背景

Grep 确认代码库里完全没有 `webglcontextlost`/`webglcontextrestored` 相关代码——这是
从零开始的一块。当前唯一存在的相关容错是 Phase 5 留下的 `MODEL_LOAD_TIMEOUT`(热切换
准备阶段超时),那是另一件事,不覆盖"模型正常运行中途 GPU 上下文丢失"的场景。

关键既有事实(决定了下面的设计,而不是重新发明):

- `pixi.js` 的 `GlContextSystem.handleContextLost()` 无条件 `event.preventDefault()`,
  但只有当丢失是**我们自己**通过 `forceContextLoss()` 触发时才会在下一帧自动
  `restoreContext()`;真实的驱动崩溃/上下文丢失下,Pixi 什么都不做,只是不让浏览器
  永久废弃这个 context——恢复逻辑完全要靠我们自己写。
- 浏览器规范下,`webglcontextlost` → `webglcontextrestored` 恢复的是**同一个** canvas /
  同一个 `WebGLRenderingContext` 对象,这与 `[main.ts:12-16](../../../src/renderer/main.ts)`
  里记录的另一条规则(`Application.destroy()` 会无条件强制 `loseContext()`,之后同一个
  canvas 再也拿不到可用 context,因此每次**重建**渲染器都必须换全新 canvas 元素)不是
  同一件事——那条规则针对的是"主动销毁重建",不针对"上下文丢失后被动恢复"。
- `Live2DPetRenderer.prepareSwap()`/`commitSwap()`(Phase 5 已实现并真机验收)本身就是
  "在现有 `this.app` 上重新 `Live2DModel.from()`,重新走一遍 `setupModel()`"——这正是
  Cubism 引擎自己持有的、Pixi 资源系统不追踪的 GL 纹理/缓冲区在上下文恢复后需要的重新
  上传动作。`PetController.prepareReload(source)` 已经把"同类型 source"路由到
  `renderer.prepareSwap(source)`,不新建 canvas。
- 因此:GPU 恢复 = 用同一个 `currentSource` 自触发一次 Phase 5 热切换的
  prepare→commit,不需要任何新的渲染器生命周期代码,也不需要触碰主进程/IPC/session。
  Agent、托盘、设置、聊天天然不受影响,因为这条恢复路径压根不调用任何主进程 API
  (`setIgnoreMouseEvents` 除外,纯 UI 状态,与 §2 一致)。

## 2. 状态机

三态,由三个事件驱动:

```text
healthy    --contextlost-->               recovering
recovering --contextlost-->               given-up   (尚未恢复完成又再次丢失)
recovering --restored, 重新加载成功-->      healthy
recovering --restored, 重新加载失败-->      given-up
given-up   --(真实换宠物提交新 source)-->   healthy   (不是一个事件,只是重新初始化)
```

- `healthy → recovering`:`event.preventDefault()`(必须,否则浏览器不会再触发
  `restored`)、`controller.setVisible(false)`(停 Ticker + 隐藏画布)、显示"恢复中"占位、
  强制 `window.petApi.setIgnoreMouseEvents(true)`。
- `recovering` 收到 `restored`:恰好尝试一次
  `await controller.prepareReload(currentSource)` → `controller.commitReload()`。
  - 成功 → 回到 `healthy`:隐藏占位、`controller.setVisible(true)`、恢复正常
    hit-test 驱动的 `setIgnoreMouseEvents`。
  - 抛错 → `given-up`:占位文案切换为最终提示。
- `recovering` 状态下**再次**收到 `contextlost`(还没等到 `restored` 就又丢了,典型的
  连续崩溃)→ 直接进 `given-up`,不再等第二次 `restored`。
- `given-up` 对这个宠物会话是终态:后续该 canvas 上的 `contextlost`/`restored` 一律
  忽略(占位已经是静态文案,没有什么需要保护)。只有真实的换宠物提交新 source 时才
  重新初始化回 `healthy`——这是 Phase 5 既有热切换流程的自然结果,不属于本状态机的
  事件。

`currentSource` 由 `main.ts` 维护:启动时来自 `getPet()`;每次正常换宠物的
`onPetCommit` 成功后更新为对应的新 source。

## 3. 占位 UI

- `recovering`:复用 `showBootError()` 的视觉样式(整窗固定定位、半透明红底、纯文字、
  `-webkit-app-region:no-drag`)——把这段 CSS 抽成一个共享小函数,给 boot 失败和这里
  共用,不重复写字符串。文案:`"画面渲染出现问题,正在尝试恢复…"`
- `given-up`:同样式,文案:`"渲染反复失败,已停止自动重试。请从托盘或设置中切换宠物/模型。"`
  不加按钮——引导用户用已有的托盘/设置入口,不新建交互组件。

## 4. 测试策略

1. **纯逻辑 Vitest**:新模块(如 `live2dContextRecovery.ts`)覆盖状态机全部
   `(state, event)` 转移组合,不依赖真实 WebGL,风格同 `live2dStateMapResolver.test.ts`。
2. **渲染层 wiring 测试**:用 mock 的 `PetController`/renderer(与现有测试同样的 mock
   手法)验证 `main.ts` 的事件序列——`preventDefault`/`prepareReload`/`commitReload`/
   占位显隐——按预期顺序调用。
3. **真实 Electron 验证(本次可由 agent 自己执行,不是纯粹推给用户的真机项)**:
   与 DPI/多屏不同,GPU 上下文丢失可以通过 `canvas.getContext(...).getExtension(
   'WEBGL_lose_context')` 的 `.loseContext()`/`.restoreContext()` **确定性地人为触发**。
   计划用本地已有的、真实授权的 Live2D 宠物包在真实 Electron 窗口里通过 DevTools(优先
   CDP 直接驱动,不行则提供现成的 console 脚本由用户执行)验证:单次丢失→恢复、
   连续两次丢失→放弃 两条路径都符合 §2 的状态机。
4. 真实显卡驱动级崩溃/硬件重置不纳入这次验收范围——这不是用户或 agent 能按需复现的
   场景;上面第 3 点的扩展强制模拟是双方都认可的替代验证手段。

## 5. 范围边界

- 不改动 `PetController` 的公开接口、`createRenderer` 工厂、主进程 IPC、
  `kibo-pet://` 协议、Agent/记忆/语音会话逻辑。
- 只作用于 Live2D 渲染器;Sprite 渲染器用 2D canvas,不会触发 `webglcontextlost`,
  监听器挂上去也不会误触发。
- 不处理 Live2D Phase 5 已有的 `MODEL_LOAD_TIMEOUT`(热切换准备阶段超时)——那是
  独立的既有错误码,本次不改动其行为。
