# Live2D 呈现改造 · Phase 4:PixiJS/Live2D 最小加载 — 设计文档

## 背景

主设计文档(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)定义了完整的 8 阶段改造;Phase 0(GPU reboot-degrade)、Phase 1(Electron 31→43 升级)、Phase 2(宠物包 v2 + 导入器 + `kibo-pet://` 资源协议基础设施)、Phase 3(`PetRenderer` 抽象 + 精灵兼容驱动)均已完成并合并进本地 `main`(详见 `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md`)。

Phase 2/3 都刻意留白了三件事,留给 Phase 4 一次性做:

1. `kibo-pet://` 协议的真正接线(`registerSchemesAsPrivileged` + `installKiboPetProtocolHandler` + token 铸造/撤销)——Phase 2 只建了纯基础设施(`src/main/pets/kiboPetProtocol.ts`),没有消费方。
2. `PetRenderSource` 的 live2d 分支只带 `manifest`,不带 `baseUrl`——Phase 3 明确写"token 铸造是跟着会话生命周期走的运行时动作,不是 `loadPet()` 这种纯读盘函数能凭空生成的静态值"。
3. 真正能渲染的 `Live2DPetRenderer`(实现 Phase 3 定义的 `PetRenderer` 接口)——此前只有 `SpriteRenderer`。

此外,2026-07-21 的前置真实模型加载 spike(结论见主设计文档 §17)已经用两个真实购买模型在真机上验证过引擎 API 形状、贴图性能、构建链路踩坑、版本兼容 bug 和 VTube-Studio 游离资源找回,Phase 4 直接基于这些结论设计,不重新验证。

## 目标

1. `kibo-pet://` 协议完整接线:`app.ready` 前的 `registerSchemesAsPrivileged`、`installKiboPetProtocolHandler` 调用、token 铸造/撤销绑定到 `PetSession` 生命周期。
2. `PetRenderSource` 的 live2d 分支补上 `resourceBaseUrl`,`GET_PET` 全链路(main → preload → renderer)传导。
3. 实现 `Live2DPetRenderer`(`src/renderer/live2dRenderer.ts`),完整实现 Phase 3 定义的 `PetRenderer` 接口,接入真实的 `untitled-pixi-live2d-engine` + `pixi.js`。
4. 处理 `untitled-pixi-live2d-engine@1.3.5` 与官方最新 Cubism Core 5 之间已知的 `drawables.renderOrders` 版本不兼容问题(主设计文档 §17.2)。
5. 解决 Cubism Core 运行时的获取/分发问题(不通过 npm 分发,不能提交进 git)。
6. 验证并落地 bundler 策略,让 `untitled-pixi-live2d-engine` 能在本项目严格沙箱化的 renderer 环境里正确加载(主设计文档 §17.5 踩坑记录必须处理,不能临场发挥)。
7. `petCatalog.ts` 里对 live2d 包硬编码的 `renderReady: false` 翻转为按渲染器是否可用判断——Phase 4 完成后,live2d 宠物包在启动路径和 `switchPet()` 热切换里都真正可用。

## 非目标

- **动态窗口尺寸/脚底锚点/气泡锚点消费**(`PET_WINDOW_SIZE` 256×288 仍写死,`manifest.render.viewport` 字段读取但不消费)——Phase 5 处理。
- **无闪烁热切换 ACK 通道**——Phase 5 处理。`switchPet()` 现有的 `PET_CHANGED` 单向推送 + 渲染层整体 reload 机制照常复用,live2d 宠物之间/sprite↔live2d 之间切换时会有一次可见的黑屏/闪烁,这是本阶段接受的已知体验缺口,不在本阶段修。
- **连续鼠标追踪(视线跟随)**——Phase 6。`PetRenderer` 接口目前没有对应方法(如 `updateFocus(x,y)`),Phase 4 不新增。
- **TTS 口型包络平滑(attack/release RMS)**——Phase 6。`setLipSync(level)` 在本阶段只是一次性直接写参数,不做包络计算,调用方(`PcmPlayer`/`LipSyncEnvelope`)也不在本阶段实现。
- **语音固定端口 × 重叠热切换串行化**——Phase 5 处理(主设计文档 §17 无关,remaining-work 隐患 5)。
- 不改动 Phase 2 已完成的导入流程/安全校验/贴图预算警告本身。

