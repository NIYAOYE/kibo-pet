import type { OverlayRect } from '@shared/ipc'

const shot = document.getElementById('shot') as HTMLImageElement
const mask = document.getElementById('mask') as HTMLElement
const sel = document.getElementById('sel') as HTMLElement

let sx = 0, sy = 0, dragging = false

window.overlayApi.onInit((d) => { shot.src = d.screenshotDataUrl })

function rectOf(x: number, y: number): OverlayRect {
  return { x: Math.min(sx, x), y: Math.min(sy, y), width: Math.abs(x - sx), height: Math.abs(y - sy) }
}
function place(r: OverlayRect): void {
  sel.style.left = `${r.x}px`; sel.style.top = `${r.y}px`
  sel.style.width = `${r.width}px`; sel.style.height = `${r.height}px`
}

window.addEventListener('mousedown', (e) => {
  dragging = true; sx = e.clientX; sy = e.clientY
  mask.style.display = 'none' // 用 sel 的 box-shadow 充当遮罩,避免双层
  sel.style.display = 'block'; place(rectOf(e.clientX, e.clientY))
})
window.addEventListener('mousemove', (e) => { if (dragging) place(rectOf(e.clientX, e.clientY)) })
window.addEventListener('mouseup', (e) => {
  if (!dragging) return
  dragging = false
  window.overlayApi.submit(rectOf(e.clientX, e.clientY))
})
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.overlayApi.cancel() })
