import { describe, it, expect, vi } from 'vitest'
import { createLive2DContextRecoveryGuard, CONTEXT_RECOVERY_MESSAGE, CONTEXT_GIVEN_UP_MESSAGE } from './live2dContextRecoveryGuard'

function createFakeCanvas() {
  const listeners: Record<string, Array<(e: Event) => void>> = {}
  return {
    addEventListener(type: string, cb: (e: Event) => void): void {
      (listeners[type] ??= []).push(cb)
    },
    removeEventListener(type: string, cb: (e: Event) => void): void {
      const list = listeners[type]
      if (!list) return
      const idx = list.indexOf(cb)
      if (idx !== -1) list.splice(idx, 1)
    },
    fire(type: string, event: Partial<Event> = {}): void {
      const full = { preventDefault: () => {}, ...event } as Event
      for (const cb of listeners[type] ?? []) cb(full)
    }
  }
}

const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve())

describe('createLive2DContextRecoveryGuard', () => {
  it('healthy 状态下丢失 context:preventDefault + 显示恢复中占位 + 上报 recovering + 强制鼠标穿透', () => {
    const canvas = createFakeCanvas()
    const preventDefault = vi.fn()
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload: vi.fn(), showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost', { preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(showOverlay).toHaveBeenCalledWith(CONTEXT_RECOVERY_MESSAGE)
    expect(onStateChange).toHaveBeenCalledWith('recovering')
    expect(guard.currentState()).toBe('recovering')
    expect(forceIgnoreMouseEvents).toHaveBeenCalledOnce()
    expect(forceIgnoreMouseEvents).toHaveBeenCalledWith(true)
  })

  it('丢失后恢复:重载成功则回到 healthy 并隐藏占位,且不会在成功路径上再碰鼠标穿透状态', async () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn().mockResolvedValue(undefined)
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    forceIgnoreMouseEvents.mockClear() // 只关心恢复成功这一步是否额外调用
    canvas.fire('webglcontextrestored')
    await flush()

    expect(reload).toHaveBeenCalledOnce()
    expect(guard.currentState()).toBe('healthy')
    expect(hideOverlay).toHaveBeenCalledOnce()
    expect(onStateChange).toHaveBeenLastCalledWith('healthy')
    expect(forceIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('丢失后恢复:重载失败则进入 given-up 并显示永久提示,且强制鼠标穿透', async () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn().mockRejectedValue(new Error('load failed'))
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    forceIgnoreMouseEvents.mockClear() // 只关心 restore-failed 这一步是否额外调用
    canvas.fire('webglcontextrestored')
    await flush()

    expect(guard.currentState()).toBe('given-up')
    expect(showOverlay).toHaveBeenCalledWith(CONTEXT_GIVEN_UP_MESSAGE)
    expect(hideOverlay).not.toHaveBeenCalled()
    expect(forceIgnoreMouseEvents).toHaveBeenCalledOnce()
    expect(forceIgnoreMouseEvents).toHaveBeenCalledWith(true)
    warnSpy.mockRestore()
  })

  it('recovering 期间(还没等到 restored)又丢失一次:直接 given-up,不再等待/重载,再次强制鼠标穿透', () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn()
    const showOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay: vi.fn(), onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost')

    expect(guard.currentState()).toBe('given-up')
    expect(showOverlay).toHaveBeenLastCalledWith(CONTEXT_GIVEN_UP_MESSAGE)
    expect(reload).not.toHaveBeenCalled()
    expect(forceIgnoreMouseEvents).toHaveBeenCalledTimes(2)
    expect(forceIgnoreMouseEvents).toHaveBeenNthCalledWith(1, true)
    expect(forceIgnoreMouseEvents).toHaveBeenNthCalledWith(2, true)
  })

  it('given-up 之后的 context 事件一律忽略,也不会再次强制鼠标穿透', () => {
    const canvas = createFakeCanvas()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload: vi.fn(), showOverlay: vi.fn(), hideOverlay: vi.fn(), onStateChange, forceIgnoreMouseEvents
    })
    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost') // -> given-up
    onStateChange.mockClear()
    forceIgnoreMouseEvents.mockClear()

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')

    expect(onStateChange).not.toHaveBeenCalled()
    expect(guard.currentState()).toBe('given-up')
    expect(forceIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('恢复重载还没返回时又丢失一次 context:迟到的重载结果不能覆盖已经给定的 given-up(resolve 分支)', async () => {
    let resolveReload: (() => void) | null = null
    const reload = vi.fn(() => new Promise<void>((resolve) => { resolveReload = resolve }))
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const canvas = createFakeCanvas()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay, onStateChange: onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    expect(reload).toHaveBeenCalledOnce()
    canvas.fire('webglcontextlost') // 重载还没 resolve,又丢了一次
    expect(guard.currentState()).toBe('given-up')

    onStateChange.mockClear()
    showOverlay.mockClear()
    resolveReload!()
    await flush()

    expect(guard.currentState()).toBe('given-up')
    expect(hideOverlay).not.toHaveBeenCalled()
    // 迟到的 resolve 不应该再触发任何状态变化或提示——given-up 已经是既成事实。
    expect(onStateChange).not.toHaveBeenCalled()
    expect(showOverlay).not.toHaveBeenCalled()
  })

  it('恢复重载还没返回时又丢失一次 context:迟到的重载结果不能覆盖已经给定的 given-up(reject 分支)', async () => {
    let rejectReload: ((err: Error) => void) | null = null
    const reload = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectReload = reject }))
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const canvas = createFakeCanvas()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    expect(reload).toHaveBeenCalledOnce()
    canvas.fire('webglcontextlost') // 重载还没 settle,又丢了一次 -> given-up
    expect(guard.currentState()).toBe('given-up')

    onStateChange.mockClear()
    showOverlay.mockClear()
    forceIgnoreMouseEvents.mockClear()
    rejectReload!(new Error('stale reload failed'))
    await flush()

    expect(guard.currentState()).toBe('given-up')
    expect(hideOverlay).not.toHaveBeenCalled()
    // 迟到的 reject 同样不应该再触发任何状态变化或提示——given-up 已经是既成事实,
    // 第二次真实 contextlost 时已经报过一次 given-up 了,这里不能重复上报。
    expect(onStateChange).not.toHaveBeenCalled()
    expect(showOverlay).not.toHaveBeenCalled()
    expect(forceIgnoreMouseEvents).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('reset() 强制回到 healthy 并隐藏占位(真实换宠物提交新 source 时调用),不触碰鼠标穿透强制状态', () => {
    const canvas = createFakeCanvas()
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload: vi.fn(), showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextlost') // given-up
    forceIgnoreMouseEvents.mockClear()
    guard.reset()

    expect(guard.currentState()).toBe('healthy')
    expect(hideOverlay).toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('healthy')
    expect(forceIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('dispose() 之后旧 canvas 上的 contextlost/contextrestored 不应再触发任何回调(被换下的旧 guard 不能对无关的强制 lose context 误报)', async () => {
    const canvas = createFakeCanvas()
    const reload = vi.fn().mockResolvedValue(undefined)
    const showOverlay = vi.fn()
    const hideOverlay = vi.fn()
    const onStateChange = vi.fn()
    const forceIgnoreMouseEvents = vi.fn()
    const guard = createLive2DContextRecoveryGuard({
      canvas, reload, showOverlay, hideOverlay, onStateChange, forceIgnoreMouseEvents
    })

    guard.dispose()
    canvas.fire('webglcontextlost')
    canvas.fire('webglcontextrestored')
    await flush()

    expect(onStateChange).not.toHaveBeenCalled()
    expect(showOverlay).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(forceIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(guard.currentState()).toBe('healthy')
  })
})