## 1. Cubism Core 运行时获取

Live2D 官方 Cubism Core(`live2dcubismcore.js`)不通过 npm 分发,官方 SDK 许可证也不允许随意再分发,因此不能提交进 git、不能作为 npm 依赖声明。

- **新脚本 `scripts/fetch-live2d-core.mjs`**,直接参照 `untitled-pixi-live2d-engine` 自己的 `scripts/setup.mjs`(它已经验证过这个下载链路真实可行),复用项目已有的 `adm-zip` 依赖做解压(不新增 `jszip`):
  - 下载 `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip`(固定 r.5,与 spike 实际验证过兼容 patch 的版本一致,不用引擎仓库默认示例里的 r.4)。
  - 解压出 `Core/live2dcubismcore.js`(+`.d.ts` 供本地类型提示,不参与构建)到固定路径 `vendor/live2d-core/`。
- **接入方式:独立手动命令,不自动触发**。新增 `pnpm live2d:setup` script,用户/开发者自己手动跑一次。不接入 `postinstall`/`predev`,避免每次 `pnpm install` 都打外网、也避免离线/CI 环境下静默失败或卡住。
- `vendor/live2d-core/` 整体 `.gitignore`(新增一条,不碰根目录 `.gitignore` 里用户在途的其他修改——沿用 Phase 2 spike 计划里"改子目录自己的 `.gitignore`"的教训),README 补一条"缺 Live2D Core 运行时,请跑 `pnpm live2d:setup`"的说明,与现有"缺 `pets/luluka`"提示并列。
- **分发给沙箱化 renderer**:Cubism Core 是应用级基础设施,不是逐宠物内容,不适合塞进 `kibo-pet://` 的按会话 token 体系。做法:`pnpm live2d:setup` 额外把文件复制一份到 `src/renderer/public/live2dcubismcore.js`(electron-vite 的 renderer 构建会把 `public/` 原样拷进 `out/renderer/`),`src/renderer/index.html` 加一行同源 `<script src="./live2dcubismcore.js"></script>`(在 `main.ts` 之前),满足现有 `script-src 'self'` CSP,不需要放宽 CSP 来加载 Core 本身。

## 2. Bundler 策略

主设计文档 §17.5 记录的踩坑(`require()` 触发 `require(esm)` 互操作崩溃、浏览器原生 `import` 因裸模块说明符解析失败)都发生在 spike 工具里——那是一个 `nodeIntegration:true`、无任何打包器的原始 Electron 窗口,直接 `require()`/`<script type="module">` 加载 `node_modules` 包。

Kibo 生产环境的 renderer 完全不同:`electron-vite` 的 renderer 构建就是 Vite(生产构建走 Rollup + esbuild 转译,dev 模式走 Vite 自己的 esbuild 依赖预打包),这本身就是一个真正的 bundler,按设计就会解析裸模块说明符、拉平传递依赖、产出浏览器可直接跑的产物——这正是 spike 踩坑记录里缺失的那一层。因此不假设 spike 的结论原样适用,而是**把验证做成 Phase 4 计划的第一个任务**:

- 在 `src/renderer` 下随便一个文件里写 `import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'`(先不接业务逻辑),跑 `pnpm dev` 和 `pnpm build`,确认没有解析错误、产物里能正常 tree-shake/打包出这两个包。
- 如果这一步顺利:后续 `Live2DPetRenderer` 就是普通的 `import`,不需要额外的 esbuild 预打包步骤。
- 如果这一步暴露出真实的不兼容(比如 Vite 的某个默认优化对这个包的 ESM-only 产物处理有问题):退回到手写一个 esbuild 预打包脚本,产出一个自包含文件放进 `src/renderer/public/`,同样以同源 `<script>` 方式加载,不再走 `import`。

