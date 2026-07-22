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
  /** 后台准备下一个模型/精灵表,不改变当前可见画面。只在"新旧渲染器类型相同"的热切换
   *  路径下被调用(跨类型切换走全新实例的 load(),不经过这三个方法,见 PetController)。
   *  见 Phase 5 设计文档 §1/§2。 */
  prepareSwap(source: PetRenderSource): Promise<void>
  /** 原子提交 prepareSwap() 准备好的模型/精灵表;没有成功的 prepareSwap() 时调用应抛错。 */
  commitSwap(): void
  /** 丢弃 prepareSwap() 准备好但未提交的半成品,不影响当前可见模型。 */
  discardSwap(): void
  playState(state: PetVisualState): void
  /** live2d 用的镜像朝向;sprite 渲染器上是 no-op(朝向由 playState 的 walk-left/walk-right 决定)。 */
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  /** 视线/头部跟随目标,x/y 是 [-1,1] 的方向,(0,0) 表示回正。sprite 渲染器上是 no-op。 */
  setLookTarget(x: number, y: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
