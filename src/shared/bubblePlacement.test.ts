import { describe, it, expect } from 'vitest'
import { bubblePlacement } from './bubblePlacement'

const workArea = { x: 0, y: 0, width: 1000, height: 800 }
const bubble = { width: 200, height: 60 }

describe('bubblePlacement 默认 anchorFrac(不传第四参数)', () => {
  it('行为与此前硬编码"水平居中+贴窗口顶部"完全一致(回归)', () => {
    const pet = { x: 400, y: 300, width: 256, height: 288 }
    const result = bubblePlacement(pet, workArea, bubble)
    const expected = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    expect(result).toEqual(expected)
    expect(result.y).toBe(pet.y - bubble.height - 8) // GAP=8,头顶放得下时贴顶部
  })

  it('头顶放不下(宠物贴工作区顶边)时翻到宠物整体下方,而非锚点下方(回归:曾错误地用 anchorY+GAP)', () => {
    const pet = { x: 400, y: 0, width: 256, height: 100 }
    const result = bubblePlacement(pet, workArea, bubble)
    // 锚点上方放不下:aboveY = anchorY(=pet.y=0) - bubble.height(60) - GAP(8) = -68 < workArea.y(0)
    // 翻下方应贴宠物整体底边 pet.y+pet.height+GAP = 0+100+8 = 108,而不是 anchorY+GAP = 8
    expect(result.y).toBe(pet.y + pet.height + 8)
    expect(result.tailSide).toBe('top')
  })
})

describe('bubblePlacement 自定义 anchorFrac(Live2D 包 bubbleAnchorX/Y)', () => {
  it('锚点从窗口顶部中心变成窗口顶部靠左时,气泡水平位置随之偏移', () => {
    const pet = { x: 400, y: 300, width: 360, height: 480 }
    const centerResult = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    const leftResult = bubblePlacement(pet, workArea, bubble, { x: 0.2, y: 0 })
    expect(leftResult.x).toBeLessThan(centerResult.x)
  })

  it('anchorY=1(锚点在窗口底部,例如脚底)时,气泡摆在锚点上方,而不是原来假设的窗口顶部上方', () => {
    const pet = { x: 400, y: 300, width: 360, height: 480 }
    const footAnchor = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 1 })
    const topAnchor = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    // 锚点在底部时,气泡应该比"锚点在顶部"时更靠下(y 更大),因为参照点本身更靠下
    expect(footAnchor.y).toBeGreaterThan(topAnchor.y)
  })

  it('结果 x/y 始终落在 workArea 内(既有夹取行为不受新参数影响)', () => {
    const pet = { x: -50, y: -50, width: 360, height: 480 } // 宠物被拖出工作区外
    const result = bubblePlacement(pet, workArea, bubble, { x: 0.5, y: 0 })
    expect(result.x).toBeGreaterThanOrEqual(workArea.x)
    expect(result.y).toBeGreaterThanOrEqual(workArea.y)
  })
})
