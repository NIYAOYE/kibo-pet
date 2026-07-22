import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initLive2DBrain, stepLive2D, type Live2DBrainCtx } from '@shared/live2dPetBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'
import type { ContextSignalKind } from '@shared/ipc'

const TICK_MS = 33

type BehaviorState =
  | { kind: 'sprite'; ctx: PetBrainCtx }
  | { kind: 'live2d'; ctx: Live2DBrainCtx }

function initBehaviorFor(type: PetRenderSource['type']): BehaviorState {
  return type === 'live2d' ? { kind: 'live2d', ctx: initLive2DBrain() } : { kind: 'sprite', ctx: initBrain() }
}

export class PetController {
  private behavior: BehaviorState
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
  private pendingRenderer: PetRenderer | null = null
  private pendingRendererType: PetRenderSource['type'] | null = null
  private pendingAttach: (() => void) | null = null

  constructor(
    initialRenderer: PetRenderer,
    initialType: PetRenderSource['type'],
    private readonly createRenderer: (source: PetRenderSource) => { renderer: PetRenderer; attach: () => void }
  ) {
    this.renderer = initialRenderer
    this.rendererType = initialType
    this.behavior = initBehaviorFor(initialType)
  }

  async start(): Promise<void> {
    try {
      await this.syncBounds()
    } catch (err) {
      console.warn('initial syncBounds failed; using default bounds', err)
    }
    this.lastTs = performance.now()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
  }

  /** 热切换准备阶段:同类型走 renderer.prepareSwap(),旧模型/canvas 全程不受影响;
   *  跨类型新建一个 detached 的渲染器实例(canvas 尚未接入 DOM)并 load(),失败则立即
   *  销毁新实例。两种情况下都不修改 this.renderer/this.rendererType,真正切换发生在
   *  commitReload()。见 Phase 5 设计文档 §1。 */
  async prepareReload(source: PetRenderSource): Promise<void> {
    if (source.type === this.rendererType) {
      await this.renderer.prepareSwap(source)
      return
    }
    const { renderer, attach } = this.createRenderer(source)
    try {
      await renderer.load(source)
    } catch (err) {
      await renderer.destroy()
      throw err
    }
    this.pendingRenderer = renderer
    this.pendingRendererType = source.type
    this.pendingAttach = attach
  }

  /** 原子提交 prepareReload() 准备好的内容。跨类型时把 pendingRenderer 接入 DOM、销毁旧实例;
   *  同类型时转发给 renderer.commitSwap()。 */
  commitReload(): void {
    if (this.pendingRenderer && this.pendingAttach && this.pendingRendererType) {
      const oldRenderer = this.renderer
      this.pendingAttach()
      void oldRenderer.destroy()
      this.renderer = this.pendingRenderer
      this.rendererType = this.pendingRendererType
      this.pendingRenderer = null
      this.pendingRendererType = null
      this.pendingAttach = null
      this.behavior = initBehaviorFor(this.rendererType)
      this.currentAnim = ''
      return
    }
    this.renderer.commitSwap()
    this.behavior = initBehaviorFor(this.rendererType)
    this.currentAnim = ''
  }

  /** 丢弃 prepareReload() 准备好但未提交的半成品,当前可见渲染器/画面不受影响。 */
  discardReload(): void {
    if (this.pendingRenderer) {
      void this.pendingRenderer.destroy()
      this.pendingRenderer = null
      this.pendingRendererType = null
      this.pendingAttach = null
      return
    }
    this.renderer.discardSwap()
  }

  setVisible(visible: boolean): void {
    this.renderer.setVisible(visible)
  }

  /** 供 main.ts 的鼠标事件处理器查询当前渲染器的命中结果——不能让 main.ts 自己持有一份
   *  渲染器引用,否则 commitReload() 换实例后 main.ts 手里的引用会变成一个已销毁的旧实例。 */
  hitTest(clientX: number, clientY: number): PetHitResult {
    return this.renderer.hitTest(clientX, clientY)
  }

  setLipSync(level: number): void {
    this.renderer.setLipSync(level)
  }

