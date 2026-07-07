import { SpritePlayer } from './spritePlayer'
import { initBrain, step, type PetBrainCtx, type PetEvent, type Bounds } from '@shared/petBrain'
import { initReaction, stepReaction, type ReactionCtx, type ReactionTrigger } from '@shared/reactionPlanner'

const TICK_MS = 33

export class PetController {
  private ctx: PetBrainCtx = initBrain()
  private lastTs = 0
  private timer: number | null = null
  private pending: PetEvent[] = []
  private workArea: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  private windowX = 0
  private windowWidth = 256
  private currentAnim = ''
  private reactionCtx: ReactionCtx = initReaction()
  private pendingReaction: ReactionTrigger | null = null

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

  async syncBounds(): Promise<void> {
    const b = await window.petApi.getWindowBounds()
    this.workArea = b.workArea
    this.windowX = b.window.x
    this.windowWidth = b.window.width
  }

  private tick(): void {
    const now = performance.now()
    const dtMs = now - this.lastTs
    this.lastTs = now
    const event = this.pending.shift()
    if (event === 'pickup') this.pendingReaction = 'drag' // 拖起 → drag 台词
    const prevState = this.ctx.state
    const { ctx, effects } = step(this.ctx, {
      dtMs,
      event,
      bounds: this.workArea,
      windowX: this.windowX,
      windowWidth: this.windowWidth,
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
    if (effects.move !== 0) {
      // clamp:true — autonomous walk stays on-screen (main enforces the edge).
      window.petApi.moveWindow({ dx: effects.move, dy: 0, clamp: true })
      this.windowX += effects.move
    }

    // 反应规划器:每 tick 一个触发,睡→醒(wake)优先于本 tick 的触碰
    const wokeUp = prevState === 'sleep' && this.ctx.state !== 'sleep'
    const trigger: ReactionTrigger | undefined = wokeUp ? 'wake' : (this.pendingReaction ?? undefined)
    this.pendingReaction = null
    // 真正仍在睡眠中(非本 tick 刚醒)时闭嘴:this.ctx.state 已是 step() 之后的状态,
    // wokeUp 的那一 tick state 已不是 'sleep',故 wake 台词不受此抑制。
    const sleeping = this.ctx.state === 'sleep'
    const r = stepReaction(this.reactionCtx, { dtMs, trigger, paused: this.ctx.paused || sleeping, rng: Math.random })
    this.reactionCtx = r.ctx
    if (r.output.speak) window.petApi.petSpeak(r.output.speak)
  }
}
