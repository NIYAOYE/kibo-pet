const canvas = document.getElementById('canvas') as HTMLCanvasElement
const stage = document.getElementById('stage') as HTMLElement
const sel = document.getElementById('sel') as HTMLElement
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement
const okBtn = document.getElementById('okBtn') as HTMLButtonElement

const DISPLAY_EDGE = 380  // 画布在窗口里的可见边长(css px)
const OUTPUT_EDGE = 256   // 最终导出头像边长(px);主进程再按 48px 裁小图用于列表/头像
const MIN_SEL = 40        // 选框最小可见尺寸(css px)

let naturalEdge = DISPLAY_EDGE // 黑边合成后的正方形画布"自然像素"边长(= 原图长边)
let scale = 1                   // display px → natural px 的换算:natural = display * scale
let ready = false

const box = { x: 0, y: 0, size: 0 } // 选框状态,display px 坐标空间(相对 #stage 左上角)

function layoutSel(): void {
  sel.style.left = `${box.x}px`
  sel.style.top = `${box.y}px`
  sel.style.width = `${box.size}px`
  sel.style.height = `${box.size}px`
}

function clampBox(): void {
  box.size = Math.max(MIN_SEL, Math.min(box.size, DISPLAY_EDGE))
  box.x = Math.max(0, Math.min(box.x, DISPLAY_EDGE - box.size))
  box.y = Math.max(0, Math.min(box.y, DISPLAY_EDGE - box.size))
}

/** 任意尺寸原图 → 黑边居中合成正方形:canvas 的像素缓冲区保持原图分辨率(naturalEdge),
 *  只用 CSS 把可见尺寸缩到 DISPLAY_EDGE——之后裁剪时才能从 canvas 读到完整原始像素,
 *  不会因为"先缩小到显示尺寸再裁"而让放大后的头像发糊。 */
async function init(imageDataUrl: string): Promise<void> {
  const img = new Image()
  img.src = imageDataUrl
  await img.decode()

  naturalEdge = Math.max(img.naturalWidth, img.naturalHeight)
  scale = naturalEdge / DISPLAY_EDGE

  canvas.width = naturalEdge
  canvas.height = naturalEdge
  canvas.style.width = `${DISPLAY_EDGE}px`
  canvas.style.height = `${DISPLAY_EDGE}px`
  stage.style.width = `${DISPLAY_EDGE}px`
  stage.style.height = `${DISPLAY_EDGE}px`

  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, naturalEdge, naturalEdge)
  const dx = (naturalEdge - img.naturalWidth) / 2
  const dy = (naturalEdge - img.naturalHeight) / 2
  ctx.drawImage(img, dx, dy)

  box.size = Math.round(DISPLAY_EDGE * 0.7)
  box.x = Math.round((DISPLAY_EDGE - box.size) / 2)
  box.y = box.x
  layoutSel()
  ready = true
}

type DragMode = 'move' | 'resize' | null
let dragMode: DragMode = null
let dragStart = { x: 0, y: 0, boxX: 0, boxY: 0, boxSize: 0 }

sel.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  dragMode = target.classList.contains('handle') ? 'resize' : 'move'
  dragStart = { x: e.clientX, y: e.clientY, boxX: box.x, boxY: box.y, boxSize: box.size }
  e.preventDefault()
})
window.addEventListener('mousemove', (e) => {
  if (!dragMode) return
  const dx = e.clientX - dragStart.x
  const dy = e.clientY - dragStart.y
  if (dragMode === 'move') {
    box.x = dragStart.boxX + dx
    box.y = dragStart.boxY + dy
  } else {
    // 右下角手柄:取横/竖两个分量中更大的一个,维持正方形
    box.size = dragStart.boxSize + Math.max(dx, dy)
  }
  clampBox()
  layoutSel()
})
window.addEventListener('mouseup', () => { dragMode = null })

function submitCrop(): void {
  if (!ready) return
  const nx = box.x * scale
  const ny = box.y * scale
  const nSize = box.size * scale
  const out = document.createElement('canvas')
  out.width = OUTPUT_EDGE
  out.height = OUTPUT_EDGE
  const octx = out.getContext('2d')!
  octx.drawImage(canvas, nx, ny, nSize, nSize, 0, 0, OUTPUT_EDGE, OUTPUT_EDGE)
  window.avatarCropApi.submit(out.toDataURL('image/png'))
}

okBtn.addEventListener('click', submitCrop)
cancelBtn.addEventListener('click', () => window.avatarCropApi.cancel())
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.avatarCropApi.cancel()
  else if (e.key === 'Enter') submitCrop()
})

window.avatarCropApi.onInit((d) => { void init(d.imageDataUrl) })
