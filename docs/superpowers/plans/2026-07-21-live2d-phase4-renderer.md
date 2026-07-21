# Live2D Phase 4: PixiJS/Live2D 最小加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个真正能加载、渲染、播放动作的 `Live2DPetRenderer`,接入 `kibo-pet://` 协议的完整运行时接线,处理已知的引擎版本兼容问题,并把 `renderReady` 翻转为真实可用状态——完成后 live2d 宠物包能在启动路径和热切换里正常工作(接受一次可见的切换闪烁,无闪烁是 Phase 5 的工作)。

**Architecture:** 主进程新增 `kibo-pet://` 协议的运行时接线(scheme 注册 + handler 安装 + token 生命周期绑定到 `PetSession`);渲染进程新增 `Live2DPetRenderer`(`untitled-pixi-live2d-engine/cubism` + `pixi.js`),配合两个纯逻辑辅助模块(stateMap 回退解析、hitTest 包围盒兜底)和一个引擎版本兼容 patch;`PetController`/`main.ts` 补一个此前被 `renderReady:false` 掩盖的缺口——渲染器类型热切换。Cubism Core 运行时通过独立、手动触发的 `pnpm live2d:setup` 脚本获取,不进入 npm 依赖树,也不提交进 git。

**Tech Stack:** `pixi.js@8.19.0`、`untitled-pixi-live2d-engine@1.3.5`(与本机已克隆引擎源码版本一致)、`adm-zip`(已是项目依赖,复用做 Cubism Core SDK 压缩包解压)、Electron 43 `protocol.handle`/`registerSchemesAsPrivileged`。

## Global Constraints

- 包管理器是 pnpm,不是 npm/yarn。
- `pixi.js`/`untitled-pixi-live2d-engine` 精确锁定版本 `8.19.0`/`1.3.5`(不用 `^` 范围),与本机已克隆的引擎源码版本、之前 spike 验证过的版本保持一致,避免版本漂移导致行为和已验证结论不一致。
- Cubism Core SDK 版本固定为 `CubismSdkForWeb-5-r.5`(与主设计文档 §17.2 记录的、兼容 patch 实际验证过的版本一致)。
- **不要修改根目录 `.gitignore`**——它当前有用户在途、尚未提交的修改(`pets/yyz`/`GenieData` 相关)。任何新增的忽略规则改用受影响子目录自己的一份 `.gitignore`。
- 不要给 `pixi.js`/`untitled-pixi-live2d-engine` 加 `"type": "module"` 或改动根 `package.json` 的模块类型——CLAUDE.md 明确禁止给整个项目加 `"type": "module"`(会让 Electron main/preload 崩溃),这两个包只在 renderer 侧通过 Vite 打包消费,不影响这条约束。
- `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false` 安全基线不得放宽;CSP 改动只加白名单条目,不加 `unsafe-eval`/`unsafe-inline`,也不关闭 `webSecurity`。
- 根 `tsconfig.json` 开了 `noUnusedLocals`/`noUnusedParameters`——每个任务提交前的 `pnpm typecheck` 必须真正为绿,不能留下"声明了但要等后续任务才用到"的变量/参数(未使用的方法参数用 `_` 前缀这个项目已有的约定处理,例如 `_state`/`_viewport`)。
- **真机验证(GPU/显示相关)无法在 agent 会话里自动化**——每个涉及实际渲染效果的任务都要明确标注这一点,`pnpm typecheck && pnpm test && pnpm build` 全绿不能替代真机确认。
- 遵循 CLAUDE.md 的提交规范:小步提交、conventional-commit 前缀、提交信息用中文。

---

### Task 1: `Live2DPetRenderer` 骨架 + 依赖引入(bundler 验证)

**Files:**
- Modify: `package.json`(新增 `pixi.js`/`untitled-pixi-live2d-engine` 依赖)
- Create: `src/renderer/live2dRenderer.ts`
- Modify: `src/renderer/main.ts`(`createRenderer()` 工厂新增 live2d 分支)

**Interfaces:**
- Consumes: `PetRenderer` 接口(`src/renderer/petRenderer.ts`,已存在)、`PetRenderSource`(`@shared/petPackage`,已存在,live2d 分支目前是 `{ type: 'live2d'; manifest: Live2DManifest }`,Task 3 会加 `resourceBaseUrl`)。
- Produces:`export class Live2DPetRenderer implements PetRenderer`,构造函数签名 `constructor(private canvas: HTMLCanvasElement)`,供 Task 9 继续完善方法体、供 Task 10 的 `PetController` 类型热切换逻辑使用。

这个任务的目的是**先验证 bundler 策略**(设计文档 §2):在真正实现完整渲染逻辑之前,先确认 `pnpm dev`/`pnpm build` 能正常处理 `untitled-pixi-live2d-engine/cubism` 的 import,不需要额外的 esbuild 预打包步骤。`load()` 做真实的 Pixi Application + 引擎插件注册 + 模型加载(证明 bundler 链路可行);`playState`/`setFacing`/`setLipSync`/`hitTest` 先给出安全的最小实现(空操作/固定返回值,和 `SpriteRenderer` 里那些真正意义上的最终 no-op 一样是合法的完整实现,只是行为上还很简单),Task 9 会把它们替换成真正驱动模型的逻辑。

- [ ] **Step 1: 安装精确版本依赖**

```bash
pnpm add -D pixi.js@8.19.0 untitled-pixi-live2d-engine@1.3.5
```

放进 `devDependencies` 而不是 `dependencies`——这两个包只被 renderer 的 Vite 构建消费,产物已经把它们完整打包进 `out/renderer` 的 bundle 里,打包后的 app 运行时不需要 `node_modules/pixi.js` 物理存在,不应该被 electron-builder 打进最终安装包,增加体积。

- [ ] **Step 2: 确认根目录 lockfile/package.json 改动符合预期**

```bash
git diff package.json pnpm-lock.yaml | head -40
```

Expected: `package.json` 的 `devDependencies` 新增两行(`pixi.js`、`untitled-pixi-live2d-engine`),`pnpm-lock.yaml` 有对应新增条目,退出码 0。

- [ ] **Step 3: 写 `Live2DPetRenderer` 骨架**

```ts
// src/renderer/live2dRenderer.ts
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'

let pluginRegistered = false

/** live2d 渲染器:实现 Phase 3 定义的 PetRenderer 接口,驱动真实的
 *  untitled-pixi-live2d-engine + pixi.js 模型加载/播放。 */
export class Live2DPetRenderer implements PetRenderer {
  private app: Application | null = null
  private model: Live2DModel | null = null
  private manifest: Live2DManifest | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  async load(source: PetRenderSource): Promise<void> {
    if (source.type !== 'live2d') throw new Error('Live2DPetRenderer 只能加载 type:"live2d" 的 PetRenderSource')
    if (!pluginRegistered) {
      extensions.add(Live2DPlugin)
      pluginRegistered = true
    }
    await this.destroy()

    this.manifest = source.manifest
    const app = new Application()
    await app.init({ canvas: this.canvas, width: 256, height: 288, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio })
    this.app = app

    const modelUrl = `${source.manifest.render.model}`
    const model = await Live2DModel.from(modelUrl)
    const t = source.manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    model.scale.set(t.scale)
    model.position.set(app.screen.width / 2 + t.offsetX, app.screen.height / 2 + t.offsetY)
    app.stage.addChild(model)
    this.model = model
  }

  playState(_state: PetVisualState): void {}

  setFacing(_direction: 'left' | 'right'): void {}

  setLipSync(_level: number): void {}

  hitTest(_x: number, _y: number): PetHitResult {
    return { hit: false }
  }

  resize(_viewport: PetViewport): void {
    // no-op:与 SpriteRenderer 对齐,Phase 5 才会真正驱动动态窗口尺寸。
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
    if (this.app) {
      if (visible) this.app.ticker.start()
      else this.app.ticker.stop()
    }
  }

  async destroy(): Promise<void> {
    this.model?.destroy()
    this.model = null
    this.manifest = null
    if (this.app) {
      this.app.destroy(false, { children: true })
      this.app = null
    }
  }
}
```

