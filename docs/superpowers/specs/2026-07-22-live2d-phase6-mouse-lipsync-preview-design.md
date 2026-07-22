# Live2D Phase 6 设计 — 鼠标追踪 / TTS 口型 / 导入预览

> 2026-07-22 与用户 brainstorming 确认。这是 Live2D 呈现改造大盘(见
> `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`,以下简称"主设计文档")
> §16 实施分段的第 6 段:"鼠标追踪、口型和设置/导入预览"。前置的 Phase 0-5 + Phase 6
> 前置修正(行为隔离,拆分 Live2D 自主游走)已全部完成并推送到 `origin/main`(`c49a7f4`)。

## 0. 范围边界

本设计覆盖三块相对独立(不同文件、不同进程边界)但同属 Phase 6 的功能:

1. 鼠标追踪(视线/头部朝向)。
2. TTS 口型(RMS 音量包络驱动嘴部参数)。
3. 设置页 Live2D 导入预览。

三块共用一份设计文档,但拆成 3 份独立的实施计划(见 §5)。三块**都不涉及**:精灵
(`sprite`)渲染路径的行为变化(鼠标追踪/口型只对 `render.type==='live2d'` 生效;
导入预览只对 Live2D 包生效,精灵包导入流程不变)、Electron/依赖升级(那是主设计
文档 §13,已完成)、发布许可(§8 阶段)。

## 1. 关键前置发现:引擎已自带视线追踪机制

在设计鼠标追踪前,先读了 `untitled-pixi-live2d-engine` 的**实际打包源码**
(`node_modules/untitled-pixi-live2d-engine/dist/cubism.js`,不是只看 `.d.ts` 或假设
——按项目既往教训 [[verify-thirdparty-lib-fixes-against-real-source]] 的做法)。

发现:引擎已完整实现官方 Cubism Framework 那套"视线跟随"标准机制:

- `Live2DModel.focus(x, y, instant?)`:`x/y` 是 `[-1,1]` 的目标方向,内部驱动一个
  `FocusController`(`targetX/Y`、当前 `x/y`、速度 `vx/vy`),`update(dt)` 时自动向
  目标插值——离开/回正/暂停都不需要我们自己写平滑代码,喂目标值就够了。
- `CubismInternalModel.update()` 每帧无条件调用 `updateFocus()`:
  ```js
  updateFocus() {
    this.coreModel.addParameterValueById(this.idParamEyeBallX, this.focusController.x);
    this.coreModel.addParameterValueById(this.idParamEyeBallY, this.focusController.y);
    this.coreModel.addParameterValueById(this.idParamAngleX, this.focusController.x * 30);
    this.coreModel.addParameterValueById(this.idParamAngleY, this.focusController.y * 30);
    this.coreModel.addParameterValueById(this.idParamAngleZ, this.focusController.x * this.focusController.y * -30);
    this.coreModel.addParameterValueById(this.idParamBodyAngleX, this.focusController.x * 10);
  }
  ```
  用的是 `addParameterValueById`(**加法混合**),发生在 Motion 更新参数之后——这正是
  官方 Cubism 示例里 Motion 与视线追踪共存的标准做法,天然满足主设计文档 §8.2
  "自然参数不得覆盖高优先级 Motion 正在驱动的值"。
- 参数 ID 通过 `getIdSafe()` 解析,底层 `CubismModel.getParameterIndex()` 对不存在的
  参数 ID 返回一个隔离的"不存在"哨兵索引,读写都不会碰到真实模型数据——天然满足
  "模型没有相应参数时不写入未知参数",不需要我们自己遍历参数表判断存在性。

**结论**:鼠标追踪不需要自己发明参数发现机制或优先级仲裁逻辑,只需要算出"目标方向
是多少",然后调用 `model.focus(x, y)`;不追踪时喂 `(0, 0)`,回正效果自动发生。

## 2. 鼠标追踪

### 2.1 追踪范围:全桌面

用户选择"鼠标离宠物一定距离内就开始追踪"(而非仅限宠物窗口内)。这需要主进程
读取全局光标位置并推给渲染进程——渲染进程本身拿不到窗口外的鼠标事件。

### 2.2 职责划分

主进程负责"要不要追踪"(几何/设置层面的判断),渲染进程负责"追不追"(宠物自身
行为状态的判断)。这样划分是因为主进程已经拥有窗口几何和拖拽状态,而"是否在睡眠"
只有渲染进程的行为状态机知道。

