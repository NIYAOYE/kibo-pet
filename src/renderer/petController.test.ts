import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetController } from './petController'
import type { PetRenderer, PetHitResult } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'

function makeFakeRenderer(): PetRenderer & { destroyed: boolean; loadedWith: PetRenderSource[] } {
  const loadedWith: PetRenderSource[] = []
  return {
    destroyed: false,
    loadedWith,
    async load(source) { loadedWith.push(source) },
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

describe('PetController.reload() 热切换', () => {
  let getPetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getPetMock = vi.fn()
    ;(globalThis as any).window = { petApi: { getPet: getPetMock } }
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('类型不变(sprite→sprite)时仍然销毁旧实例、用工厂构造新实例——Live2D 的 WebGL context 一旦 destroy() 就被 pixi.js 强制 lose 掉,同一个 canvas 之后再也拿不到能用的 context,所以即使类型相同也不能安全复用旧渲染器实例', async () => {
    getPetMock.mockResolvedValue(spriteSource)
    const initial = makeFakeRenderer()
    const replacement = makeFakeRenderer()
    const factory = vi.fn(() => replacement)
    const controller = new PetController(initial, factory)

    await controller.reload()

    expect(initial.destroyed).toBe(true)
    expect(factory).toHaveBeenCalledWith(spriteSource)
    expect(replacement.loadedWith).toEqual([spriteSource])
  })

  it('类型从 sprite 变成 live2d 时销毁旧实例、用工厂构造新实例', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    const replacement = makeFakeRenderer()
    const factory = vi.fn(() => replacement)
    const controller = new PetController(initial, factory)

    await controller.reload()

    expect(initial.destroyed).toBe(true)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(replacement.loadedWith).toEqual([live2dSource])
  })

  it('类型从 live2d 变成 live2d(同类型热切换)也销毁旧实例、用工厂构造新实例', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    const replacement = makeFakeRenderer()
    const factory = vi.fn(() => replacement)
    const controller = new PetController(initial, factory)

    await controller.reload()

    expect(initial.destroyed).toBe(true)
    expect(factory).toHaveBeenCalledWith(live2dSource)
    expect(replacement.loadedWith).toEqual([live2dSource])
  })

  it('hitTest() 转发到当前渲染器实例(切换后也转发到新实例,不是旧的)', async () => {
    getPetMock.mockResolvedValue(live2dSource)
    const initial = makeFakeRenderer()
    initial.hitTest = () => ({ hit: false })
    const replacement = makeFakeRenderer()
    replacement.hitTest = () => ({ hit: true, area: 'Head' })
    const controller = new PetController(initial, () => replacement)

    expect(controller.hitTest(1, 2)).toEqual({ hit: false })
    await controller.reload()
    expect(controller.hitTest(1, 2)).toEqual({ hit: true, area: 'Head' })
  })
})
