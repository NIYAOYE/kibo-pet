import { SpriteRenderer } from './spriteRenderer'
import { Live2DPetRenderer } from './live2dRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import { createLipSyncSmoother, DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS } from './voice/lipSyncEnvelope'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

const DRAG_THRESHOLD = 4
const DBLCLICK_MS = 280

/** 一旦某个 canvas 元素被绑定过某种 context(2D 或 WebGL),规范上就再也不能换成另一种类型;
 *  而 pixi.js 的 Application.destroy() 还会无条件强制 lose 掉 WebGL context(GlContextSystem.
 *  destroy() 内部调用 loseContext(),没有选项能跳过),之后同一个 canvas 再 getContext('webgl')
 *  拿到的还是那个已经废弃的 context——所以每次(重新)构造渲染器都必须换一个全新的 canvas 元素,
 *  不能复用旧的,不管前后渲染器类型是否相同。 */
function createRendererForCanvas(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  return new Live2DPetRenderer(canvas)
}

async function boot(): Promise<void> {
  let canvas = document.getElementById('pet') as HTMLCanvasElement
  const source = await window.petApi.getPet()

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

  function onCanvasMouseDown(e: MouseEvent): void {
    dragging = true
    moved = false
    lastX = e.screenX; lastY = e.screenY
    downX = e.screenX; downY = e.screenY
    canvas.style.cursor = 'grabbing'
  }

  // canvas 每次热切换都会被换成一个全新元素(见上方 createRendererForCanvas 的注释),旧元素上
  // 的监听器跟着旧节点一起被丢弃,所以每次换 canvas 都要在新元素上重新挂一次 mousedown。
  canvas.addEventListener('mousedown', onCanvasMouseDown)

  const renderer = createRendererForCanvas(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer, source.type, (s) => {
    const fresh = document.createElement('canvas')
    fresh.id = canvas.id
    fresh.addEventListener('mousedown', onCanvasMouseDown)
    const nextRenderer = createRendererForCanvas(fresh, s)
    return {
      renderer: nextRenderer,
      attach: () => { canvas.replaceWith(fresh); canvas = fresh }
    }
  })
  await controller.start()
  const pcmPlayer = createPcmPlayer()
  window.petApi.onPetEvent((event) => {
    controller.send(event)
    // 新消息发送即打断正在朗读的语音(参照 opts.emitPetEvent('messageSent') 的既有约定)。
    if (event === 'messageSent') pcmPlayer.stop()
  })
  window.petApi.onContextSignal((kind) => controller.receiveContextSignal(kind))
  window.petApi.onPetPrepare((payload) => {
    controller.prepareReload(payload.source).then(
      () => window.petApi.reportPrepareResult(payload.requestId, true),
      (err) => window.petApi.reportPrepareResult(payload.requestId, false, err instanceof Error ? err.message : String(err))
    )
  })
  window.petApi.onPetCommit(() => {
    try { controller.commitReload() } catch (err) { console.warn('commitReload failed', err) }
  })
  window.petApi.onPetDiscard(() => {
    try { controller.discardReload() } catch (err) { console.warn('discardReload failed', err) }
  })
  window.petApi.onWindowVisibilityChanged((payload) => controller.setVisible(payload.visible))
  window.petApi.onMouseFocus((payload) => controller.setMouseFocus(payload.x, payload.y))
  window.voiceApi.onAudioChunk((c) => pcmPlayer.play(c.audioBase64, c.sampleRate))
  window.voiceApi.onAudioError((message) => console.warn('[voice]', message))
  window.voiceApi.onPlaybackStop(() => pcmPlayer.stop())

  // 口型驱动循环:与 PetController 的 33ms 业务 tick 解耦,用 rAF 跟渲染帧率对齐。
  // 没有语音播放时 pcmPlayer.getCurrentLevel() 恒返回 0,smoother 很快收敛到 0 不再变化,
  // 常驻运行的代价可以忽略——不需要在 TTS 开关/播放状态变化时单独启停这个循环。
  const lipSyncSmoother = createLipSyncSmoother(DEFAULT_LIP_SYNC_ATTACK_MS, DEFAULT_LIP_SYNC_RELEASE_MS)
  let lastLipSyncTickMs = performance.now()
  function tickLipSync(): void {
    const now = performance.now()
    const dtMs = now - lastLipSyncTickMs
    lastLipSyncTickMs = now
    const level = lipSyncSmoother.step(pcmPlayer.getCurrentLevel(), dtMs)
    controller.setLipSync(level)
    requestAnimationFrame(tickLipSync)
  }
  requestAnimationFrame(tickLipSync)

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
    setIgnore(!controller.hitTest(e.clientX, e.clientY).hit)
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
