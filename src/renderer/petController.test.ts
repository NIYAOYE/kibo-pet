import { describe, it, expect, vi } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

function makeFakeRenderer(): PetRenderer & {
  destroyed: boolean
  loadedWith: PetRenderSource[]
  prepareSwapWith: PetRenderSource[]
  commitSwapCalled: boolean
  discardSwapCalled: boolean
  shouldFailPrepare?: boolean
  lipSyncLevels: number[]
  lookTargets: { x: number; y: number }[]
} {
  const loadedWith: PetRenderSource[] = []
  const prepareSwapWith: PetRenderSource[] = []
  const lipSyncLevels: number[] = []
  const lookTargets: { x: number; y: number }[] = []
  return {
    destroyed: false,
    loadedWith,
    prepareSwapWith,
    commitSwapCalled: false,
    discardSwapCalled: false,
    lipSyncLevels,
    lookTargets,
    async load(source) { loadedWith.push(source) },
    async prepareSwap(source) {
      if (this.shouldFailPrepare) throw new Error('prepare failed')
      prepareSwapWith.push(source)
    },
    commitSwap() { this.commitSwapCalled = true },
    discardSwap() { this.discardSwapCalled = true },
    playState() {},
    setFacing() {},
    setLipSync(level: number) { this.lipSyncLevels.push(level) },
    setLookTarget(x: number, y: number) { this.lookTargets.push({ x, y }) },
    hitTest(): PetHitResult { return { hit: false } },
    resize() {},
    setVisible() {},
    async destroy() { this.destroyed = true }
  }
}

const spriteSource: PetRenderSource = { type: 'sprite', manifest: {} as any, spritesheetDataUrl: 'data:x' }
const live2dSource: PetRenderSource = { type: 'live2d', manifest: {} as any, resourceBaseUrl: 'kibo-pet://tok/' }

describe('PetController 准备-提交热切换', () => {
  it('同类型(sprite→sprite):prepareReload 调用 renderer.prepareSwap,不销毁旧实例;commitReload 才调用 commitSwap', async () => {
    const renderer = makeFakeRenderer()
    const factory = vi.fn()
    const controller = new PetController(renderer, 'sprite', factory)

    await controller.prepareReload(spriteSource)
    expect(renderer.prepareSwapWith).toEqual([spriteSource])
    expect(renderer.commitSwapCalled).toBe(false)
    expect(renderer.destroyed).toBe(false)
    expect(factory).not.toHaveBeenCalled()

    controller.commitReload()
    expect(renderer.commitSwapCalled).toBe(true)
  })

  it('同类型(live2d→live2d):同上,走 prepareSwap/commitSwap,不新建实例', async () => {
    const renderer = makeFakeRenderer()
    const factory = vi.fn()
    const controller = new PetController(renderer, 'live2d', factory)

    await controller.prepareReload(live2dSource)
    controller.commitReload()

    expect(renderer.prepareSwapWith).toEqual([live2dSource])
    expect(renderer.commitSwapCalled).toBe(true)
    expect(factory).not.toHaveBeenCalled()
  })

  it('同类型 prepareReload 失败时,调用方可以 discardReload,旧渲染器不受影响', async () => {
    const renderer = makeFakeRenderer()
    renderer.shouldFailPrepare = true
    const controller = new PetController(renderer, 'sprite', vi.fn())

    await expect(controller.prepareReload(spriteSource)).rejects.toThrow('prepare failed')
    controller.discardReload()

    expect(renderer.discardSwapCalled).toBe(true)
    expect(renderer.destroyed).toBe(false)
  })

  it('跨类型(sprite→live2d):prepareReload 用工厂新建实例并 load(),不销毁/替换旧实例;commitReload 才销毁旧实例、切到新实例', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    const attach = vi.fn()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach }))
    const controller = new PetController(oldRenderer, 'sprite', factory)

    await controller.prepareReload(live2dSource)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(newRenderer.loadedWith).toEqual([live2dSource])
    expect(attach).not.toHaveBeenCalled()
    expect(oldRenderer.destroyed).toBe(false)

    controller.commitReload()
    expect(attach).toHaveBeenCalledOnce()
    expect(oldRenderer.destroyed).toBe(true)

    // hitTest 现在应该转发到新实例
    newRenderer.hitTest = () => ({ hit: true, area: 'Head' })
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })

  it('跨类型 load() 失败时,新实例被销毁,旧实例/attach 均未被触碰', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    newRenderer.load = async () => { throw new Error('load failed') }
    const attach = vi.fn()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach }))
    const controller = new PetController(oldRenderer, 'sprite', factory)

    await expect(controller.prepareReload(live2dSource)).rejects.toThrow('load failed')
    expect(newRenderer.destroyed).toBe(true)
    expect(attach).not.toHaveBeenCalled()
    expect(oldRenderer.destroyed).toBe(false)

    controller.discardReload() // 没有已准备好的跨类型实例时应是安静的 no-op
    expect(oldRenderer.destroyed).toBe(false)
  })

  it('setVisible() 转发给当前渲染器', () => {
    const renderer = makeFakeRenderer()
    let receivedVisible: boolean | undefined
    renderer.setVisible = (v) => { receivedVisible = v }
    const controller = new PetController(renderer, 'sprite', vi.fn())
    controller.setVisible(false)
    expect(receivedVisible).toBe(false)
  })
})

