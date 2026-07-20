import { SpritePlayer } from './spritePlayer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  const controller = new PetController(player)
  await controller.start()
  const pcmPlayer = createPcmPlayer()
  window.petApi.onPetEvent((event) => {
    controller.send(event)
    // 新消息发送即打断正在朗读的语音(参照 opts.emitPetEvent('messageSent') 的既有约定)。
    if (event === 'messageSent') pcmPlayer.stop()
  })
  window.petApi.onContextSignal((kind) => controller.receiveContextSignal(kind))
  window.petApi.onPetChanged(() => {
    void controller.reload().catch((err) => console.warn('pet reload failed', err))
  })
  window.voiceApi.onAudioChunk((c) => pcmPlayer.play(c.audioBase64, c.sampleRate))
  window.voiceApi.onAudioError((message) => console.warn('[voice]', message))
  window.voiceApi.onPlaybackStop(() => pcmPlayer.stop())

  let dragging = false
  let moved = false
  let ignoring = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0
  let clickTimer: number | null = null

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
        if (clickTimer !== null) {
          clearTimeout(clickTimer); clickTimer = null
        }
        window.petApi.dragStart()
        controller.send('pickup')
      }
      if (moved) {
        void window.petApi.moveWindow({ dx: e.screenX - lastX, dy: e.screenY - lastY })
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
      window.petApi.dragEnd()
      controller.send('drop')
      controller.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    } else {
      // 点击(单击/双击均可)先打断正在播放的语音——pcmPlayer.stop() 在没有音频播放时
      // 本身就是空操作,不需要额外判断"是否正在说话"。
      pcmPlayer.stop()
      // 单击 → 开/关对话框;双击 → 戳(poke)。用短延时判别,双击时撤销开框
      if (clickTimer !== null) {
        clearTimeout(clickTimer); clickTimer = null
        controller.poke()
      } else {
        clickTimer = window.setTimeout(() => { clickTimer = null; window.petApi.toggleDialog() }, DBLCLICK_MS)
      }
    }
  })
}

function showBootError(err: unknown): void {
  console.error('boot failed', err)
  // 宠物包加载失败(最常见:fresh clone 缺 pets/luluka,该目录被 .gitignore)。
  // 透明窗默认会静默空白,这里显式给出可见提示,避免"启动没反应"无从排查。
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:12px;box-sizing:border-box;font:12px/1.5 system-ui,sans-serif;color:#fff;' +
    'text-align:center;background:rgba(176,32,32,.92);border-radius:8px;-webkit-app-region:no-drag'
  el.textContent = '宠物包加载失败:请确认 pets/luluka 存在(该目录被 .gitignore,新克隆需自行放置)。'
  document.body.appendChild(el)
}

boot().catch(showBootError)
