import type { PetRenderSource } from '@shared/petPackage'

/** 与 petBrain.ts 的 StepEffects.animation 同形状,直接复用其取值
 *  ('idle'/'walk-left'/'walk-right'/'drag'/'sleep'/'greet'/'thinking'/'talk')。 */
export type PetVisualState = string

export interface PetHitResult {
  hit: boolean
  /** live2d 命中的部位名(如 'Head'/'Body');sprite 渲染器不产出这个字段。 */
  area?: string
}

export interface PetViewport {
  width: number
  height: number
}

/**
 * PetController 只依赖这个接口,不知道背后是精灵动画还是 Live2D 模型。
 * 见主设计文档(docs/superpowers/specs/2026-07-20-live2d-renderer-design.md)§7.1。
 */
export interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  playState(state: PetVisualState): void
  /** live2d 用的镜像朝向;sprite 渲染器上是 no-op(朝向由 playState 的 walk-left/walk-right 决定)。 */
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
