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
} {
  const loadedWith: PetRenderSource[] = []
  const prepareSwapWith: PetRenderSource[] = []
  return {
    destroyed: false,
    loadedWith,
    prepareSwapWith,
    commitSwapCalled: false,
    discardSwapCalled: false,
    async load(source) { loadedWith.push(source) },
    async prepareSwap(source) {
      if (this.shouldFailPrepare) throw new Error('prepare failed')
      prepareSwapWith.push(source)
    },
    commitSwap() { this.commitSwapCalled = true },
    discardSwap() { this.discardSwapCalled = true },
    playState() {},
    setFacing() {},
    setLipSync() {},
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
