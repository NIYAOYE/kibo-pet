import { SpritePlayer } from './spritePlayer'
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

  constructor(private player: SpritePlayer) {}

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
    // 久坐提醒命中且宠物在睡：同一 tick 内强制叫醒，避免下一 tick 的 wokeUp 派生
    // 把更具体的 break 台词覆盖成通用 wake 台词（见设计文档 §7 时序陷阱）。
    if (contextSignal === 'break_reminder' && this.ctx.state === 'sleep') event = 'wake'

    const prevState = this.ctx.state
    const { ctx, effects } = step(this.ctx, {
      dtMs,
      event,
      bounds: this.workArea,
      windowX: this.windowX,
      windowWidth: this.windowWidth,
      windowY: this.windowY,
      windowHeight: this.windowHeight,
      rng: Math.random
    })
    this.ctx = ctx
    if (effects.animation !== this.currentAnim) {
      // Re-sync the predicted windowX from the true OS position at each walk
      // start, so drift accumulated over the session doesn't skew edge-clamping.
      const startedWalking = effects.animation.startsWith('walk') && !this.currentAnim.startsWith('walk')
      this.player.play(effects.animation)
      this.currentAnim = effects.animation
      if (startedWalking) void this.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    }
    if (effects.moveX !== 0 || effects.moveY !== 0) {
      // clamp:true — autonomous walk stays on-screen (main enforces the edge).
      this.windowX += effects.moveX // optimistic; corrected below once main replies
      this.windowY += effects.moveY
      void window.petApi.moveWindow({ dx: effects.moveX, dy: effects.moveY, clamp: true }).then((result) => {
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
    const wokeUp = prevState === 'sleep' && this.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined =
      contextSignal ?? (wokeUp ? 'wake' : (this.pendingReaction ?? undefined))
    this.pendingReaction = null
    const sleeping = this.ctx.state === 'sleep'
    const r = stepReaction(this.reactionCtx, {
      dtMs,
      trigger,
      pausedByDialog: this.ctx.paused,
      sleeping,
      nowMs: Date.now(),
      rng: Math.random
    })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
}