注:`modelUrl` 这一步先直接用 `manifest.render.model`(一个相对路径,还加载不出真实模型,因为还没有 `resourceBaseUrl` 前缀,也没有 `kibo-pet://` 协议 handler 接线)——这个任务的目的只是验证 import/打包链路,不要求这一步真的能加载出模型,Task 8 会用上真正的 `resourceBaseUrl` 前缀。`app.init({ canvas: this.canvas, ... })` 直接绑定已有 canvas(而不是让 Pixi 自己创建一个再手动挂载),`app.destroy(false, ...)` 的第一个参数是 `removeView`——传 `false` 是因为这个 canvas 元素本身是 `index.html` 里的 `#pet`,不该被销毁,只需要清理 Pixi 内部状态,供下次 `load()` 复用同一个 canvas。

- [ ] **Step 4: `main.ts` 工厂函数接入 live2d 分支**

打开 `src/renderer/main.ts`,把:

```ts
import { SpriteRenderer } from './spriteRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  // 理论上不可达:主进程的启动守卫(resolveEffectivePetHome)和 switchPet() 的 renderReady
  // 检查都会拦住 live2d 包,Phase 4 之前不会有真实渲染器可用。这里防御性地抛出,由下面
  // boot().catch(showBootError) 现有的错误横幅机制兜住,而不是让类型系统悄悄放过一个死代码路径。
  throw new Error('live2d 渲染器尚未实现(Phase 4)')
}
```

改成:

```ts
import { SpriteRenderer } from './spriteRenderer'
import { Live2DPetRenderer } from './live2dRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}
```

（`boot()`/`PetController` 构造那一段先不动——Task 10 会专门改这部分来支持渲染器类型热切换。）

- [ ] **Step 5: typecheck(这一步就是"bundler 验证"本身)**

```bash
pnpm typecheck
```

Expected: 退出码 0,没有关于 `untitled-pixi-live2d-engine/cubism` 或 `pixi.js` 的解析/类型错误。如果这里报错(比如引擎的 `.d.ts` 和某个 API 签名对不上),现在就是发现并修正的时机,不要绕过。

- [ ] **Step 6: build(验证生产构建路径,这是设计文档 §2 要求的关键一步)**

```bash
pnpm build
```

Expected: 退出码 0。这一步验证的是 electron-vite 的 Rollup/esbuild 构建管线能正确处理这两个包的裸模块说明符解析和传递依赖打包(主设计文档 §17.5 记录的踩坑发生在一个完全没有 bundler 的原始 Electron 窗口里,这里验证的是电子这边真正的生产构建路径是否已经免疫那类问题)。如果失败,记录具体报错信息——设计文档已经预案了退回手写 esbuild 预打包步骤,但先确认这里是否真的需要那条退路。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml src/renderer/live2dRenderer.ts src/renderer/main.ts
git commit -m "feat(live2d): Live2DPetRenderer 骨架 + pixi.js/引擎依赖引入,验证 bundler 链路"
```

---

### Task 2: Cubism Core 运行时获取脚本

**Files:**
- Create: `scripts/fetch-live2d-core.mjs`
- Create: `vendor/.gitignore`
- Create: `src/renderer/public/.gitignore`
- Modify: `package.json`(新增 `live2d:setup` script)
- Modify: `README.md`(补一条获取说明,与现有 `pets/luluka` 缺失提示并列)

**Interfaces:**
- Consumes: 无(不依赖前面任务的产物)。
- Produces: `pnpm live2d:setup` 命令;运行后产出 `vendor/live2d-core/live2dcubismcore.js`(+`.d.ts`)和 `src/renderer/public/live2dcubismcore.js`,供 Task 5 的 `<script>` 标签加载。

**这个任务的下载/解压部分依赖真实外网连接,agent 会话里不强制实际跑通**——只要求脚本本身语法正确、逻辑合理,真正跑一次交给用户在真机上做(与 `pets/luluka`、Genie-TTS 运行时下载走同样的"agent 写好,用户跑"分工)。

- [ ] **Step 1: 写获取脚本**

```js
// scripts/fetch-live2d-core.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const CORE_SDK_URL = 'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip'
const ZIP_ENTRY_PREFIX = 'CubismSdkForWeb-5-r.5/Core/'

const _dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(_dirname, '..')
const vendorDir = join(repoRoot, 'vendor', 'live2d-core')
const publicDir = join(repoRoot, 'src', 'renderer', 'public')

async function main() {
  console.log(`Downloading ${CORE_SDK_URL} ...`)
  const res = await fetch(CORE_SDK_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) throw new Error('downloaded zip is empty')

  const zip = new AdmZip(buffer)
  const jsEntry = zip.getEntry(`${ZIP_ENTRY_PREFIX}live2dcubismcore.js`)
  const dtsEntry = zip.getEntry(`${ZIP_ENTRY_PREFIX}live2dcubismcore.d.ts`)
  if (!jsEntry) {
    throw new Error(`zip 里找不到 ${ZIP_ENTRY_PREFIX}live2dcubismcore.js —— Live2D 可能改了 SDK 包的目录结构,需要更新这个脚本`)
  }

  mkdirSync(vendorDir, { recursive: true })
  mkdirSync(publicDir, { recursive: true })

  const jsBuffer = jsEntry.getData()
  writeFileSync(join(vendorDir, 'live2dcubismcore.js'), jsBuffer)
  writeFileSync(join(publicDir, 'live2dcubismcore.js'), jsBuffer)
  if (dtsEntry) writeFileSync(join(vendorDir, 'live2dcubismcore.d.ts'), dtsEntry.getData())

  console.log(`Done. Wrote:\n  ${join(vendorDir, 'live2dcubismcore.js')}\n  ${join(publicDir, 'live2dcubismcore.js')}`)
}

main().catch((err) => {
  console.error('[fetch-live2d-core] 失败:', err)
  process.exitCode = 1
})
```

- [ ] **Step 2: 语法检查**

```bash
node --check scripts/fetch-live2d-core.mjs
```

Expected: 无输出,退出码 0。

- [ ] **Step 3: 子目录 `.gitignore`(不碰根目录 `.gitignore`)**

```bash
mkdir -p vendor
cat > vendor/.gitignore <<'EOF'
live2d-core/
EOF
mkdir -p src/renderer/public
cat > src/renderer/public/.gitignore <<'EOF'
live2dcubismcore.js
EOF
```

- [ ] **Step 4: `package.json` 新增 script**

在 `scripts` 里 `"dist"` 那一行后面加一行:

```json
"live2d:setup": "node scripts/fetch-live2d-core.mjs",
```

不接入 `postinstall`/`predev`——独立手动命令,不自动触发(设计文档 §1)。

- [ ] **Step 5: README 补一条获取说明**

在 README.md 里找到现有关于 `pets/luluka` 缺失的说明段落附近,追加一段(不确定具体现有措辞时,直接在同一节末尾加一条即可):

```markdown
### Live2D Cubism Core 运行时

`vendor/live2d-core/` 和 `src/renderer/public/live2dcubismcore.js` 未随仓库分发(Live2D 官方 SDK 许可证不允许随意再分发,已被 gitignore)。首次开发 live2d 渲染相关功能前,运行一次：

```bash
pnpm live2d:setup
```

该命令会从 Live2D 官网下载 Cubism SDK for Web 并解压出运行时脚本。
```

- [ ] **Step 6: 确认 gitignore 生效、无关文件未被误加**

```bash
git status --short
```

Expected:`vendor/.gitignore`、`src/renderer/public/.gitignore`、`package.json`、`README.md` 是新增/修改;不出现 `vendor/live2d-core/` 或 `src/renderer/public/live2dcubismcore.js`(还没跑过 `pnpm live2d:setup`,这两个路径此时应该根本不存在,不是"存在但被忽略")。

- [ ] **Step 7: 提交**

```bash
git add scripts/fetch-live2d-core.mjs vendor/.gitignore src/renderer/public/.gitignore package.json README.md
git commit -m "feat(live2d): 新增 pnpm live2d:setup 脚本获取 Cubism Core 运行时"
```

---

### Task 3: `PetRenderSource` 补 `resourceBaseUrl`

**Files:**
- Modify: `src/shared/petPackage.ts`
- Modify: `src/main/petLoader.ts`
- Modify: `src/renderer/live2dRenderer.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `PetRenderSource` 的 live2d 分支变为 `{ type: 'live2d'; manifest: Live2DManifest; resourceBaseUrl: string }`,供 Task 4(main 进程侧生成这个字段)和 Task 9(渲染器侧消费)使用;`src/main/petLoader.ts` 导出的 `LoadedPetSource` 类型(缺 `resourceBaseUrl` 的中间态),供 Task 4 的 `GET_PET` handler 使用。

