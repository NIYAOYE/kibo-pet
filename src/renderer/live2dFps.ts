import type { PetVisualState } from './petRenderer'

/** 场景相关的 Live2D 渲染帧率策略,见主设计文档 §10。只作用于 Live2D(WebGL);
 *  精灵模式是 2D canvas 绘制,不参与。 */
export function fpsForState(state: PetVisualState): number {
  if (state === 'sleep') return 15
  if (state === 'idle') return 30
  return 60 // drag/walk-left/walk-right/talk/greet/thinking/happy/sad/cry/surprised/love,以及任何未识别的新状态
}