无论走哪条路径,这都是计划里明确列出的任务项,不是可以隐式假设"肯定没问题"就跳过的细节。

## 3. `kibo-pet://` 协议接线

### 3.1 `app.ready` 前的 scheme 注册

`src/main/index.ts` 顶层(在 `app.whenReady()` 调用之前,与现有 GPU 启动决策逻辑同级)新增:

```ts
protocol.registerSchemesAsPrivileged([KIBO_PET_SCHEME_PRIVILEGES])
```

### 3.2 handler 安装

`installKiboPetProtocolHandler(registry)` 在 `startShell()` 内部调用(`app.whenReady().then(() => startShell())` 之后,`protocol.handle` 要求 app 已 ready),与 registry 的构造(`createKiboPetProtocolRegistry()`)放在一起,registry 实例通过 `sessionDeps`/`PetSessionDeps` 向下传递给需要铸造 token 的地方。

### 3.3 Token 生命周期绑定到 `PetSession`

不选择"每次 `GET_PET` 调用铸造一次 token"——`GET_PET` 在同一个会话里会被多次调用(渲染层启动时一次、`PET_CHANGED` 触发的 reload 时也会再调一次),per-call 铸造会导致同一目录的旧 token 无人撤销,悄悄堆积。

改为:

- `PetSessionDeps` 新增 `kiboPetRegistry: ReturnType<typeof createKiboPetProtocolRegistry>` 字段。
- `createPetSession()` 构造时同步铸造一个 token(`deps.kiboPetRegistry.registerToken(petDir)`),不区分 sprite/live2d(铸造本身很便宜,区分反而增加分支复杂度),存到返回的 `PetSession.resourceToken: string` 新字段。
- `PetSession.dispose()` 里追加 `deps.kiboPetRegistry.revokeToken(this.resourceToken)`。
- `switchPet()` 现有的"先建后弃"顺序(先 `createPetSession(petId, ...)` 成功后才 `await session.dispose()` 旧会话)天然保证:新会话的 token 先铸造出来,旧会话的 token 在新会话确认可用之后才撤销,构建失败时旧 token 不受影响。

### 3.4 `GET_PET` handler / `PetRenderSource` 类型

`src/shared/petPackage.ts` 的判别式拓宽:

```ts
export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest; resourceBaseUrl: string }
```

`ipcMain.handle(IPC.GET_PET, ...)` 的实现从直接返回 `loadPet(session.petDir)` 改为:

