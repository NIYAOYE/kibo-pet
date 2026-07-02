import { describe, it, expect } from 'vitest'
import { createToolRegistry, validateInput } from './toolRegistry'
import type { ToolSpec } from './toolSpec'

const echo: ToolSpec = {
  name: 'echo',
  description: '回声',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' }, times: { type: 'number' } }, required: ['msg'] },
  run: async (input) => `echo:${(input as { msg: string }).msg}`
}
const boom: ToolSpec = {
  name: 'boom',
  description: '总是抛错',
  inputSchema: { type: 'object', properties: {}, required: [] },
  run: async () => { throw new Error('炸了') }
}
const ctx = { signal: new AbortController().signal }

describe('validateInput', () => {
  it('缺必填参数报错', () => {
    expect(validateInput({}, echo.inputSchema)).toContain('msg')
  })
  it('类型不符报错', () => {
    expect(validateInput({ msg: 123 }, echo.inputSchema)).toContain('msg')
    expect(validateInput({ msg: 'x', times: 'many' }, echo.inputSchema)).toContain('times')
  })
  it('合法输入返回 null(多余字段容忍)', () => {
    expect(validateInput({ msg: 'x', extra: true }, echo.inputSchema)).toBeNull()
  })
  it('非对象入参报错', () => {
    expect(validateInput('str', echo.inputSchema)).not.toBeNull()
  })
})

describe('createToolRegistry', () => {
  const registry = createToolRegistry([echo, boom])

  it('defs() 只暴露声明,不带 run', () => {
    const defs = registry.defs()
    expect(defs).toHaveLength(2)
    expect(defs[0]).toEqual({ name: 'echo', description: '回声', inputSchema: echo.inputSchema })
    expect('run' in defs[0]).toBe(false)
  })

  it('正常执行透传结果', async () => {
    expect(await registry.run('echo', { msg: 'hi' }, ctx)).toEqual({ content: 'echo:hi' })
  })

  it('未知工具名 → isError,列出可用工具,不抛', async () => {
    const r = await registry.run('nope', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('echo')
  })

  it('参数校验失败 → isError,不执行工具', async () => {
    const r = await registry.run('echo', {}, ctx)
    expect(r.isError).toBe(true)
  })

  it('工具抛异常 → isError 文本,不向上抛', async () => {
    const r = await registry.run('boom', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('炸了')
  })
})