**主进程**新增一个轮询循环,启动条件全部满足才跑(否则完全不轮询,不常驻消耗):

- 当前 `session` 对应的宠物渲染类型是 `live2d`。
- 宠物窗口当前可见。
- `manifest.render.interaction.mouseTracking === true`。
- `settings.json` 的 `live2dMouseTrackingEnabled !== false`(默认 `true`)。

轮询频率:30Hz(与现有 `PetController` 的 `TICK_MS=33` 节奏一致;`FocusController`
自带插值,不需要更高频率才能看起来顺滑)。每次 tick:

1. `screen.getCursorScreenPoint()` 取全局光标,`petWin.getPosition() + currentPetSize`
   取宠物窗口矩形,算光标到窗口中心的偏移 `(dx, dy)` 和距离。
2. 距离超过 `TRACK_RADIUS_PX`(常量,建议 `900`,屏幕像素,**不做成设置项**——已与
   用户确认,按 YAGNI 原则,真需要再加)→ 目标 `(0, 0)`。
3. `dragAnchor !== null`(主进程已有的拖拽状态,拖拽由 `IPC.DRAG_START/DRAG_END`
   维护,不需要新状态)→ 目标 `(0, 0)`。
4. 否则:`(dx, dy) / TRACK_RADIUS_PX`,每个分量各自 clamp 到 `[-1, 1]`。

通过新增单向推送 IPC `MOUSE_FOCUS`(main → renderer,与现有 `onContextSignal` 同一
种模式)把目标发给渲染进程。

**渲染进程**(`PetController`)收到目标后,叠加它独有的状态知识:如果当前 Live2D
行为状态(`Live2DBrainCtx.state`)是 `'sleep'`,强制目标为 `(0, 0)`;否则原样转发。
`PetController` 新增 `setMouseFocus(x, y)` 方法,内部做上述门控后调用
`this.renderer.setLookTarget(x, y)`。

### 2.3 `PetRenderer` 接口新增方法

```ts
setLookTarget(x: number, y: number): void
```

- `SpriteRenderer`:no-op(与现有 `setFacing`/`setLipSync` 的 no-op 先例一致)。
- `Live2DPetRenderer`:`this.model?.focus(x, y)`(非 `instant`,交给引擎自己插值)。

### 2.4 设置项

`settings.json` 新增 `live2dMouseTrackingEnabled: boolean`(默认 `true`)。设置页
"宠物"页新增一个"启用鼠标追踪"开关。主进程轮询循环启动前读这个值(与其余设置项
一致的读取方式)。

## 3. TTS 口型

### 3.1 数据流

```
Voice PCM Chunk(base64)
  → pcmPlayer.decode() 还原成 Float32Array(已有,不新增第二条解码路径)
  → lipSyncEnvelope.computeEnvelope(pcm, sampleRate, windowMs) → number[]
      (按固定窗口切 RMS,纯函数,可脱离 AudioContext 用 Vitest 直接喂数组断言)
  → 与该块的 { startAt, durationS } 一起记入 pcmPlayer 内部的"播放中的块"列表
  → 新的 rAF 循环:target = pcmPlayer.getCurrentLevel(ctx.currentTime)
  → lipSyncSmoother.step(target, dtMs)(attack/release 平滑,纯函数/纯状态对象)
  → controller.setLipSync(level) → renderer.setLipSync(level)(Phase 4 已有实现)
```

### 3.2 新增的纯函数模块 `lipSyncEnvelope.ts`

```ts
computeEnvelope(pcm: Float32Array, sampleRate: number, windowMs: number): number[]
createLipSyncSmoother(attackMs: number, releaseMs: number): { step(target: number, dtMs: number): number }
```

两者都不依赖 `AudioContext`/Electron,符合项目"纯逻辑先写 Vitest"的既有约定(参照
`bubblePlacement.ts`/`live2dAutoSetup.ts` 一类模块)。

### 3.3 `pcmPlayer.ts` 改动

- `play()` 在 `scheduler.scheduleNext()` 拿到 `startAt` 的同时,调用
  `computeEnvelope()` 算出包络,把 `{ startAt, durationS, envelope, windowMs }` 记入
  一个内部数组;`onended` 时移除对应条目。
- 新增 `getCurrentLevel(nowCtxTime: number): number`:找出 `[startAt, startAt+durationS)`
  覆盖 `nowCtxTime` 的块,取 `envelope[floor((now - startAt) / (windowMs/1000))]`
  (越界 clamp 到数组末尾);没有任何块覆盖当前时刻 → 返回 `0`。