```ts
ipcMain.handle(IPC.GET_PET, async () => {
  const source = await loadPet(session.petDir)
  if (source.type === 'live2d') {
    return { ...source, resourceBaseUrl: `kibo-pet://${session.resourceToken}/` }
  }
  return source
})
```

`loadPet()` 本体保持纯读盘函数不变(不接触 registry),`resourceBaseUrl` 的拼接是 IPC handler 层的职责,和 Phase 3 设计文档"loadPet 是纯读盘函数,不能凭空生成 token"的结论一致。

### 3.5 CSP

只改 `src/renderer/index.html`(宠物窗口),其余窗口(`dialog.html`/`settings.html`/`bubble.html`/...)CSP 不变:

```
connect-src 'self' kibo-pet:
img-src 'self' data: kibo-pet:
media-src 'self' kibo-pet:
```

## 4. `Live2DPetRenderer`

新文件 `src/renderer/live2dRenderer.ts`,`class Live2DPetRenderer implements PetRenderer`,构造函数只接收 `canvas`(与 `SpriteRenderer` 一致的简化构造模式,状态通过 `load(source)` 传入)。

| 接口方法 | 行为 |
|---|---|
| `load(source)` | 构造 Pixi `Application`(绑定到传入 canvas),`extensions.add(Live2DPlugin)`;首次调用时应用引擎版本兼容 patch(见 §5);`Live2DModel.from(\`${source.resourceBaseUrl}${source.manifest.render.model}\`)`;按 `manifest.render.transform` 设置 `scale`/`anchor`/位置偏移;`app.stage.addChild(model)`。Canvas 尺寸设为现有固定 `PET_WINDOW_SIZE`(256×288);`manifest.render.viewport` 字段本阶段只读取存着,不消费(留给 Phase 5)。 |
| `playState(state)` | 查 `manifest.render.stateMap[state]`。命中则按 `motionGroup`/`selection`(`random`/`sequential`/固定索引)/`loop` 调 `model.motion(group, index, priority)`,若有 `expression` 字段一并调 `model.expression(name)`。未命中,或 `model.motion()` 返回 `false`(spike 观察到这个返回值不完全可靠,见 §17.3),按 `fallback` 字段走一步回退(schema 保证最终收敛到 `idle`);若 `idle` 本身也没有映射,静默不动作(等价于自然待机,不是错误)。 |
| `setFacing(direction)` | 真实实现(区别于 `SpriteRenderer` 的 no-op):`manifest.render.interaction.mirrorOnWalk` 为真时,`model.scale.x = direction === 'left' ? -Math.abs(currentAbsScale) : Math.abs(currentAbsScale)`;为假时 no-op。 |
| `setLipSync(level)` | `model.internalModel.coreModel.setParameterValueById(manifest.render.interaction.lipSyncParameter, level)`,一次性直接写入,不做包络平滑(Phase 6 范围)。 |
| `hitTest(x, y)` | 先调 `model.hitTest(x, y)`(返回命中的 HitArea 名称数组);若为空(两个 spike 模型都没有声明 HitAreas,是预期情况,不是 bug),退化为 Pixi 包围盒命中判断(`model.getBounds()` 是否包含该点),这种情况下 `PetHitResult.area` 不填。 |
| `resize(viewport)` | 本阶段 no-op(与 `SpriteRenderer` 对齐),但内部实现为真实的 `app.renderer.resize(...)` 调用而不是空函数体——没有调用方去触发它,只是不留一个 Phase 5 还要重写的占位符。 |
| `setVisible(visible)` | `canvas.style.display` 切换 + 暂停/恢复 Pixi ticker(隐藏时暂停,避免不可见的模型仍在跑 Idle Motion/物理消耗 CPU)。 |
| `destroy()` | `model.destroy()` + `app.destroy(true)`(释放 canvas 和 GL 上下文),返回真正的 `Promise`(不是 sprite 那种 `Promise.resolve()`)。 |

`src/renderer/main.ts` 的 `createRenderer()` 工厂新增分支:

```ts
function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}
```

原来的"live2d 渲染器尚未实现"防御性抛出连同其注释一起删除——Phase 4 完成后这个分支是真实可达的。

## 5. 引擎版本兼容 patch

`untitled-pixi-live2d-engine@1.3.5` 假设 Cubism Core 的 `Model` 对象暴露 `drawables.renderOrders` 属性,但官方最新 Cubism Core 5(`06.00.0001`)把这个字段设为 private,只能通过 `getRenderOrders()` 方法读取——每帧渲染都会因此崩溃(黑屏),spike 已验证一个运行时 patch(用 `getRenderOrders()` 回填该属性)能绕过。

新模块 `src/renderer/live2d/cubismCoreCompat.ts`,在 `Live2DPetRenderer.load()` 里模型加载完成后、首次渲染前调用一次:

```ts
export function applyCubismCoreCompatPatch(coreModel: unknown): void {
  const m = coreModel as any
  if (m?.drawables && typeof m.drawables.renderOrders === 'undefined' && typeof m.getRenderOrders === 'function') {
    Object.defineProperty(m.drawables, 'renderOrders', { get: () => m.getRenderOrders() })
  }
}
```

自我禁用式设计:先探测直接属性是否已经可用(未来引擎或 Core 版本修复此问题后,探测会发现属性已存在,自动跳过 patch),不需要跟着版本号手动开关。纯函数,喂一个假的 `coreModel` 形状对象即可单测,不需要真实 WebGL 环境。

## 6. `renderReady` 翻转

`src/main/pets/petCatalog.ts` 里四处硬编码的 `renderType === 'live2d' → renderReady: false` 改为 `renderReady: true`(Phase 4 完成后,live2d 渲染器是真实可用的)。

连带影响需要在计划里显式覆盖(不是这个改动的隐藏副作用,而是预期结果):

- `resolveEffectivePetHome.ts` 里"配置的宠物是 live2d(renderReady:false)→ 回退默认 sprite 宠物"这条测试用例的语义反转——现在配置一个 live2d 包作为 `activePetId` 应该能正常启动,不再回退。
- `switchPet()` 现有的 `!target.renderReady` 拦截不再命中 live2d 目标,热切换到 live2d 宠物应该真正生效(伴随一次可见闪烁,已在"非目标"里说明是本阶段接受的缺口)。
- 寄养选择器/聊天列表/设置下拉框(Phase 2 已实现"live2d 条目可见但因 `renderReady:false` 置灰禁用切换")的置灰逻辑需要确认会自动因 `renderReady` 变 `true` 而解除——这些 UI 组件读的是 `PetSummary.renderReady`,不需要额外改动,但要有测试覆盖这条路径而不是假设它"自动就对了"。

## 6.1 渲染器类型热切换(计划阶段发现的缺口)

`src/renderer/petController.ts` 的 `reload()`(`await this.renderer.load(source)`)固定操作构造时传入的同一个渲染器实例,从不重新按 `source.type` 选择渲染器类型。Phase 3 时这是安全的死代码路径——`renderReady:false` 保证 `source.type` 永远不会在一次热切换里从 `sprite` 变成 `live2d`(反之亦然)。但 §6 把 `renderReady` 翻转为 `true` 后,`switchPet()` 在 sprite 宠物和 live2d 宠物之间切换会让 `reload()` 真正收到一个类型变了的 `PetRenderSource`,而 `SpriteRenderer.load()`/`Live2DPetRenderer.load()` 都会因为类型不匹配直接抛错——这是一次真正的崩溃,不是"非目标"里说的可接受的视觉闪烁。

修复:`src/renderer/main.ts` 把 `createRenderer()` 工厂函数提出来给 `boot()` 和 `PetController` 共用(或等价地把工厂传给 `PetController` 构造函数)。`PetController.reload()` 改为:

1. 拉取新 `source`。
2. 若 `source.type` 与当前渲染器所属类型不一致:`await this.renderer.destroy()` 销毁旧实例,用工厂按新 `source.type` 构造一个新实例,替换 `this.renderer`(需要把该字段从构造时的 `private readonly` 改为可重新赋值),再 `await this.renderer.load(source)`。
3. 类型一致时行为不变(直接复用现有实例 `load()`)。

这段逻辑放在 `PetController` 内部而不是 `main.ts` 的事件处理器里,因为 `PetController` 已经是"知道当前渲染器是谁"的唯一权威位置,`main.ts` 只是事件转发。渲染器类型只有两种(sprite/live2d),`instanceof` 或者携带一个 `rendererType` 字段都能判断"是否需要换实例"——采用后者(`PetRenderer` 接口不适合塞一个跟渲染逻辑无关的类型标签,改为 `PetController` 自己记录"当前渲染器是用哪个 `source.type` 构造的",不侵入接口)。

## 7. 测试策略

**纯逻辑 Vitest(不依赖真实 WebGL/canvas,延续项目现状):**

- `playState` 的 `stateMap` 查找 + `fallback` 链解析逻辑,喂一个假的 `manifest.render.stateMap` 和一个记录调用的假 `model` 对象,断言未命中/播放失败时按 `fallback` 收敛。
- `applyCubismCoreCompatPatch` 的自我禁用探测逻辑:属性已存在时不 patch、属性缺失且 `getRenderOrders` 存在时打上 patch 且读值正确、两者都缺失时不崩溃。
- `hitTest` 的包围盒退化判断(纯几何函数,喂坐标和假 bounds)。
- `kiboPetRegistry` token 铸造/撤销与 `PetSession` 生命周期绑定:`createPetSession` 铸造、`dispose()` 撤销、`switchPet()` 先建后弃顺序下新旧 token 不冲突。
- `petCatalog.ts` 的 `renderReady` 翻转 + `resolveEffectivePetHome`/`switchPet` 对应测试用例的语义更新。

**不新增的测试类型(维持项目现状):** 不引入 headless WebGL/jsdom canvas mock 去测真实渲染像素——这类验证的性价比低,项目一直靠 `pnpm preview` 真机确认,Phase 2/3 都是这个哲学,Phase 4 沿用。

**真机验证(mandatory,agent 会话无法自动化):**

- `pnpm live2d:setup` 实际跑通,`vendor/live2d-core/` 和 `src/renderer/public/live2dcubismcore.js` 正确生成。
- 复用 spike 用过的两个真实购买模型(`白-免费版`/`茕兔pack`,`D:\LProject\claude_Project\live2dModel\` 下),通过 Phase 2 导入器导入成 `pets/<id>/` 包(gitignore,不提交,类比 `pets/luluka`)。`茕兔pack` 需要走 Phase 2 已实现的游离资源(`.exp3.json`/`.motion3.json`)找回合成,才能避开卖家水印保护图(spike §17.4 已确认这条路径可行)。
- 实际模型正常渲染(不黑屏、不花屏)、CSP 没有拦截 Core 脚本加载、`playState` 各状态触发对应 Motion/Expression、`setFacing` 镜像观感正确、点击穿透在模型像素上/外行为正确、拖拽/开对话框等既有交互无回归。
- 版本兼容 patch 确认针对真实下载的 Cubism Core 5 生效(不崩、不黑屏)。
- `renderReady` 翻转后,寄养选择器/设置下拉框里 live2d 条目从置灰变为可选,实际点击切换能成功(伴随预期内的一次闪烁)。
- `pnpm typecheck && pnpm test && pnpm build` 全绿是前提,不是替代真机验证的证明。

## 验收标准

- [ ] `pnpm live2d:setup` 脚本存在且可用,`vendor/live2d-core/`(gitignore)+ `src/renderer/public/live2dcubismcore.js` 正确产出。
- [ ] bundler 验证任务已跑(walking-skeleton import 测试),`pnpm dev`/`pnpm build` 对 `untitled-pixi-live2d-engine/cubism` 无解析错误。
- [ ] `kibo-pet://` 协议完整接线:`registerSchemesAsPrivileged` 在 `app.ready` 前调用,`installKiboPetProtocolHandler` 已装,token 铸造/撤销绑定 `PetSession` 生命周期,有测试覆盖。
- [ ] `PetRenderSource` live2d 分支补上 `resourceBaseUrl`,`GET_PET` 全链路类型对齐。
- [ ] `Live2DPetRenderer` 完整实现 `PetRenderer` 接口,`main.ts` 工厂函数接入,原有的"尚未实现"防御性抛出删除。
- [ ] 引擎版本兼容 patch 落地且有自我禁用探测逻辑的单测。
- [ ] `petCatalog.ts` 的 `renderReady` 翻转,`resolveEffectivePetHome`/`switchPet` 相关测试用例语义同步更新。
- [ ] `PetController.reload()` 在 `source.type` 变化时销毁旧渲染器实例并构造新类型实例(§6.1),sprite↔live2d 热切换不再抛错,有测试覆盖。
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] 真机验证清单(§7 最后一节)全部走完并确认无阻断性问题。