- [ ] **Step 1: 改 `PetRenderSource` 类型定义**

在 `src/shared/petPackage.ts` 找到:

```ts
export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }
```

改成:

```ts
export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest; resourceBaseUrl: string }
```

- [ ] **Step 2: 给 `petLoader.ts` 一个明确的中间类型**

`loadPet()` 是纯读盘函数,不接触 `kibo-pet://` token(那是运行时会话状态,由 Task 4 的 `GET_PET` handler 补上,不是这个函数的职责——设计文档 §3.4)。给它一个专属的、比 `PetRenderSource` 少一个字段的返回类型,而不是让它返回不满足 `PetRenderSource` 的假对象。

打开 `src/main/petLoader.ts`,把:

```ts
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type PetRenderSource } from '@shared/petPackage'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

export async function loadPet(petDir: string): Promise<PetRenderSource> {
  const manifestRaw = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
  if (isLive2DManifestRaw(manifestRaw)) {
    const manifest = parseLive2DManifest(manifestRaw)
    return { type: 'live2d', manifest }
  }
  const manifest = parsePetManifest(manifestRaw)
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { type: 'sprite', manifest, spritesheetDataUrl }
}
```

改成:

```ts
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type Live2DManifest, type PetManifest } from '@shared/petPackage'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

/** loadPet() 的返回类型比对外的 PetRenderSource 少一个 resourceBaseUrl——那个字段是运行时
 *  会话状态(token 铸造),不是这个纯读盘函数能凭空生成的,由 GET_PET handler(shell/index.ts)
 *  补上。见 docs/superpowers/specs/2026-07-21-live2d-phase4-renderer-design.md §3.4。 */
export type LoadedPetSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }

export async function loadPet(petDir: string): Promise<LoadedPetSource> {
  const manifestRaw = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
  if (isLive2DManifestRaw(manifestRaw)) {
    const manifest = parseLive2DManifest(manifestRaw)
    return { type: 'live2d', manifest }
  }
  const manifest = parsePetManifest(manifestRaw)
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { type: 'sprite', manifest, spritesheetDataUrl }
}
```

- [ ] **Step 3: typecheck,确认这一步不引入新的报错**

```bash
pnpm typecheck
```

Expected: 退出码 0。`src/main/shell/index.ts` 现有的 `ipcMain.handle(IPC.GET_PET, async () => loadPet(session.petDir))` 这一行没有显式类型标注,`ipcMain.handle`/`ipcRenderer.invoke` 之间也没有编译期强制关联(Electron 的类型定义里两边各自独立,`preload/index.ts` 的 `getPet: (): Promise<PetRenderSource> => ipcRenderer.invoke(...)` 这个标注只是断言,`ipcRenderer.invoke()` 本身返回 `Promise<any>`,不会被拿来跟 `loadPet()` 的真实返回类型做结构比对)——所以这一步不会因为 `loadPet()` 的返回类型变窄而报错,这是已知的、不需要修的类型系统盲区,不是这个任务的疏漏。Task 4 会给 `GET_PET` handler 加上显式的 `Promise<PetRenderSource>` 返回类型标注并让实现真正满足它,补上这层本该有的类型保障。`petSession.ts` 的 `startVoice()` 只读 `source.type === 'sprite' ? source.manifest.voice : undefined`,这个用法对 `LoadedPetSource` 同样成立,不需要改动。

- [ ] **Step 4: `live2dRenderer.ts` 用上真正的 `resourceBaseUrl`**

打开 `src/renderer/live2dRenderer.ts`,把:

```ts
    const modelUrl = `${source.manifest.render.model}`
```

改成:

```ts
    const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
```

- [ ] **Step 5: 提交(`shell/index.ts` 的报错留给 Task 4 解决,这里先提交类型层改动)**

```bash
git add src/shared/petPackage.ts src/main/petLoader.ts src/renderer/live2dRenderer.ts
git commit -m "feat(live2d): PetRenderSource live2d 分支补 resourceBaseUrl,petLoader 改用中间类型"
```

---

### Task 4: `kibo-pet://` 协议接线 + `PetSession` token 生命周期

**Files:**
- Modify: `src/main/index.ts`(顶部新增 import + scheme 注册)
- Modify: `src/main/shell/petSession.ts`(`PetSessionDeps`/`PetSession` 接口 + `createPetSession()`/`dispose()`)
- Modify: `src/main/shell/petSession.test.ts`(`makeDeps()` fixture 补 `kiboPetRegistry` + 新测试)
- Modify: `src/main/shell/index.ts`(构造 registry + 安装 handler + `sessionDeps` 补字段 + `GET_PET` handler)

**Interfaces:**
- Consumes: `createKiboPetProtocolRegistry`/`installKiboPetProtocolHandler`/`KIBO_PET_SCHEME_PRIVILEGES`(`src/main/pets/kiboPetProtocol.ts`,Phase 2 已实现,本任务是第一个消费方)、`LoadedPetSource`(Task 3)。
- Produces:`PetSession.resourceToken: string`;`GET_PET` handler 返回真正符合 `PetRenderSource` 类型的对象。

这个任务把"注册 scheme"、"安装 handler"、"session 铸造/撤销 token"、"`GET_PET` 拼出 `resourceBaseUrl`"合并成一个任务——它们是同一条数据流的四个环节,拆开会导致中间状态里出现"声明了但没用"的变量,撞上 `noUnusedLocals`。

- [ ] **Step 1: `main/index.ts` 顶部注册 scheme 特权**

打开 `src/main/index.ts`,把顶部 import 区:

```ts
import { app, dialog } from 'electron'
import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'
import { loadSettings, saveSettings } from './config/settings'
import { decideGpuBoot } from '@shared/gpuBootDecision'
```

改成:

```ts
import { app, dialog, protocol } from 'electron'
import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'
import { loadSettings, saveSettings } from './config/settings'
import { decideGpuBoot } from '@shared/gpuBootDecision'
import { KIBO_PET_SCHEME_PRIVILEGES } from './pets/kiboPetProtocol'

protocol.registerSchemesAsPrivileged([KIBO_PET_SCHEME_PRIVILEGES])
```

放在 import 之后、其余逻辑(`GPU_MARKER_FILE_NAME` 常量声明)之前——`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前调用(Electron 硬性要求),越早越安全,不需要等 GPU 决策逻辑跑完。

- [ ] **Step 2: `PetSessionDeps` 新增 `kiboPetRegistry` 字段**

打开 `src/main/shell/petSession.ts`,在 `PetSessionDeps` 接口里 `voiceDeps: VoiceSessionDeps` 那一行之后加:

```ts
  voiceDeps: VoiceSessionDeps
  /** kibo-pet:// 协议的 token 注册表(main/pets/kiboPetProtocol.ts),startShell 建一次注入。
   *  createPetSession 用它给每个会话铸造一个资源 token,dispose() 时撤销。 */
  kiboPetRegistry: {
    registerToken(rootDir: string): string
    revokeToken(token: string): void
  }
```

- [ ] **Step 3: `PetSession` 接口新增 `resourceToken` 字段**

```ts
export interface PetSession {
  petId: string
  petDir: string
  memoryDir: string
  resourceToken: string
  memory: MemoryManager
  chat: ChatStore
  messages(): ChatMessage[]
  startVoice(): void
  stopSpeech(): void
  dispose(): Promise<void>
}
```

- [ ] **Step 4: `createPetSession()` 铸造 token,`dispose()` 撤销**

在 `createPetSession()` 函数体里,`const petDir = petHome` 那一行之后加:

```ts
  const petDir = petHome
  const resourceToken = deps.kiboPetRegistry.registerToken(petDir)
