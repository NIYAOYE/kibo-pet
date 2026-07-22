import type { Bounds } from './petBrain'

export interface BubblePlacement {
  x: number
  y: number
  tailSide: 'top' | 'bottom'
  tailOffsetX: number
}

const GAP = 8          // 气泡与宠物之间的竖直间隙
const TAIL_MARGIN = 16 // 尾巴中心离气泡左右缘的最小距离

/**
 * 计算气泡伴随窗的左上角坐标与尾巴指向。
 * `anchorFrac` 是宠物窗口内的锚点相对坐标(0..1),默认 {x:0.5,y:0}(水平居中、贴窗口顶部,
 * 与精灵包此前的隐含行为完全一致)。Live2D 包传入 render.transform.bubbleAnchorX/Y。
 * 默认放锚点头顶、水平以锚点对齐;越界时:
 *  - 头顶放不下 → 翻到宠物整体下方(贴 pet.y+pet.height,而非锚点,尾巴改朝上);
 *  - 左右放不下 → 水平夹进工作区,尾巴水平偏移单独算以持续指向锚点;
 *  - 上下都放不下 → 夹进工作区(可见性优先)。
 * 输出的 x/y 始终完全落在 workArea 内。
 */
export function bubblePlacement(
  pet: Bounds,
  workArea: Bounds,
  bubble: { width: number; height: number },
  anchorFrac: { x: number; y: number } = { x: 0.5, y: 0 }
): BubblePlacement {
  const anchorX = pet.x + anchorFrac.x * pet.width
  const anchorY = pet.y + anchorFrac.y * pet.height

  // 水平:以锚点对齐,再夹进工作区
  let x = Math.round(anchorX - bubble.width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - bubble.width))

  // 竖直:优先锚点上方,不够翻下方,再不够夹进工作区
  const aboveY = anchorY - bubble.height - GAP
  const belowY = pet.y + pet.height + GAP
  let y: number
  let tailSide: 'top' | 'bottom'
  if (aboveY >= workArea.y) {
    y = aboveY
    tailSide = 'bottom'
  } else if (belowY + bubble.height <= workArea.y + workArea.height) {
    y = belowY
    tailSide = 'top'
  } else {
    y = aboveY
    tailSide = 'bottom'
  }
  // 无论哪个分支选中的 y,宠物本身可能被拖拽到工作区之外(拖拽不限位),
  // 因此这里统一夹取,确保输出的 y 始终完全落在 workArea 内。
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - bubble.height))

  // 尾巴水平偏移:指向锚点(相对气泡左缘),夹到内边距范围内
  let tailOffsetX = Math.round(anchorX - x)
  tailOffsetX = Math.max(TAIL_MARGIN, Math.min(tailOffsetX, bubble.width - TAIL_MARGIN))

  return { x, y, tailSide, tailOffsetX }
}