  /** 主进程推来的鼠标追踪目标:非睡眠状态原样转发;睡眠时强制回正,不使用传入目标——
   *  是否在睡眠这件事只有渲染进程的行为状态机知道,主进程算不出来。 */
  setMouseFocus(x: number, y: number): void {
    if (this.behavior.kind === 'live2d' && this.behavior.ctx.state === 'sleep') {
      this.renderer.setLookTarget(0, 0)
      return
    }
    this.renderer.setLookTarget(x, y)
  }

  send(event: PetEvent): void { this.pending.push(event) }

  /** 双击=戳：下一 tick 喂给反应规划器 */
  poke(): void { this.pendingReaction = 'poke' }

  /** 主进程情境信号(AFK 离开/久坐提醒)：下一 tick 消费 */
  receiveContextSignal(kind: ContextSignalKind): void { this.pendingContextSignal = kind }

  async syncBounds(): Promise<void> {
    const b = await window.petApi.getWindowBounds()
    this.workArea = b.workArea
    this.windowX = b.window.x
    this.windowWidth = b.window.width
    this.windowY = b.window.y
    this.windowHeight = b.window.height
  }

  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now

    const contextSignal = this.pendingContextSignal
    this.pendingContextSignal = null

    let event = this.pending.shift()
    if (event === 'pickup') this.pendingReaction = 'drag' // 拖起 → drag 台词
    // 久坐提醒/应用焦点感知命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的
    // wokeUp 派生把更具体的台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if ((contextSignal === 'break_reminder' || contextSignal === 'app_focus') && this.behavior.ctx.state === 'sleep') event = 'wake'

    const prevState = this.behavior.ctx.state
    let animation: string
    let moveX = 0
    let moveY = 0
    if (this.behavior.kind === 'sprite') {
      const { ctx, effects } = step(this.behavior.ctx, {
        dtMs,
        event,
        bounds: this.workArea,
        windowX: this.windowX,
        windowWidth: this.windowWidth,
        windowY: this.windowY,
        windowHeight: this.windowHeight,
        rng: Math.random
      })
      this.behavior = { kind: 'sprite', ctx }
      animation = effects.animation
      moveX = effects.moveX
      moveY = effects.moveY
    } else {
      const { ctx, effects } = stepLive2D(this.behavior.ctx, { dtMs, event, rng: Math.random })
      this.behavior = { kind: 'live2d', ctx }
      animation = effects.animation
    }

    if (animation !== this.currentAnim) {
      // Re-sync the predicted windowX from the true OS position at each walk
      // start, so drift accumulated over the session doesn't skew edge-clamping.
      const startedWalking = animation.startsWith('walk') && !this.currentAnim.startsWith('walk')
      this.renderer.playState(animation)
      this.currentAnim = animation
      if (startedWalking) void this.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    }
    if (moveX !== 0 || moveY !== 0) {
      // clamp:true — autonomous walk stays on-screen (main enforces the edge).
      this.windowX += moveX // optimistic; corrected below once main replies
      this.windowY += moveY
      void window.petApi.moveWindow({ dx: moveX, dy: moveY, clamp: true }).then((result) => {
        if (!result) return
        // Main is authoritative (it clamps against the live, per-tick display
        // work area). Re-sync every tick — not just at walk-start — so a
        // boundary the renderer didn't know about (e.g. a neighboring monitor
        // with a different work area) is caught within one tick instead of
        // silently drifting for the rest of the walk.
        this.windowX = result.window.x
        this.windowY = result.window.y
        this.workArea = result.workArea
        this.windowWidth = result.window.width
        this.windowHeight = result.window.height
      })
    }

    // 反应规划器:每 tick 一个触发。优先级:主进程情境信号 > 睡→醒(wake)派生 > 手势触发(poke/drag)。
    const wokeUp = prevState === 'sleep' && this.behavior.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined =
      contextSignal ?? (wokeUp ? 'wake' : (this.pendingReaction ?? undefined))
    this.pendingReaction = null
    const sleeping = this.behavior.ctx.state === 'sleep'
    const r = stepReaction(this.reactionCtx, {
      dtMs,
      trigger,
      pausedByDialog: this.behavior.ctx.paused,
      sleeping,
      nowMs: Date.now(),
      rng: Math.random
    })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
}
