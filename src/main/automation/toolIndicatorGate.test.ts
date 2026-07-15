import { describe, it, expect, vi } from 'vitest'
import { createIndicatorGate, wrapToolsWithGate } from './toolIndicatorGate'
import type { ToolSpec } from '../tools/toolSpec'

describe('createIndicatorGate', () => {
  it('第一次 onToolStart 才调用 show,之后重复调用不重复 show', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    gate.onToolStart()
    gate.onToolStart()
    expect(show).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
  })

  it('同一轮内多次工具调用之间(onToolStart 之后紧接着又 onToolStart)不会提前 hide', () => {
    // 回归用例:桌面控制的多个工具调用在 agentLoop 里严格顺序执行,永不并发——
    // 引用计数版实现里 active 每次都会先归零再回到 1,导致每个工具调用都触发一次
    // show+hide,安全网(manualOverrideWatch)和 lastAiPos 被反复清空重建,在两次
    // 工具调用之间(模型流式生成下一步指令的几秒)完全失去监控能力。这里验证:
    // 一次工具执行"完成"(此处用调用顺序模拟,不再有 onToolEnd 这类归零信号)后
    // 紧接着开始下一次工具调用,hide 不应被触发——只有整轮(turn)结束才 hide。
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const token = gate.beginTurn()
    gate.onToolStart() // 第一次工具调用(如 click_at)
    gate.onToolStart() // 第二次工具调用(如 type_text),期间不应有任何 hide
    expect(hide).not.toHaveBeenCalled()
    gate.endTurn(token)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('endTurn 用匹配的 token 且曾经 show 过时才触发 hide', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const token = gate.beginTurn()
    gate.onToolStart()
    gate.endTurn(token)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('从未 onToolStart 过的轮次结束不会误触发 hide(没用过桌面工具的普通对话)', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const token = gate.beginTurn()
    gate.endTurn(token)
    expect(show).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('过期 token 的 endTurn 是无效的:防止旧轮次取消后延迟收尾,关掉新轮次刚启动的安全网', () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const staleToken = gate.beginTurn()
    gate.onToolStart() // 旧轮次(如已被 cancel)里最后一次仍在途的工具调用
    const freshToken = gate.beginTurn() // 新一轮消息紧接着开始
    gate.onToolStart() // 新轮次第一次工具调用,复用同一个 show(已在 shown 状态,不重复调用)
    gate.endTurn(staleToken) // 旧轮次迟到的收尾:必须是 no-op
    expect(hide).not.toHaveBeenCalled()
    gate.endTurn(freshToken)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})

describe('wrapToolsWithGate', () => {
  const ctx = { signal: new AbortController().signal }
  function makeTool(name: string, impl: () => Promise<string>): ToolSpec {
    return { name, description: 'd', inputSchema: { type: 'object', properties: {}, required: [] }, run: impl }
  }

  it('run 前调用 onToolStart,触发 show', async () => {
    const calls: string[] = []
    const show = vi.fn(() => calls.push('show')); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { calls.push('run'); return 'ok' })], gate)
    await wrapped.run({}, ctx)
    expect(calls).toEqual(['show', 'run'])
  })

  it('run 抛错也不影响 gate 状态(仍需 endTurn 才 hide)', async () => {
    const show = vi.fn(); const hide = vi.fn()
    const gate = createIndicatorGate(show, hide)
    const token = gate.beginTurn()
    const [wrapped] = wrapToolsWithGate([makeTool('a', async () => { throw new Error('boom') })], gate)
    await expect(wrapped.run({}, ctx)).rejects.toThrow('boom')
    expect(hide).not.toHaveBeenCalled()
    gate.endTurn(token)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