```

在函数末尾的 return 对象里加上 `resourceToken`,并在 `dispose()` 里补撤销调用:

```ts
  return {
    petId,
    petDir,
    memoryDir,
    resourceToken,
    memory,
    chat,
    messages: () => memory.messages(),
    startVoice,
    stopSpeech: () => speechSequencerInstance?.stop(),
    async dispose(): Promise<void> {
      try { chat.cancel() } catch (e) { console.warn('[petSession] chat.cancel', e) }
      try { appFocusWatcher.stop() } catch (e) { console.warn('[petSession] appFocus.stop', e) }
      try { await stopVoice() } catch (e) { console.warn('[petSession] stopVoice', e) }
      try { deps.kiboPetRegistry.revokeToken(resourceToken) } catch (e) { console.warn('[petSession] revokeToken', e) }
    }
  }
```

- [ ] **Step 5: 更新 `petSession.test.ts` 的 fixture**

打开 `src/main/shell/petSession.test.ts`,在 `makeDeps()` 返回对象里(`voiceDeps: { ... }` 那个字段之后)加:

```ts
    kiboPetRegistry: {
      registerToken: () => 'fake-token',
      revokeToken: () => {}
    }
```

- [ ] **Step 6: 写一个新测试,断言 token 铸造/撤销确实发生**

在 `petSession.test.ts` 里(`describe('createPetSession().dispose()', ...)` 这个 describe 块之后)加一个新 describe:

```ts
describe('createPetSession() 的 kibo-pet:// token 生命周期', () => {
  it('构造时铸造 token,dispose() 时撤销', async () => {
    const registerToken = vi.fn(() => 'minted-token-123')
    const revokeToken = vi.fn()
    const deps = { ...makeDeps(), kiboPetRegistry: { registerToken, revokeToken } }
    const session = createPetSession('fake-pet-id', deps)

    expect(registerToken).toHaveBeenCalledTimes(1)
    expect(registerToken).toHaveBeenCalledWith('/fake/pet')
    expect(session.resourceToken).toBe('minted-token-123')

    await session.dispose()
    expect(revokeToken).toHaveBeenCalledWith('minted-token-123')
  })
})
```

（`'/fake/pet'` 对应 `vi.mock('../pets/petHome', ...)` 里 `ensurePetHome` 的假返回值 `{ petHome: '/fake/pet', ... }`,与文件顶部现有 mock 一致。）

- [ ] **Step 7: 跑 petSession 测试**

```bash
pnpm vitest run src/main/shell/petSession.test.ts
```

Expected: 全部通过,包括新增的这个用例。

- [ ] **Step 8: `shell/index.ts` 构造 registry + 安装 handler**

打开 `src/main/shell/index.ts`,在现有 import 区(`import { loadPet, petsDir } from '../petLoader'` 那一行附近)加一行:

```ts
import { createKiboPetProtocolRegistry, installKiboPetProtocolHandler } from '../pets/kiboPetProtocol'
```

在 `export function startShell(): void {` 函数体最开头(第一行代码之前)加:

```ts
export function startShell(): void {
  const kiboPetRegistry = createKiboPetProtocolRegistry()
  installKiboPetProtocolHandler(kiboPetRegistry)
  // ...(原有函数体紧接着,不改动)
```

- [ ] **Step 9: `sessionDeps` 对象字面量补字段**

找到 `voiceDeps: { ... }` 字段结尾的那个 `}`(`sessionDeps` 对象字面量的最后一个顶层字段),在它后面加一个逗号和新字段:

```ts
    voiceDeps: {
      getVoiceRuntimeState,
      getGenieRuntimeState,
      resolveVoiceBackend,
      ports: { gsv: VOICE_PORT, genie: GENIE_VOICE_PORT },
      scriptPaths: { gsv: voiceScriptPath, genie: genieScriptPath },
      spawnGsv: realSpawnProcess,
      spawnGenie: realSpawnGenieProcess,
      postSse: realPostSse,
      onAudioChunk: (c) => petWin.webContents.send(IPC.VOICE_AUDIO_CHUNK, c),
      onAudioError: (m) => petWin.webContents.send(IPC.VOICE_AUDIO_ERROR, m)
    },
    kiboPetRegistry
  }
```

（`kiboPetRegistry` 是 Step 8 在 `startShell()` 函数体最开头声明的那个局部变量,直接引用即可。）

- [ ] **Step 10: `GET_PET` handler 补 `resourceBaseUrl`**

在文件顶部找到:

```ts
import type { PetVoice } from '@shared/petPackage'
```

改成:

```ts
import type { PetVoice, PetRenderSource } from '@shared/petPackage'
```

把:

```ts
  ipcMain.handle(IPC.GET_PET, async () => loadPet(session.petDir))
```

改成:

```ts
  ipcMain.handle(IPC.GET_PET, async (): Promise<PetRenderSource> => {
    const source = await loadPet(session.petDir)
    if (source.type === 'live2d') {
      return { ...source, resourceBaseUrl: `kibo-pet://${session.resourceToken}/` }
    }
    return source
  })
```

- [ ] **Step 11: typecheck + 全量测试**

```bash
pnpm typecheck && pnpm test
```

Expected: 退出码 0,全部测试通过——`GET_PET` handler 现在有了显式的 `Promise<PetRenderSource>` 返回类型标注,且实现真正满足它(live2d 分支带上了 `resourceBaseUrl`)。

- [ ] **Step 12: 确认没有破坏 `kiboPetProtocol.ts` 自身的既有测试**

```bash
pnpm vitest run src/main/pets/kiboPetProtocol.test.ts
```

Expected: 全部通过(这个任务没有改动 `kiboPetProtocol.ts` 本体,只是新增了调用方)。

- [ ] **Step 13: 提交**

```bash
git add src/main/index.ts src/main/shell/petSession.ts src/main/shell/petSession.test.ts src/main/shell/index.ts
git commit -m "feat(live2d): kibo-pet:// 协议接线 + PetSession token 生命周期 + GET_PET 补 resourceBaseUrl"
```

---

### Task 5: 宠物窗口 CSP + Core 脚本标签

**Files:**
- Modify: `src/renderer/index.html`

**Interfaces:**
- Consumes: 无。
- Produces:`index.html` 能同源加载 Cubism Core 脚本、CSP 放行 `kibo-pet:` 资源。

- [ ] **Step 1: CSP + Core 脚本标签**

打开 `src/renderer/index.html`,把:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'self'" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      #pet { -webkit-app-region: no-drag; cursor: grab; display: block; }
    </style>
  </head>
  <body>
    <canvas id="pet"></canvas>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

改成:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: kibo-pet:; script-src 'self'; connect-src 'self' kibo-pet:; media-src 'self' kibo-pet:" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      #pet { -webkit-app-region: no-drag; cursor: grab; display: block; }
    </style>
  </head>
  <body>
    <canvas id="pet"></canvas>
    <script src="./live2dcubismcore.js"></script>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

只改这一个 html 文件——`dialog.html`/`settings.html`/`bubble.html`/`todoPanel.html`/`regionOverlay.html` 的 CSP 保持不变(设计文档 §3.5)。`live2dcubismcore.js` 这个 `<script>` 标签在 `pnpm live2d:setup`(Task 2)还没跑过、文件不存在时,浏览器会对这个 404 的 `<script src>` 报个网络错误,不影响 `main.ts` 的 sprite 渲染路径(sprite 宠物不需要 Cubism Core),只有真正加载 live2d 宠物时才会用到 `window.Live2DCubismCore` 全局对象。

- [ ] **Step 2: 全量测试 + typecheck + build**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: 全部通过/退出码 0。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/index.html
git commit -m "feat(live2d): 宠物窗口 CSP 放行 kibo-pet: + 加载 Cubism Core 脚本"
```

---

### Task 6: `stateMap` 回退解析(纯逻辑)

**Files:**
- Create: `src/renderer/live2dStateMapResolver.ts`
- Create: `src/renderer/live2dStateMapResolver.test.ts`

**Interfaces:**
- Consumes: `Live2DStateMapEntry`(`@shared/petPackage`,已存在)。
- Produces:`resolveStateMotion(stateMap, state, visited?): ResolvedMotion | null`、`nextSequentialIndex(previous): number`,供 Task 9 的 `Live2DPetRenderer.playState()` 使用。

- [ ] **Step 1: 写失败的测试**

