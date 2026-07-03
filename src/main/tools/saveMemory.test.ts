import { describe, it, expect, vi } from 'vitest'
import { createSaveMemoryTool } from './saveMemory'
import { createToolRegistry } from './toolRegistry'

const ctx = (onStatus?: (t: string) => void) => ({ signal: new AbortController().signal, onStatus })

describe('save_memory 工具', () => {
  it('调用 saveFact 并播报「记住了」', async () => {
    const saveFact = vi.fn(() => ({ text: '用户叫小星', deduped: false }))
    const statuses: string[] = []
    const tool = createSaveMemoryTool(saveFact)
    const out = await tool.run({ text: ' 用户叫小星 ' }, ctx((t) => statuses.push(t)))
    expect(saveFact).toHaveBeenCalledWith('用户叫小星') // 已 trim
    expect(out).toContain('已记住')
    expect(statuses[0]).toContain('记住了')
  })

  it('判重时返回「已经记过」', async () => {
    const tool = createSaveMemoryTool(() => ({ text: '用户叫小星', deduped: true }))
    const out = await tool.run({ text: '用户叫小星' }, ctx())
    expect(out).toContain('已经记过')
  })

  it('空 text 经 registry 转为 isError 回灌,不抛', async () => {
    const registry = createToolRegistry([createSaveMemoryTool(() => ({ text: '', deduped: false }))])
    const r = await registry.run('save_memory', { text: '   ' }, ctx())
    expect(r.isError).toBe(true)
  })

  it('缺 text 被 registry 校验拦下', async () => {
    const registry = createToolRegistry([createSaveMemoryTool(() => ({ text: '', deduped: false }))])
    const r = await registry.run('save_memory', {}, ctx())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('text')
  })
})
