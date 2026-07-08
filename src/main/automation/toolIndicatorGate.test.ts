import { describe, it, expect, vi } from 'vitest'
import { createIndicatorGate, wrapToolsWithGate } from './toolIndicatorGate'
import type { ToolSpec } from '../tools/toolSpec'

describe('createIndicatorGate', () => {
  it('第一次 onToolStart 才调用 show,之后嵌套的 start 不重复调用', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolStart()
    gate.onToolStart()
    expect(show).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
  })

  it('计数归零才调用 hide', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolStart()
    gate.onToolStart()
    gate.onToolEnd()
    expect(hide).not.toHaveBeenCalled()
    gate.onToolEnd()
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('onToolEnd 多于 onToolStart 不会计数为负 / 不重复 hide', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolEnd()
    gate.onToolEnd()
    expect(hide).not.toHaveBeenCalled() // 从未 start 过,不该 hide
  })
})

describe('wrapToolsWithGate', () => {
  const ctx = { signal: new AbortController().signal }
  function makeTool(name: string, impl: () => Promise<string>): ToolSpec {
    return { name, description: 'd', inputSchema: { type: 'object', properties: {}, required: [] }, run: impl }
  }

  it('run 成功:start 在调用前、end 在调用后', async () => {
    const calls: string[] = []
    const show = vi.fn(() => calls.push('show')); const hide = vi.fn(() => calls.push('hide'))
    const gate = createIndicatorGate(show, hide)
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { calls.push('run'); return 'ok' })], gate)
    await wrapped.run({}, ctx)
    expect(calls).toEqual(['show', 'run', 'hide'])
  })

  it('run 抛错:end(hide)在 finally 里仍然执行', async () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { throw new Error('boom') })], gate)
    await expect(wrapped.run({}, ctx)).rejects.toThrow('boom')
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('两个包裹后的工具共享同一个 gate:并发执行时中途不会提前 hide', async () => {
    const calls: string[] = []
    const show = vi.fn(() => calls.push('show')); const hide = vi.fn(() => calls.push('hide'))
    const gate = createIndicatorGate(show, hide)
    let resolveA: () => void = () => {}
    const a = makeTool('a', () => new Promise((r) => { resolveA = () => r('a-done') }))
    const b = makeTool('b', async () => 'b-done')
    const [wrappedA, wrappedB] = wrapToolsWithGate([a, b], gate)
    const pA = wrappedA.run({}, ctx)
    await wrappedB.run({}, ctx) // b 先完成,但 a 还在跑
    expect(hide).not.toHaveBeenCalled()
    resolveA()
    await pA
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