```ts
// src/renderer/live2dStateMapResolver.test.ts
import { describe, it, expect } from 'vitest'
import { resolveStateMotion, nextSequentialIndex } from './live2dStateMapResolver'
import type { Live2DStateMapEntry } from '@shared/petPackage'

describe('resolveStateMotion', () => {
  it('命中的状态直接返回其 motionGroup', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'idle')).toEqual({
      motionGroup: 'Idle', selection: 'random', loop: true, expression: undefined, lipSync: undefined
    })
  })

  it('有 motionGroup 的状态直接命中,不走 fallback', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      greet: { motionGroup: 'TapBody', selection: 'random', fallback: 'idle' },
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'greet')?.motionGroup).toBe('TapBody')
  })

  it('状态存在但没有 motionGroup,按 fallback 回退', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      happy: { fallback: 'idle' },
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'happy')?.motionGroup).toBe('Idle')
  })

  it('状态完全不在 stateMap 里,回退到 idle', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'surprised')?.motionGroup).toBe('Idle')
  })

  it('idle 本身也没有映射时返回 null,不抛错', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {}
    expect(resolveStateMotion(stateMap, 'talk')).toBeNull()
  })

  it('fallback 成环时不死循环,最终返回 null', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      a: { fallback: 'b' },
      b: { fallback: 'a' }
    }
    expect(resolveStateMotion(stateMap, 'a')).toBeNull()
  })

  it('selection 为固定索引/expression/lipSync 字段透传', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      talk: { motionGroup: 'Idle', selection: 2, expression: 'smile', lipSync: true }
    }
    expect(resolveStateMotion(stateMap, 'talk')).toEqual({
      motionGroup: 'Idle', selection: 2, loop: undefined, expression: 'smile', lipSync: true
    })
  })
})

describe('nextSequentialIndex', () => {
  it('从 undefined 开始返回 0', () => {
    expect(nextSequentialIndex(undefined)).toBe(0)
  })
  it('每次调用递增 1', () => {
    expect(nextSequentialIndex(0)).toBe(1)
    expect(nextSequentialIndex(4)).toBe(5)
  })
})
```

- [ ] **Step 2: 运行测试,确认失败(模块不存在)**

```bash
pnpm vitest run src/renderer/live2dStateMapResolver.test.ts
```

Expected: FAIL,报 `Cannot find module './live2dStateMapResolver'` 或等价错误。

- [ ] **Step 3: 实现**

```ts
// src/renderer/live2dStateMapResolver.ts
import type { Live2DStateMapEntry } from '@shared/petPackage'

export interface ResolvedMotion {
  motionGroup: string
  selection: 'random' | 'sequential' | number
  loop?: boolean
  expression?: string
  lipSync?: boolean
}

/** 按 stateMap 的声明式 fallback 链解析出一个可播放的动作。schema 保证 fallback 链
 *  最终收敛到 'idle'(见 petPackage.ts 的 Live2DStateMapEntry 注释),这里额外用
 *  visited 集合防御一个手写坏了、真的成环的 pet.json——遇到环直接返回 null,交给
 *  调用方保持当前动画(自然待机),而不是死循环或抛错。 */
export function resolveStateMotion(
  stateMap: Record<string, Live2DStateMapEntry>,
  state: string,
  visited: Set<string> = new Set()
): ResolvedMotion | null {
  if (visited.has(state)) return null
  visited.add(state)
  const entry = stateMap[state]
  if (entry?.motionGroup) {
    return {
      motionGroup: entry.motionGroup,
      selection: entry.selection ?? 'random',
      loop: entry.loop,
      expression: entry.expression,
      lipSync: entry.lipSync
    }
  }
  if (entry?.fallback) return resolveStateMotion(stateMap, entry.fallback, visited)
  if (state !== 'idle') return resolveStateMotion(stateMap, 'idle', visited)
  return null
}

/** stateMap 里 selection:'sequential' 的索引推进——不查询模型真实的动作数量
 *  (Phase 4 范围内没有走引擎 API 查询 Motion Group 大小的需求),超出真实数量时
 *  底层 model.motion() 会自然返回 false,由调用方的失败兜底逻辑处理。 */
export function nextSequentialIndex(previous: number | undefined): number {
  return (previous ?? -1) + 1
}
```

- [ ] **Step 4: 运行测试,确认通过**

```bash
pnpm vitest run src/renderer/live2dStateMapResolver.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/live2dStateMapResolver.ts src/renderer/live2dStateMapResolver.test.ts
git commit -m "feat(live2d): stateMap 回退解析纯逻辑 + 测试"
```

---

### Task 7: hitTest 包围盒兜底(纯逻辑)

**Files:**
- Create: `src/renderer/live2dHitTestFallback.ts`
- Create: `src/renderer/live2dHitTestFallback.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:`pointInBounds(bounds, x, y): boolean`、`toCanvasCoords(canvas, clientX, clientY): { x: number; y: number }`,供 Task 9 的 `hitTest()` 使用。

- [ ] **Step 1: 写失败的测试**

```ts
// src/renderer/live2dHitTestFallback.test.ts
import { describe, it, expect } from 'vitest'
import { pointInBounds } from './live2dHitTestFallback'

