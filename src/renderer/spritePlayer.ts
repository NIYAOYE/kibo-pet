import { frameRect, frameDurationMs, type PetManifest, type PetAnimation } from '@shared/petPackage'

export function nextFrameIndex(current: number, frames: number, loop: boolean): number {
  const next = current + 1
  if (next < frames) return next
  return loop ? 0 : frames - 1
}

export class SpritePlayer {
  private timer: number | null = null
  private frame = 0
  private state = ''
  constructor(
    private canvas: HTMLCanvasElement,
    private sheet: HTMLImageElement,
    private manifest: PetManifest
  ) {}

  play(state: string): void {
    this.stop()
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.canvas.width = this.manifest.sheet.cellWidth
    this.canvas.height = this.manifest.sheet.cellHeight
    this.tick(anim)
  }

  stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private tick(anim: PetAnimation): void {
    this.draw(anim, this.frame)
    const delay = frameDurationMs(anim, this.frame)
    const next = nextFrameIndex(this.frame, anim.frames, anim.loop)
    if (next === this.frame && !anim.loop) return // held last frame
    this.timer = window.setTimeout(() => {
      this.frame = next
      if (this.manifest.animations[this.state] === anim) this.tick(anim)
    }, delay)
  }

  private draw(anim: PetAnimation, index: number): void {
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }

  /**
   * True when a viewport point falls on a non-transparent pixel of the pet.
   * Used to decide click-through: transparent areas should pass clicks below.
   */
  isPetPixel(clientX: number, clientY: number): boolean {
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
