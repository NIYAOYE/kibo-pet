// 副作用 import:pixi.js 的 WebGLRenderer 构造时会探测 eval 能力,在本项目严格 CSP
// (script-src 'self',无 unsafe-eval)下会直接抛错。这个模块名叫 unsafe-eval,实际做的是
// 相反的事——打上 CSP 安全的多边形填充/uniform 同步 polyfill,禁用那个探测,不需要放宽 CSP。
import 'pixi.js/unsafe-eval'
import { Application, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism'
import type { PetRenderSource, Live2DManifest } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'
import { resolveStateMotion, nextSequentialIndex, type ResolvedMotion } from './live2dStateMapResolver'
import { pointInBounds, toCanvasCoords } from './live2dHitTestFallback'
import { applyCubismCoreCompatPatch } from './live2dCubismCoreCompat'
import { needsAutoFit, pickWatermarkBreakExpressionName, type ExpressionDefinition } from './live2dAutoSetup'
import { clampLive2DViewport } from '@shared/windowPlacement'
import { fpsForState } from './live2dFps'

const MOTION_PRIORITY_NORMAL = 2 // untitled-pixi-live2d-engine: 0 无优先级/1 IDLE/2 NORMAL/3 FORCE

let pluginRegistered = false

/** live2d 渲染器:实现 Phase 3 定义的 PetRenderer 接口,驱动真实的
 *  untitled-pixi-live2d-engine + pixi.js 模型加载/播放。 */
export class Live2DPetRenderer implements PetRenderer {
  private app: Application | null = null
  private model: Live2DModel | null = null
  private manifest: Live2DManifest | null = null
  private sequentialIndexByGroup = new Map<string, number>()
  private baseScale = 1
  private pendingModel: Live2DModel | null = null
  private pendingManifest: Live2DManifest | null = null
  private pendingViewport: { width: number; height: number } | null = null
  private pendingBaseScale: number | null = null
  private pendingFit: { scale: number; offsetX: number; offsetY: number } | null = null

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
    const viewport = clampLive2DViewport(source.manifest.render.viewport)
    let model: Live2DModel
    try {
      // backgroundAlpha 默认是 1(不透明黑底)——不传的话画布会盖住模型,真机验证时复现过。
      const resolution = Math.min(window.devicePixelRatio, source.manifest.render.viewport.resolutionCap)
      await app.init({ canvas: this.canvas, width: viewport.width, height: viewport.height, preference: 'webgl', autoDensity: true, resolution, backgroundAlpha: 0 })
      const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
      model = await Live2DModel.from(modelUrl)
    } catch (err) {
      try {
        app.destroy(false, { children: true })
      } catch {
        // app.init() 可能在 Pixi 内部插件(如 ResizePlugin)完成初始化前就抛出了
        // (例如 canvas 已被 SpriteRenderer 用 getContext('2d') 占用,'webgl' 请求返回
        // null),此时 destroy() 内部插件清理会因状态未就绪而二次抛错。这是次生错误,
        // 不是真正原因,吞掉它以确保下面 throw 的是 app.init()/Live2DModel.from()
        // 的原始错误。
      }
      throw err
    }
    this.app = app

    const { baseScale, fit } = await this.setupModel(model, source.manifest, viewport)
    this.baseScale = baseScale
    // 注:跨类型热切换(如 sprite→live2d)时,load() 在准备阶段就可能触发这里的自动对齐持久化,
    // 而此时主进程 session 还指向旧的精灵包——写入会被 patchLive2DTransform 拒绝(manifest 类型不符),
    // 不会写坏数据,但这次切换的自动对齐结果不会被保存,下次冷启动会重新算一遍。这是已知的良性
    // 不对称(与同类型 Live2D→Live2D 路径把持久化推迟到 commitSwap() 不同),不是 bug。
    if (fit) void window.petApi.updateLive2DTransform({ ...fit, autoFitted: true })
    app.stage.addChild(model)
    this.model = model

    // 高级故障排查用:把 app/model 挂到 window 上,方便在 DevTools Console 里直接读写
    // scale/position/visible 等属性做实时诊断。正常情况下导入后会自动完成对齐(见上面
    // needsAutoFit 分支),这个挂钩只在需要人工核对细节或覆盖自动计算结果(比如某个疑难
    // 模型自动算出来的比例仍不满意)时才用得上,不是主流程的一部分。
    let lastFit: { scale: number; offsetX: number; offsetY: number } | null = null
    ;(window as unknown as { __kiboLive2D?: unknown }).__kiboLive2D = {
      app,
      model,
      canvas: this.canvas,
      autoFit: (marginPx?: number) => {
        lastFit = this.autoFit(this.model!, { width: this.app!.screen.width, height: this.app!.screen.height }, marginPx)
        if (lastFit) this.baseScale = lastFit.scale
        return lastFit
      },
      saveFit: async () => {
        if (!lastFit) return { ok: false, message: '还没调用过 autoFit(),没有可保存的数值' }
        return window.petApi.updateLive2DTransform({ ...lastFit, autoFitted: true })
      }
    }
  }

  /** load()/prepareSwap() 共用的模型初始化:挂 anchor/scale/position、首次自动对齐、
   *  水印破冰兜底。不区分调用方是"首次加载"还是"热切换准备",只依赖传入的 model/manifest/viewport。
   *  不直接写共享的 this.baseScale,也不直接持久化 autoFit() 的结果——两者都原样返回给
   *  调用方,由调用方自行决定写到哪个字段、以及何时(甚至是否)通过 IPC 落盘。这是因为
   *  prepareSwap() 调用本方法时,main 进程的 session.petDir 仍指向"当前仍在显示的旧宠物"
   *  (按 Task 13 的时序,main 要等 renderer 报告 prepare 成功后才会把 session 切到新宠物),
   *  如果在这里直接 fire-and-forget 持久化,新宠物的自动对齐结果会被写进旧宠物的 pet.json。 */
  private async setupModel(
    model: Live2DModel,
    manifest: Live2DManifest,
    viewport: { width: number; height: number }
  ): Promise<{ baseScale: number; fit: { scale: number; offsetX: number; offsetY: number } | null }> {
    applyCubismCoreCompatPatch(model.internalModel.coreModel)

    const t = manifest.render.transform
    model.anchor.set(t.anchorX, t.anchorY)
    let baseScale = t.scale
    model.scale.set(baseScale)
    model.position.set(viewport.width / 2 + t.offsetX, viewport.height / 2 + t.offsetY)

    // 首次自动对齐:autoFit() 内部的 scale.set/position.set 是同步调用,发生在这一帧
    // 渲染之前,不会出现"先显示错误比例再纠正"的闪烁。是否/何时把结果写回 pet.json 交给
    // 调用方决定(见上面方法注释)。
    let fit: { scale: number; offsetX: number; offsetY: number } | null = null
    if (needsAutoFit(t)) {
      fit = this.autoFit(model, viewport)
      if (fit) baseScale = fit.scale
    }

    // 水印/游离资源找回后仍卡在初始姿势的通用兜底:参见 live2dAutoSetup.ts 的判断逻辑注释。
    const expressionManager = model.internalModel.motionManager.expressionManager as
      | { definitions?: ExpressionDefinition[] }
      | undefined
    const watermarkExpression = pickWatermarkBreakExpressionName(manifest, expressionManager?.definitions)
    if (watermarkExpression) void model.expression(watermarkExpression)

    return { baseScale, fit }
  }

  /** 测量模型在当前 scale 下的真实渲染尺寸,算出一个能让模型完整显示在给定 viewport 里
   *  (留 marginPx 边距)的 scale,连同"脚底贴着画布底部"的 offsetX/offsetY 一起现场应用并
   *  返回——只覆盖这三个字段,不碰 anchorX/anchorY 等宠物包作者自定的锚点语义。不写共享的
   *  this.baseScale(由调用方决定是否/写到哪个字段,见 setupModel() 的注释)。两个调用方:
   *  setupModel() 的自动对齐,以及 window.__kiboLive2D 调试挂钩的人工核对/覆盖。 */
  private autoFit(
    model: Live2DModel,
    viewport: { width: number; height: number },
    marginPx = 8
  ): { scale: number; offsetX: number; offsetY: number } | null {
    const currentScale = model.scale.x || 1
    const naturalWidth = model.width / currentScale
    const naturalHeight = model.height / currentScale
    const targetWidth = viewport.width - marginPx * 2
    const targetHeight = viewport.height - marginPx * 2
    const scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
    // model.width/height 理论上应该在 Live2DModel.from() resolve 后就已经就绪,但这是
    // setupModel() 里第一次在渲染前同步调用 autoFit(),留一道防线:测出来的 scale 不是有限数字时
    // (比如冷启动 bounds 还没就绪导致除以 0)跳过应用,保留 manifest 里已有的 scale/位置,
    // 不让第一帧画面被 Infinity 缩放毁掉——调用方对 null 的处理本来就是"跳过这次自动对齐"。
    if (!Number.isFinite(scale)) return null
    model.scale.set(scale)
    const positionX = viewport.width / 2
    const positionY = viewport.height - marginPx
    model.position.set(positionX, positionY)
    return {
      scale,
      offsetX: positionX - viewport.width / 2,
      offsetY: positionY - viewport.height / 2
    }
  }

  playState(state: PetVisualState): void {
    if (!this.manifest || !this.model) return
    if (this.app) this.app.ticker.maxFPS = fpsForState(state)
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
    const coreModel = this.model.internalModel.coreModel as {
      getParameterCount(): number
      getParameterId(index: number): { isEqual(id: string): boolean }
      setParameterValueByIndex(index: number, value: number, weight?: number): void
    }
    const count = coreModel.getParameterCount()
    for (let i = 0; i < count; i++) {
      if (coreModel.getParameterId(i).isEqual(param)) {
        coreModel.setParameterValueByIndex(i, level)
        return
      }
    }
  }

  setLookTarget(x: number, y: number): void {
    this.model?.focus(x, y)
  }

  hitTest(clientX: number, clientY: number): PetHitResult {
    if (!this.model) return { hit: false }
    const { x, y } = toCanvasCoords(this.canvas, clientX, clientY)
    const areas = this.model.hitTest(x, y)
    if (areas.length > 0) return { hit: true, area: areas[0] }
    const b = this.model.getBounds()
    return { hit: pointInBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, x, y) }
  }

  resize(viewport: PetViewport): void {
    if (!this.app) return
    this.app.renderer.resize(viewport.width, viewport.height)
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
    if (this.app) {
      if (visible) this.app.ticker.start()
      else this.app.ticker.stop()
    }
  }

  async prepareSwap(source: PetRenderSource): Promise<void> {
    if (source.type !== 'live2d') throw new Error('Live2DPetRenderer.prepareSwap() 只能准备 type:"live2d" 的 PetRenderSource')
    if (!this.app) throw new Error('prepareSwap() 前必须先成功调用过一次 load()')
    const viewport = clampLive2DViewport(source.manifest.render.viewport)
    const modelUrl = `${source.resourceBaseUrl}${source.manifest.render.model}`
    const model = await Live2DModel.from(modelUrl)
    const { baseScale: pendingBaseScale, fit } = await this.setupModel(model, source.manifest, viewport)
    this.pendingModel = model
    this.pendingManifest = source.manifest
    this.pendingViewport = viewport
    this.pendingBaseScale = pendingBaseScale
    this.pendingFit = fit
  }

  commitSwap(): void {
    if (!this.pendingModel || !this.pendingManifest || !this.pendingViewport || !this.app) {
      throw new Error('commitSwap() 前必须先成功调用 prepareSwap()')
    }
    this.model?.destroy()
    this.resize(this.pendingViewport)
    this.app.stage.addChild(this.pendingModel)
    this.model = this.pendingModel
    this.manifest = this.pendingManifest
    this.baseScale = this.pendingBaseScale!
    // 只有走到这里(commit 已完成)才持久化:main 进程按 Task 13 的协议,只有在收到
    // renderer 的 prepare 成功结果后才会把 session 切到这个新宠物,再发 PET_COMMIT——
    // 所以此时 main 的 session.petDir 已经指向这个新宠物,IPC 写入落盘的位置是对的。
    if (this.pendingFit) void window.petApi.updateLive2DTransform({ ...this.pendingFit, autoFitted: true })
    this.sequentialIndexByGroup.clear()
    this.pendingModel = null
    this.pendingManifest = null
    this.pendingViewport = null
    this.pendingBaseScale = null
    this.pendingFit = null
  }

  discardSwap(): void {
    this.pendingModel?.destroy()
    this.pendingModel = null
    this.pendingManifest = null
    this.pendingViewport = null
    this.pendingBaseScale = null
    this.pendingFit = null
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