describe('pointInBounds', () => {
  const bounds = { x: 10, y: 20, width: 100, height: 50 }

  it('点在包围盒内部返回 true', () => {
    expect(pointInBounds(bounds, 50, 40)).toBe(true)
  })

  it('点在左上角边界上返回 true(含边界)', () => {
    expect(pointInBounds(bounds, 10, 20)).toBe(true)
  })

  it('点在右下角边界上返回 true(含边界)', () => {
    expect(pointInBounds(bounds, 110, 70)).toBe(true)
  })

  it('点在包围盒外部返回 false', () => {
    expect(pointInBounds(bounds, 9, 40)).toBe(false)
    expect(pointInBounds(bounds, 50, 71)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

```bash
pnpm vitest run src/renderer/live2dHitTestFallback.test.ts
```

Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/renderer/live2dHitTestFallback.ts
export interface RectBounds {
  x: number
  y: number
  width: number
  height: number
}

/** model.hitTest() 在没有声明 HitAreas 的模型上返回空数组(spike 已确认这是预期行为,
 *  不是引擎的 bug——见主设计文档 §17.2)。这个函数提供退化路径:落在模型可见包围盒
 *  内就算命中,用于点击穿透判断,不区分具体部位。 */
export function pointInBounds(bounds: RectBounds, x: number, y: number): boolean {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

/** DOM 客户端坐标 → canvas 内部像素坐标,与 SpriteRenderer.isPetPixel() 的换算方式一致
 *  (canvas 的 CSS 尺寸和内部分辨率可能因 DPI 缩放不一致,不能直接拿 clientX/clientY 用)。 */
export function toCanvasCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height)
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

```bash
pnpm vitest run src/renderer/live2dHitTestFallback.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/live2dHitTestFallback.ts src/renderer/live2dHitTestFallback.test.ts
git commit -m "feat(live2d): hitTest 包围盒兜底纯逻辑 + 测试"
```

---

### Task 8: 引擎版本兼容 patch

**Files:**
- Create: `src/renderer/live2dCubismCoreCompat.ts`
- Create: `src/renderer/live2dCubismCoreCompat.test.ts`

**Interfaces:**
- Consumes: 无(纯函数,喂一个形状匹配的假对象即可测试)。
- Produces:`applyCubismCoreCompatPatch(coreModel: unknown): void`,供 Task 9 在 `load()` 里模型加载完成后调用一次。

- [ ] **Step 1: 写失败的测试**

```ts
// src/renderer/live2dCubismCoreCompat.test.ts
import { describe, it, expect } from 'vitest'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'

describe('applyCubismCoreCompatPatch', () => {
  it('drawables.renderOrders 已存在时不做任何事', () => {
    const drawables = { renderOrders: [1, 2, 3] }
    const coreModel = { drawables, getRenderOrders: () => [9, 9, 9] }
    applyCubismCoreCompatPatch(coreModel)
    expect(coreModel.drawables.renderOrders).toEqual([1, 2, 3])
  })

  it('renderOrders 缺失但 getRenderOrders 存在时,打补丁回填', () => {
    const drawables: { renderOrders?: number[] } = {}
    const coreModel = { drawables, getRenderOrders: () => [7, 8, 9] }
    applyCubismCoreCompatPatch(coreModel)
    expect(coreModel.drawables.renderOrders).toEqual([7, 8, 9])
  })

  it('两者都缺失时不崩溃(静默跳过)', () => {
    const coreModel = {}
    expect(() => applyCubismCoreCompatPatch(coreModel)).not.toThrow()
  })

  it('drawables 存在但 getRenderOrders 不是函数时不崩溃', () => {
    const drawables: { renderOrders?: number[] } = {}
    const coreModel = { drawables, getRenderOrders: 'not-a-function' }
    expect(() => applyCubismCoreCompatPatch(coreModel)).not.toThrow()
    expect(coreModel.drawables.renderOrders).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

```bash
pnpm vitest run src/renderer/live2dCubismCoreCompat.test.ts
```

Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/renderer/live2dCubismCoreCompat.ts
/**
 * untitled-pixi-live2d-engine@1.3.5 假设 Cubism Core 的 Model 对象暴露
 * drawables.renderOrders 属性,但官方最新 Cubism Core 5(06.00.0001)把这个字段
 * 设为 private,只能通过 getRenderOrders() 读取——每帧渲染都会因此崩溃(黑屏)。
 * 见主设计文档 §17.2。自我禁用式设计:先探测直接属性是否已经可用,未来引擎或
 * Core 版本修复此问题后自动跳过,不需要跟着版本号手动开关。
 */
export function applyCubismCoreCompatPatch(coreModel: unknown): void {
  const m = coreModel as { drawables?: { renderOrders?: unknown }; getRenderOrders?: unknown }
  if (!m || typeof m !== 'object' || !m.drawables) return
  if (m.drawables.renderOrders !== undefined) return
  if (typeof m.getRenderOrders !== 'function') return
  const getRenderOrders = m.getRenderOrders as () => unknown
  Object.defineProperty(m.drawables, 'renderOrders', { get: () => getRenderOrders() })
}
```

- [ ] **Step 4: 运行测试,确认通过**

```bash
pnpm vitest run src/renderer/live2dCubismCoreCompat.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/live2dCubismCoreCompat.ts src/renderer/live2dCubismCoreCompat.test.ts
git commit -m "feat(live2d): Cubism Core 版本兼容 patch(自我禁用式)+ 测试"
```

---

### Task 9: `Live2DPetRenderer` 完整行为实现

**Files:**
- Modify: `src/renderer/live2dRenderer.ts`(全部方法体)

**Interfaces:**
- Consumes: `resolveStateMotion`/`nextSequentialIndex`(Task 6)、`pointInBounds`/`toCanvasCoords`(Task 7)、`applyCubismCoreCompatPatch`(Task 8)、`PetRenderSource.resourceBaseUrl`(Task 3/4)。
- Produces: 完整实现的 `Live2DPetRenderer`,供 Task 10 的渲染器类型热切换逻辑和真机验证使用。

这个任务没有新的纯逻辑单测(`playState`/`setFacing`/`setLipSync`/`hitTest` 的行为都直接绑定真实 Pixi/引擎对象,和 `SpriteRenderer` 的 `tick()`/`draw()` 一样没有 headless 单测,靠 `pnpm preview` 真机确认)——Task 6/7/8 已经把可测的纯逻辑部分单独测过了,这里只是把它们接起来。

- [ ] **Step 1: 完整重写 `live2dRenderer.ts`**

```ts
// src/renderer/live2dRenderer.ts
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'

const MOTION_PRIORITY_NORMAL = 2 // untitled-pixi-live2d-engine: 0 无优先级/1 IDLE/2 NORMAL/3 FORCE

let pluginRegistered = false

export class Live2DPetRenderer implements PetRenderer {
  private app: Application | null = null
  private model: Live2DModel | null = null
  private manifest: Live2DManifest | null = null
  private sequentialIndexByGroup = new Map<string, number>()
  private baseScale = 1

  constructor(private canvas: HTMLCanvasElement) {}

  async load(source: PetRenderSource): Promise<void> {
    if (source.type !== 'live2d') throw new Error('Live2DPetRenderer 只能加载 type:"live2d" 的 PetRenderSource')
    if (!pluginRegistered) {
      extensions.add(Live2DPlugin)
      pluginRegistered = true
    }
    await this.destroy()

    this.manifest = source.manifest
    this.sequentialIndexByGroup.clear()

    const app = new Application()
    await app.init({ canvas: this.canvas, width: 256, height: 288, preference: 'webgl', autoDensity: true, resolution: window.devicePixelRatio })
    this.app = app

    const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
    const model = await Live2DModel.from(modelUrl)
    applyCubismCoreCompatPatch(model.internalModel.coreModel)

    const t = source.manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    this.baseScale = t.scale
    model.scale.set(this.baseScale)
    model.position.set(app.screen.width / 2 + t.offsetX, app.screen.height / 2 + t.offsetY)
    app.stage.addChild(model)
    this.model = model
  }

  playState(state: PetVisualState): void {
    if (!this.manifest || !this.model) return
    const resolved = resolveStateMotion(this.manifest.render.stateMap, state)
    if (!resolved) return
    void this.playResolved(resolved, state)
  }

  private async playResolved(resolved: ResolvedMotion, originalState: string): Promise<void> {
    if (!this.model || !this.manifest) return
    const ok = await this.startMotion(resolved)
    if (resolved.expression) void this.model.expression(resolved.expression)
    if (!ok && originalState !== 'idle') {
      const idleFallback = resolveStateMotion(this.manifest.render.stateMap, 'idle')
      if (idleFallback) await this.startMotion(idleFallback)
    }
  }

  private async startMotion(resolved: ResolvedMotion): Promise<boolean> {
    if (!this.model) return false
    let index: number | undefined
    if (typeof resolved.selection === 'number') {
      index = resolved.selection
    } else if (resolved.selection === 'sequential') {
      index = nextSequentialIndex(this.sequentialIndexByGroup.get(resolved.motionGroup))
      this.sequentialIndexByGroup.set(resolved.motionGroup, index)
    } else {
      index = undefined // 'random' → 引擎内部 startRandomMotion
    }
    return this.model.motion(resolved.motionGroup, index, MOTION_PRIORITY_NORMAL, { loop: resolved.loop })
  }

  setFacing(direction: 'left' | 'right'): void {
    if (!this.model || !this.manifest) return
    if (!this.manifest.render.interaction.mirrorOnWalk) return
    const magnitude = Math.abs(this.baseScale)
    this.model.scale.x = direction === 'left' ? -magnitude : magnitude
  }

  setLipSync(level: number): void {
    if (!this.model || !this.manifest) return
    const param = this.manifest.render.interaction.lipSyncParameter
    this.model.internalModel.coreModel.setParameterValueById(param, level)
  }

  hitTest(clientX: number, clientY: number): PetHitResult {
    if (!this.model) return { hit: false }
    const { x, y } = toCanvasCoords(this.canvas, clientX, clientY)
    const areas = this.model.hitTest(x, y)
    if (areas.length > 0) return { hit: true, area: areas[0] }
    const b = this.model.getBounds()
    return { hit: pointInBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, x, y) }
  }

  resize(_viewport: PetViewport): void {
    // no-op:与 SpriteRenderer 对齐,Phase 5 才会真正驱动动态窗口尺寸。
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
    if (this.app) {
      if (visible) this.app.ticker.start()
      else this.app.ticker.stop()
    }
  }

  async destroy(): Promise<void> {
    this.model?.destroy()
    this.model = null
    this.manifest = null
    this.sequentialIndexByGroup.clear()
    if (this.app) {
      this.app.destroy(false, { children: true })
      this.app = null
    }
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: 退出码 0。如果 `model.getBounds()`/`model.motion()`/`app.destroy()` 等调用的实参形状和引擎/`pixi.js` 真实 `.d.ts` 有出入,这一步会直接报出具体是哪个签名不对——按报错信息调整(比如 `app.destroy()` 的参数形状、`Bounds` 对象的字段名),不要绕过类型错误。

- [ ] **Step 3: 全量测试**

```bash
pnpm test
```

Expected: 全部通过(这个任务本身没有新增测试文件,靠 Task 6/7/8 已有的纯逻辑测试 + 不引入回归)。

- [ ] **Step 4: build**

```bash
pnpm build
```

Expected: 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/live2dRenderer.ts
git commit -m "feat(live2d): Live2DPetRenderer 完整行为实现(playState/setFacing/setLipSync/hitTest)"
```

---

### Task 10: 渲染器类型热切换(`PetController`/`main.ts`)

**Files:**
- Modify: `src/renderer/petController.ts`
- Modify: `src/renderer/main.ts`
- Create: `src/renderer/petController.test.ts`

**Interfaces:**
- Consumes: `Live2DPetRenderer`(Task 9)、`SpriteRenderer`(已存在)、`PetRenderer`/`PetRenderSource`。
- Produces:`PetController` 构造函数新增两个参数(初始渲染器类型 + 渲染器工厂),新方法 `hitTest(clientX, clientY): PetHitResult`;`reload()` 在渲染器类型变化时销毁旧实例、构造新实例。

设计文档 §6.1 记录的缺口:`reload()` 此前固定复用构造时传入的同一个渲染器实例,`renderReady` 翻转后 sprite↔live2d 热切换会直接抛错。

- [ ] **Step 1: 改 `PetController` 构造函数 + `reload()` + 新增 `hitTest()`**

打开 `src/renderer/petController.ts`,把:

```ts
import type { PetRenderer } from './petRenderer'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
import type { ContextSignalKind } from '@shared/ipc'

const TICK_MS = 33

export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private windowY = 0
  private windowHeight = 288
  private currentAnim = ''
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null
  private pendingContextSignal: ContextSignalKind | null = null

  constructor(private renderer: PetRenderer) {}
```

改成:

```ts
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
import type { ContextSignalKind } from '@shared/ipc'

const TICK_MS = 33

export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private windowY = 0
  private windowHeight = 288
  private currentAnim = ''
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null
  private pendingContextSignal: ContextSignalKind | null = null
  private renderer: PetRenderer
  private rendererType: PetRenderSource['type']

  constructor(
    initialRenderer: PetRenderer,
    initialSourceType: PetRenderSource['type'],
    private readonly createRenderer: (source: PetRenderSource) => PetRenderer
  ) {
    this.renderer = initialRenderer
    this.rendererType = initialSourceType
  }
```

再把:

```ts
  /** 热切换宠物:重新拉取宠物数据,交给渲染器重新加载,大脑复位到 idle。 */
  async reload(): Promise<void> {
    const source = await window.petApi.getPet()
    await this.renderer.load(source)
    this.ctx = initBrain()
    this.currentAnim = ''
  }
```

改成:

```ts
  /** 热切换宠物:重新拉取宠物数据。若新宠物的渲染器类型(sprite/live2d)和当前不一样,
   *  先销毁旧渲染器实例、用工厂按新类型构造一个新实例再替换——不能对着一个类型不匹配的
   *  渲染器直接调 load(),SpriteRenderer/Live2DPetRenderer 的 load() 都会因为类型断言失败
   *  而抛错。类型相同时行为不变,直接复用现有实例。 */
  async reload(): Promise<void> {
    const source = await window.petApi.getPet()
    if (source.type !== this.rendererType) {
      await this.renderer.destroy()
      this.renderer = this.createRenderer(source)
      this.rendererType = source.type
    }
    await this.renderer.load(source)
    this.ctx = initBrain()
    this.currentAnim = ''
  }

  /** 供 main.ts 的鼠标事件处理器查询当前渲染器的命中结果——不能让 main.ts 自己持有一份
   *  渲染器引用,否则 reload() 换实例后 main.ts 手里的引用会变成一个已销毁的旧实例。 */
  hitTest(clientX: number, clientY: number): PetHitResult {
    return this.renderer.hitTest(clientX, clientY)
  }
```

- [ ] **Step 2: `main.ts` 改用 `controller.hitTest()`,构造函数传新参数**

打开 `src/renderer/main.ts`,把:

```ts
async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const source = await window.petApi.getPet()

  const renderer = createRenderer(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer)
  await controller.start()
```

改成:

```ts
async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const source = await window.petApi.getPet()

  const renderer = createRenderer(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer, source.type, (s) => createRenderer(canvas, s))
  await controller.start()
```

再把鼠标移动事件处理器里的:

```ts
    setIgnore(!renderer.hitTest(e.clientX, e.clientY).hit)
```

改成:

```ts
    setIgnore(!controller.hitTest(e.clientX, e.clientY).hit)
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: 退出码 0。

- [ ] **Step 4: 写 `petController.test.ts`,专门测 `reload()` 的类型热切换逻辑**

这个项目里 `PetController`/`SpritePlayer` 此前没有 headless 单测(绘制路径靠 `pnpm preview` 真机确认),但 `reload()` 的类型切换控制流是纯粹的对象/接口调用,不摸真实 canvas/DOM,可以用假的 `PetRenderer` 实现直接测试。测试环境是 Node(`vitest.config.ts` 的 `environment: 'node'`),没有全局 `window`,需要在测试里手动搭一个最小的假 `window.petApi`。

```ts
// src/renderer/petController.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

function makeFakeRenderer(): PetRenderer & { destroyed: boolean; loadedWith: PetRenderSource[] } {
  const loadedWith: PetRenderSource[] = []
  return {
    destroyed: false,
    loadedWith,
    async load(source) { loadedWith.push(source) },
    playState() {},
    setFacing() {},
    setLipSync() {},
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}

const spriteSource: PetRenderSource = { type: 'sprite', manifest: {} as any, spritesheetDataUrl: 'data:x' }
const live2dSource: PetRenderSource = { type: 'live2d', manifest: {} as any, resourceBaseUrl: 'kibo-pet://tok/' }

describe('PetController.reload() 渲染器类型热切换', () => {
  let getPetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getPetMock = vi.fn()
    ;(globalThis as any).window = { petApi: { getPet: getPetMock } }
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('类型不变时复用同一个渲染器实例,不销毁不重建', async () => {
    getPetMock.mockResolvedValue(spriteSource)
    const initial = makeFakeRenderer()
    const factory = vi.fn(() => makeFakeRenderer())
    const controller = new PetController(initial, 'sprite', factory)

    await controller.reload()

    expect(factory).not.toHaveBeenCalled()
    expect(initial.destroyed).toBe(false)
    expect(initial.loadedWith).toEqual([spriteSource])
  })

  it('类型从 sprite 变成 live2d 时销毁旧实例、用工厂构造新实例', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    const replacement = makeFakeRenderer()
    const factory = vi.fn(() => replacement)
    const controller = new PetController(initial, 'sprite', factory)

    await controller.reload()

    expect(initial.destroyed).toBe(true)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(replacement.loadedWith).toEqual([live2dSource])
  })

  it('hitTest() 转发到当前渲染器实例(切换后也转发到新实例,不是旧的)', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    initial.hitTest = () => ({ hit: false })
    const replacement = makeFakeRenderer()
    replacement.hitTest = () => ({ hit: true, area: 'Head' })
    const controller = new PetController(initial, 'sprite', () => replacement)

    expect(controller.hitTest(1, 2)).toEqual({ hit: false })
    await controller.reload()
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })
})
```

- [ ] **Step 5: 运行新测试**

```bash
pnpm vitest run src/renderer/petController.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 全量测试 + typecheck + build**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/petController.ts src/renderer/main.ts src/renderer/petController.test.ts
git commit -m "fix(live2d): PetController.reload() 支持渲染器类型热切换(sprite↔live2d)"
```

---

### Task 11: `renderReady` 翻转

**Files:**
- Modify: `src/main/pets/petCatalog.ts`
- Modify: `src/main/pets/petCatalog.test.ts`
- Modify: `src/main/pets/resolveEffectivePetHome.test.ts`

**Interfaces:**
- Consumes: 无新接口——纯粹是把两处硬编码的字面量从 `false` 改成 `true`。
- Produces:`PetSummary.renderReady` 对 live2d 包始终为 `true`,`switchPet()`/寄养选择器/设置下拉框的现有 `renderReady` 判断逻辑不用改就能生效(它们读的是这个字段的值,不需要知道字段是怎么算出来的)。

- [ ] **Step 1: 翻转 `petCatalog.ts` 的两处硬编码**

打开 `src/main/pets/petCatalog.ts`,把 `readSummary()` 里的:

```ts
    if (isLive2DManifestRaw(raw)) {
      const manifest = parseLive2DManifest(raw)
      return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: false }
    }
```

改成:

```ts
    if (isLive2DManifestRaw(raw)) {
      const manifest = parseLive2DManifest(raw)
      return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: true }
    }
```

把 `importLive2DPet()` 末尾的:

```ts
  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: false },
    ...(warnings.length > 0 ? { warnings } : {})
  }