- `stop()` 除了现有的停止/清空 `sources`,同时清空这个内部块列表——保证 `stop()`
  之后 `getCurrentLevel()` 立即返回 `0`。

### 3.4 驱动循环与代理方法

- `main.ts` 新增一个独立的 `requestAnimationFrame` 循环,与 `PetController` 的
  33ms tick 解耦(符合主设计文档 §7.1"业务状态机 tick 与画面刷新解耦"),持续运行
  (代价很低:没有语音播放时 `getCurrentLevel` 恒返回 `0`,`smoother` 很快收敛到 `0`
  不再变化)。
- `PetController` 新增 `setLipSync(level: number)`,转发 `this.renderer.setLipSync(level)`
  ——与现有 `hitTest()` 同样的理由:渲染器实例会在热切换时被替换,`main.ts` 不能自己
  攥一份引用(见 `petController.ts` 里 `hitTest()` 上方的既有注释)。

### 3.5 "停止/打断/切换/出错/未启用时归零"不需要写分支判断

- `getCurrentLevel()` 在没有块覆盖当前时刻时天然返回 `0`——播放结束、`stop()`、
  切宠物、TTS 未启用(从未有块被记录过)全部落到同一条路径,不需要为每种场景单独
  写归零逻辑。
- `release` 阶段的平滑由 `lipSyncSmoother` 统一处理,天然是"平滑归零"而不是瞬间跳变。
- "没有口型参数时只播放 Talk Motion":`Live2DPetRenderer.setLipSync()`(Phase 4 已有
  实现)本身已经是"找不到参数就安全 no-op";Talk 动作走的是 `playState()`,两条路径
  本来互不依赖,不需要新代码。

## 4. 设置页 Live2D 导入预览

### 4.1 现状(先纠正一个可能的误解)

`petCatalog.ts` 的导入流程**已经是两阶段的**:先把源目录 `cpSync` 到
`userData/pets/.staging/<random>/`,做完全部校验后才 `renameSync` 到最终目录;任一
环节失败都 `rmSync` 清理 staging,不触碰最终目录。真正缺的只是"验证通过之后,不要
立刻自动 `renameSync`,而是先让用户看一眼、确认或取消"这一步。

同样,`kiboPetProtocol.ts` 的 token 注册表(`registerToken(rootDir): string` /
`revokeToken(token)`)本来就是"任意目录 → token"的通用登记表,不是只服务当前激活
的那一个宠物——给 staging 目录开一个独立预览 token,不需要改这个模块。

### 4.2 只有 Live2D 包才走预览

staging 校验成功后:

- `manifest.render.type === 'sprite'` → 照今天的行为立即提交(`renameSync`),不改变
  精灵宠物的导入体验,不弹预览。
- `manifest.render.type === 'live2d'` → 进入预览面板,等待用户确认或取消,**不**
  自动提交。

### 4.3 IPC 改动

现有一次性的 `IMPORT_PET` 拆成三个:

- `STAGE_IMPORT_PET`:弹文件夹选择器 → 校验 → 复制到 `.staging`(不 `renameSync`)。
  返回:`{ ok: true, stagingId, manifest, warnings, displayName }`(sprite 包直接在这
  一步内部完成 commit,返回结果与今天的 `ImportResult` 形状兼容)或校验失败的
  `ImportResult`。
- `COMMIT_STAGED_IMPORT(stagingId)`:revoke 预览 token,`renameSync` 到最终目录。
- `DISCARD_STAGED_IMPORT(stagingId)`:revoke 预览 token,`rmSync` staging。

