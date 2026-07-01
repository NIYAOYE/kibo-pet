import { SpritePlayer } from './spritePlayer'
import { PetController } from './petController'

const DRAG_THRESHOLD = 4

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  const controller = new PetController(player)
  await controller.start()
  window.petApi.onPetEvent((event) => controller.send(event))

  let dragging = false
  let moved = false
  let ignoring = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0

  function setIgnore(ignore: boolean): void {
    if (ignore === ignoring) return
    ignoring = ignore
    window.petApi.setIgnoreMouseEvents(ignore)
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true
    moved = false
    lastX = e.screenX; lastY = e.screenY
    downX = e.screenX; downY = e.screenY
    canvas.style.cursor = 'grabbing'
  })

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging) {
      if (!moved && Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY) > DRAG_THRESHOLD) {
        moved = true
        controller.send('pickup')
      }
      if (moved) {
        window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
        lastX = e.screenX; lastY = e.screenY
      }
      return
    }
    setIgnore(!player.isPetPixel(e.clientX, e.clientY))
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved) {
      controller.send('drop')
      controller.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    } else {
      window.petApi.toggleDialog() // 未越阈值 = 单击 → 开/关对话框
    }
  })
}

boot().catch((err) => console.error('boot failed', err))