```

改成:

```ts
  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: true },
    ...(warnings.length > 0 ? { warnings } : {})
  }
```

- [ ] **Step 2: 更新 `petCatalog.test.ts` 的两处断言**

把:

```ts
  it('live2d 包 renderType=live2d, renderReady=false', () => {
    const bundled = scratch(); const user = scratch()
    makeLive2DPet(user, 'chitose', '千岁')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
  })
```

改成:

```ts
  it('live2d 包 renderType=live2d, renderReady=true(Phase 4 起 live2d 渲染器已就绪)', () => {
    const bundled = scratch(); const user = scratch()
    makeLive2DPet(user, 'chitose', '千岁')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: true })
  })
```

把:

```ts
  it('live2d 包:合法输入 → 成功导入,renderType=live2d/renderReady=false', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
    expect(existsSync(join(user, 'chitose', 'model', 'character.model3.json'))).toBe(true)
  })
```

改成:

```ts
  it('live2d 包:合法输入 → 成功导入,renderType=live2d/renderReady=true', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: true })
    expect(existsSync(join(user, 'chitose', 'model', 'character.model3.json'))).toBe(true)
  })
```

- [ ] **Step 3: 更新 `resolveEffectivePetHome.test.ts` 的两个受影响用例**

打开 `src/main/pets/resolveEffectivePetHome.test.ts`,把:

```ts
  it('配置的宠物是 live2d(renderReady:false)→ 回退默认 sprite 宠物,不当场启动', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    makeSpritePet(bundledPetsDir, 'luluka')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'luluka', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('luluka')
  })

  it('配置的宠物就是默认宠物且是 live2d(不应发生的极端情况)→ 没有二次回退目标,原样放行', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'chitose', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('chitose')
  })