> 实现期待查清楚的事(不是设计决策):现在 `IPC.IMPORT_PET` 在 `src/main/shell/index.ts`
> 里注册了两处(约 145 行、953 行),写计划前要先确认这是两条独立场景(比如"无宠物
> 引导流程"与"设置页正常流程")还是重复代码,再决定怎么改这两处。

### 4.4 预览渲染

`STAGE_IMPORT_PET` 对 Live2D 包成功时,主进程用 `kiboPetProtocol.ts` 现成的
`registry.registerToken(stagingDir)` 开一个**独立于当前激活宠物**的预览 token,把
`{ manifest, resourceBaseUrl: 'kibo-pet://<previewToken>/' }` 传给设置窗口。

设置窗口(`settings.html`"宠物"页)新增预览区:一个 `<canvas>`,直接
`new Live2DPetRenderer(canvas)` + `.load(previewSource)`——复用 Phase 4 已有的同一个
渲染器类,不是重新写渲染逻辑。需要给 `settings.html` 的 CSP 补一条 `kibo-pet:`
(`connect-src`/`img-src`/`media-src`),与宠物窗口 Phase 2 加的那条一致。

预览面板显示:渲染出的模型(现有 auto-fit 逻辑在 `load()` 内自动跑,不用额外处理)、
`displayName`、已有的 `warnings`(纹理预算/水印/找回提示,校验逻辑不变)、
`[确认导入]` / `[取消]` 两个按钮。

### 4.5 预览面板的功能边界

只看不改:不提供实时调整 `scale/offset/mirror`、不提供 Motion Group 映射向导。
现有导入要求 `srcDir` 里已经有一份完整的 `pet.json`(含 `displayName`/`stateMap`/
`transform`),没有"选个裸 `model3.json` 自动生成其余字段"那整套向导流程——那属于
主设计文档 §5.1 更完整的未来形态,不在本次范围内。手动调 `scale/offset/mirror` 的
设置页 UI(主设计文档 §9 提到的部分)留给以后的阶段。

### 4.6 崩溃恢复

预览确认前应用崩溃 → 已有的 `cleanupStaleStaging()`(启动时清理残留 `.staging`)
天然覆盖这个新情况,不需要新代码。

## 5. 接口/Schema 改动汇总

- `PetRenderer` 新增 `setLookTarget(x: number, y: number): void`。
- `PetController` 新增 `setLipSync(level: number)`、`setMouseFocus(x: number, y: number)`。
- 新 IPC:`MOUSE_FOCUS`(main→renderer 推送)、`STAGE_IMPORT_PET` /
  `COMMIT_STAGED_IMPORT` / `DISCARD_STAGED_IMPORT`(取代 `IMPORT_PET`)。
- `settings.json` 新字段:`live2dMouseTrackingEnabled: boolean`(默认 `true`)。
- 新纯函数模块:`src/renderer/voice/lipSyncEnvelope.ts`(或 `src/shared/`,视是否
  需要在主进程测试中复用而定,交给 writing-plans 决定放置位置)。
- `petCatalog.ts`:`importPetFolder` 拆分出 `stageImportPet`(留在原地做校验+复制,
  sprite 包内部直接调用下面的 commit)、`commitStagedPet(stagingDir, finalDir)`、
  `discardStagedPet(stagingDir)`(后两者基本是把现有函数体尾部搬出来)。

## 6. 测试策略

延续主设计文档 §15 的分层:

- **纯逻辑 Vitest**:`lipSyncEnvelope.ts` 的 `computeEnvelope`/`createLipSyncSmoother`
  (固定 PCM 数组/固定目标序列 → 数值断言);鼠标追踪的"光标+窗口矩形+半径 → 归一化
  目标向量"如果拆成纯函数(建议拆,比如 `computeLookTarget(cursorPoint, windowBounds,
  radiusPx, dragging): {x,y}`),同样可以脱离 Electron 单测;`petCatalog.ts` 拆分后的
  stage/commit/discard 三段(复用现有 `.staging` 测试套路,断言 commit 前不出现在
  `listPets()`,commit/discard 后 `.staging` 清干净)。
- **主进程集成测试**:staged-import 的 commit/discard 都不修改 `activePetId`/当前
  session;预览 token 在 commit/discard 后被正确 `revokeToken`;两处 `IMPORT_PET`
  注册点按查清楚的实际语义分别覆盖。
- **Renderer 测试**:`setLookTarget`/`setLipSync` 走 Phase 4/5 已有的 mock-引擎测试
  模式(不接真实 WebGL),断言调用参数和调用时机(如 sleep 时目标被强制为 0)。
- **真机验收**(三块都逃不开,自动化检查过不代表能跑):鼠标追踪的视线跟随手感、
  拖拽/睡眠时的暂停与回正、口型和实际语音的对齐感、预览面板的真实渲染效果。

## 7. 执行安排

一份设计文档,拆成 3 份独立的实施计划文件(鼠标追踪 / 口型 / 导入预览,各自记录
一个子系统的任务拆解),但**在同一个开发分支里一次性跑完三份计划的所有任务**——不
在中间某一份做完后就先合并回 `main`。全部任务完成后跑一次整支 opus 最终审查,真机
验收通过后一次性合并 + squash(按 `CLAUDE.md` 的 SquashCommitConstraint)。