describe('PetController.hitTest()', () => {
  it('hitTest() 转发到当前渲染器实例(切换后也转发到新实例,不是旧的)', async () => {
    const initial = makeFakeRenderer()
    initial.hitTest = () => ({ hit: false })
    const replacement = makeFakeRenderer()
    replacement.hitTest = () => ({ hit: true, area: 'Head' })
    const controller = new PetController(initial, 'sprite', () => ({ renderer: replacement, attach: () => {} }))

    expect(controller.hitTest(1, 2)).toEqual({ hit: false })
    await controller.prepareReload(live2dSource)
    controller.commitReload()
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })
})

describe('PetController 行为模块按 rendererType 选择', () => {
  it('构造时 rendererType=sprite → 内部使用 petBrain(idle 初始状态,walk 相关 effects 字段存在)', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'sprite', vi.fn()) as any
    expect(controller.behavior.kind).toBe('sprite')
    expect(controller.behavior.ctx.state).toBe('idle')
    expect(controller.behavior.ctx.dir).toBe('right') // sprite-only field — proves petBrain.initBrain() ran
  })

  it('构造时 rendererType=live2d → 内部使用 live2dPetBrain(idle 初始状态,不含 dir/dwellMs 等 walk 字段)', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn()) as any
    expect(controller.behavior.kind).toBe('live2d')
    expect(controller.behavior.ctx.state).toBe('idle')
    expect(controller.behavior.ctx.dir).toBeUndefined() // live2dPetBrain.initLive2DBrain() has no dir field
    expect(controller.behavior.ctx.dwellMs).toBeUndefined()
  })

  it('跨类型热切换(sprite→live2d)commitReload 后 behavior 切到 live2d;反向切换切回 sprite', async () => {
    const oldRenderer = makeFakeRenderer()
    const newRenderer = makeFakeRenderer()
    const factory = vi.fn(() => ({ renderer: newRenderer, attach: vi.fn() }))
    const controller = new PetController(oldRenderer, 'sprite', factory) as any
    expect(controller.behavior.kind).toBe('sprite')

    await controller.prepareReload(live2dSource)
    controller.commitReload()
    expect(controller.behavior.kind).toBe('live2d')
    expect(controller.behavior.ctx.state).toBe('idle')

    const backFactory = vi.fn(() => ({ renderer: oldRenderer, attach: vi.fn() }))
    const controller2 = new PetController(newRenderer, 'live2d', backFactory) as any
    await controller2.prepareReload(spriteSource)
    controller2.commitReload()
    expect(controller2.behavior.kind).toBe('sprite')
  })

  it('live2d 控制器执行 tick():renderer.playState 收到 live2d 初始状态动画,moveWindow 从未被调用(Live2D 宠物结构上不产出自主位移)', async () => {
    const renderer = makeFakeRenderer()
    const playState = vi.fn()
    renderer.playState = playState
    const moveWindow = vi.fn()
    const bounds = {
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      window: { x: 100, y: 100, width: 256, height: 288 }
    }
    ;(globalThis as any).window = {
      petApi: {
        getWindowBounds: vi.fn().mockResolvedValue(bounds),
        moveWindow,
        petSpeak: vi.fn()
      }
    }
    const controller = new PetController(renderer, 'live2d', vi.fn()) as any

    await controller.syncBounds()
    // 避免 lastTs 默认值 0 导致 dtMs 被算成"进程启动至今"的巨大值,意外把
    // live2d idle 推进到 sleep 分支——只测 tick() 本身对 moveWindow/playState 的调用。
    controller.lastTs = performance.now()
    controller.tick()

    expect(playState).toHaveBeenCalledWith('idle')
    expect(moveWindow).not.toHaveBeenCalled()
  })
})

describe('PetController.setLipSync', () => {
  it('直接转发给当前 renderer.setLipSync()', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn())
    controller.setLipSync(0.7)
    expect(renderer.lipSyncLevels).toEqual([0.7])
  })
})

describe('PetController.setMouseFocus', () => {
  it('非睡眠状态(初始状态就是 idle,不是 sleep):原样转发给 renderer.setLookTarget()', () => {
    const renderer = makeFakeRenderer()
    const controller = new PetController(renderer, 'live2d', vi.fn())
    controller.setMouseFocus(0.4, -0.2)
    expect(renderer.lookTargets).toEqual([{ x: 0.4, y: -0.2 }])
  })
})