```

改成:

```ts
  it('配置的宠物是 live2d 且 renderReady:true(Phase 4 起)→ 直接用配置的 id,不回退', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    makeSpritePet(bundledPetsDir, 'luluka')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'luluka', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('chitose')
  })

  it('配置的宠物就是默认宠物且是 live2d → 正常 ready,用配置的 id', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'chitose', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('chitose')
  })
```

（`resolveEffectivePetHome.ts` 本体的 `!summary.renderReady` 回退守卫逻辑不用删——它现在对 live2d 恒为假条件不成立,是良性的死代码,保留这个机制是为了不排除未来重新出现"renderReady:false"场景的可能性,例如更深层的模型校验失败,不是当前任务的臆造需求,而是 Phase 2/3 已经建好、可以直接复用的基础设施。`switchPet()`(`shell/index.ts`)对 `renderReady` 的判断没有独立单测覆盖——它读的是同一个 `PetSummary.renderReady` 字段,这里的翻转已经间接验证了它的行为会跟着变化,不需要额外新建 Electron 重度 mock 的测试基础设施。）

- [ ] **Step 4: 全量测试 + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts src/main/pets/resolveEffectivePetHome.test.ts
git commit -m "feat(live2d): renderReady 翻转为真实可用状态,live2d 宠物可启动/可热切换"
```

---

### Task 12: 真机验证清单 + 收尾文档

**Files:**
- Create: `docs/superpowers/plans/notes/2026-07-21-live2d-phase4-realmachine-checklist.md`
- Modify: `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md`

**Interfaces:**
- Consumes: 无代码产物,是本计划的收尾/交接任务(与 `2026-07-20-live2d-phase4-prespike.md` Task 6 同样的收尾模式)。
- Produces: 交给用户在真机上按清单逐条验证的文档。

- [ ] **Step 1: 写真机验证清单**

```markdown
# Live2D Phase 4 真机验证清单

代码/自动化部分已完成(`pnpm typecheck && pnpm test && pnpm build` 全绿),以下必须真机人工验证,agent 会话无法自动化(无 GPU/无显示器)。

## 准备

1. 跑一次 `pnpm live2d:setup`,确认成功产出 `vendor/live2d-core/live2dcubismcore.js` 和 `src/renderer/public/live2dcubismcore.js`。
2. 通过应用内"导入 Live2D 模型"UI,把 `D:\LProject\claude_Project\live2dModel\白-免费版\` 和 `D:\LProject\claude_Project\live2dModel\茕兔pack\茕兔\` 分别导入成两个 `pets/<id>/` 包(茕兔pack 导入时应该会触发游离表情/动作找回提示——这条路径 Phase 2 已验证过,这里只是确认走一遍导入 UI 没有回归)。
3. `pnpm preview` 启动应用。

## 验证项

- [ ] 两个 live2d 宠物在寄养选择器/设置下拉框里从"置灰禁用"变成可正常选中(`renderReady` 翻转生效)。
- [ ] 把 `settings.json` 的 `activePetId` 手动改成其中一个 live2d 宠物的 id 后重启应用,能正常启动并渲染(不回退到默认 sprite 宠物)。
- [ ] 从默认 sprite 宠物(luluka)热切换到 live2d 宠物:能看到模型正常渲染(不黑屏、不花屏),接受切换瞬间的一次可见闪烁(这是本阶段确认接受的已知缺口,不是 bug)。
- [ ] 从 live2d 宠物热切换回 sprite 宠物:同样能正常切回,不抛错(验证 Task 10 的类型热切换修复)。
- [ ] 从一个 live2d 宠物热切换到另一个 live2d 宠物。
- [ ] 点击穿透:模型像素上不穿透、透明区域穿透。
- [ ] 拖拽移动窗口时模型跟手,行走状态左右镜像观感正确(`setFacing`)。
- [ ] 双击/单击等既有交互(戳、开对话框)在 live2d 宠物上行为和 sprite 宠物一致。
- [ ] 打开开发者工具(如果需要临时加回 `webPreferences.devTools`,验证完记得改回去)检查 console,确认版本兼容 patch 生效、没有 `drawables.renderOrders` 相关的报错或黑屏。
- [ ] 检查 CSP 没有拦截 `kibo-pet://` 资源或 `live2dcubismcore.js` 脚本加载(console 里不应该出现 CSP violation 报错)。
- [ ] `pnpm dist` 打包一次,确认打包产物里没有意外带上 `node_modules/pixi.js`/`node_modules/untitled-pixi-live2d-engine`(它们应该已经被 Vite 完整打进 `out/renderer` 的 bundle,`devDependencies` 声明不会被 electron-builder 打进最终 `node_modules`)。

## 反馈

把每一项的结果(通过/不通过 + 具体现象)发回来,不通过的项目附上 console 报错和肉眼观察到的现象(黑屏/花屏/卡顿/贴图错位等)。
```

- [ ] **Step 2: 更新 `remaining-work.md`**

打开 `docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md`,把总览表格里:

```
| Phase 4:PixiJS/Live2D 最小加载 | **下一步**,本体未开始;前置真实模型加载 spike 已完成并真机验证,结论见 spec §17 |
```

改成:

```
| Phase 4:PixiJS/Live2D 最小加载 | **代码+测试完成,真机验证待用户**(清单见 `docs/superpowers/plans/notes/2026-07-21-live2d-phase4-realmachine-checklist.md`) |
```

在"下一步建议"那一节末尾追加一条:

```
7. Phase 4(PixiJS/Live2D 最小加载)代码完成,真机验证清单见上。验证通过后,针对 **Phase 5(动态窗口/锚点/命中/无闪烁热切换)** 走 brainstorming → writing-plans 流程。
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/notes/2026-07-21-live2d-phase4-realmachine-checklist.md docs/superpowers/plans/notes/2026-07-20-live2d-remaining-work.md
git commit -m "docs(live2d): Phase 4 真机验证清单 + 更新剩余任务清单进度"
```

---

## 计划范围边界

本计划到 Task 12 为止,产出的是"代码完整、测试全绿、typecheck/build 通过"的 Phase 4。**真机验证(实际渲染效果、CSP 是否真的放行、Cubism Core 下载是否真的能跑通、打包体积)完全不在本计划的自动化范围内**,交给用户按 Task 12 的清单执行。Phase 5(动态窗口/锚点/无闪烁热切换)不在本计划范围,不要在执行过程中顺手做。
