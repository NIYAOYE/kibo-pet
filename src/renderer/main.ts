import { SpritePlayer } from './spritePlayer'

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  player.play('idle')

  // 拖拽移动窗口 + 透明区域点击穿透
  let dragging = false
  let lastX = 0
  let lastY = 0
  let ignoring = false

  function setIgnore(ignore: boolean): void {
    if (ignore === ignoring) return
    ignoring = ignore
    window.petApi.setIgnoreMouseEvents(ignore)
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true
    lastX = e.screenX
    lastY = e.screenY
    canvas.style.cursor = 'grabbing'
  })
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging) {
      window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
      lastX = e.screenX
      lastY = e.screenY
      return
    }
    // 光标在露露卡不透明像素上 → 可交互;否则让点击穿透到下层窗口
    setIgnore(!player.isPetPixel(e.clientX, e.clientY))
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    canvas.style.cursor = 'grab'
  })
}

boot().catch((err) => console.error('boot failed', err))
