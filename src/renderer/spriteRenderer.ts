import { frameRect, frameDurationMs, type PetManifest, type PetAnimation, type PetRenderSource } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'

export function nextFrameIndex(current: number, frames: number, loop: boolean): number {
  const next = current + 1
  if (next < frames) return next
  return loop ? 0 : frames - 1
}

/** 精灵动画渲染器:收编自原 SpritePlayer,逐帧绘制逻辑不变,只是包了一层 PetRenderer 接口。 */
export class SpriteRenderer implements PetRenderer {
  private timer: number | null = null
  private frame = 0
  private state = ''
  private sheet: HTMLImageElement | null = null
  private manifest: PetManifest | null = null
  private pendingSheet: HTMLImageElement | null = null
  private pendingManifest: PetManifest | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  async load(source: PetRenderSource): Promise<void> {
    if (source.type !== 'sprite') throw new Error('SpriteRenderer 只能加载 type:"sprite" 的 PetRenderSource')
    this.stop()
    const img = new Image()
    img.src = source.spritesheetDataUrl
    await img.decode()
    this.sheet = img
    this.manifest = source.manifest
    this.frame = 0
    this.state = ''
  }

  async prepareSwap(source: PetRenderSource): Promise<void> {
    if (source.type !== 'sprite') throw new Error('SpriteRenderer.prepareSwap() 只能准备 type:"sprite" 的 PetRenderSource')
    const img = new Image()
    img.src = source.spritesheetDataUrl
    await img.decode()
    this.pendingSheet = img
    this.pendingManifest = source.manifest
  }

  commitSwap(): void {
    if (!this.pendingSheet || !this.pendingManifest) throw new Error('commitSwap() 前必须先成功调用 prepareSwap()')
    this.stop()
    this.sheet = this.pendingSheet
    this.manifest = this.pendingManifest
    this.frame = 0
    this.state = ''
    this.pendingSheet = null
    this.pendingManifest = null
  }

  discardSwap(): void {
    this.pendingSheet = null
    this.pendingManifest = null
  }

  playState(state: PetVisualState): void {
    this.stop()
    if (!this.manifest) return
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.canvas.width = this.manifest.sheet.cellWidth
    this.canvas.height = this.manifest.sheet.cellHeight
    this.tick(anim)
  }

  setFacing(_direction: 'left' | 'right'): void {
    // no-op:sprite 包的朝向由 playState('walk-left'/'walk-right') 自身决定(两行独立绘制
    // 的动画),不需要镜像变换。只有 Live2D 渲染器(Phase 4)会真正实现这个方法。
  }

  setLipSync(_level: number): void {
    // no-op:精灵格式没有可驱动的口型参数,这是格式本身的固有限制,不是遗漏。
  }

  setLookTarget(_x: number, _y: number): void {
    // no-op
  }

  hitTest(clientX: number, clientY: number): PetHitResult {
    return { hit: this.isPetPixel(clientX, clientY) }
  }

  resize(_viewport: PetViewport): void {
    // no-op:画布尺寸仍在 load()/playState() 时从 manifest.sheet 派生;真正的动态窗口
    // 尺寸是 Phase 5 的工作(主设计文档 §9)。
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
  }

  async destroy(): Promise<void> {
    this.stop()
    this.sheet = null
    this.manifest = null
  }

  private stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private tick(anim: PetAnimation): void {
    this.draw(anim, this.frame)
    const delay = frameDurationMs(anim, this.frame)
    const next = nextFrameIndex(this.frame, anim.frames, anim.loop)
    if (next === this.frame && !anim.loop) return // held last frame
    this.timer = window.setTimeout(() => {
      this.frame = next
      if (this.manifest?.animations[this.state] === anim) this.tick(anim)
    }, delay)
  }

  private draw(anim: PetAnimation, index: number): void {
    if (!this.manifest || !this.sheet) return
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }

  /**
   * True when a viewport point falls on a non-transparent pixel of the pet.
   * Used to decide click-through: transparent areas should pass clicks below.
   */
  private isPetPixel(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) {
      return false
    }
    const px = Math.floor((clientX - rect.left) * (this.canvas.width / rect.width))
    const py = Math.floor((clientY - rect.top) * (this.canvas.height / rect.height))
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    const alpha = ctx.getImageData(px, py, 1, 1).data[3]
    return alpha > 10
  }
}
