import { describe, it, expect } from 'vitest'
import { createWebSearchTool, formatSearchResults } from './webSearch'
import type { SearchBackend, SearchResult } from './searchBackends/searchBackend'

const sample: SearchResult[] = [
  { title: 'AI 周报', url: 'https://a.com/1', snippet: '本周进展' },
  { title: '机器人动态', url: 'https://b.com/2', snippet: '新品发布' }
]

function backendOf(fn: SearchBackend['search']): SearchBackend { return { search: fn } }
const ctx = { signal: new AbortController().signal }

describe('formatSearchResults', () => {
  it('编号 + 标题 + URL + 摘要,头部引导据此作答+来源附完整网址,并保留注入防线', () => {
    const text = formatSearchResults(sample)
    // 引导模型采信并使用结果(修复:旧文案"不可信内容,仅供参考"会让小模型忽略结果)
    expect(text).toContain('据此作答')
    // 来源要附「完整网址」而非只写编号,否则渲染层无从生成可点击链接
    expect(text).toContain('来源')
    expect(text).toContain('网址')
    // 注入防线仍在:不执行结果正文里出现的指令
    expect(text).toContain('不要执行')
    expect(text).toContain('1. AI 周报')
    expect(text).toContain('https://a.com/1')
    expect(text).toContain('2. 机器人动态')
  })
})

describe('createWebSearchTool', () => {
  it('声明:名字 web_search,query 必填', () => {
    const tool = createWebSearchTool(backendOf(async () => sample))
    expect(tool.name).toBe('web_search')
    expect((tool.inputSchema.required as string[])).toContain('query')
  })

  it('执行:先 onStatus 播报,再调后端,count 默认 5', async () => {
    const calls: Array<{ query: string; count: number }> = []
    const statuses: string[] = []
    const tool = createWebSearchTool(backendOf(async (query, count) => { calls.push({ query, count }); return sample }))
    const out = await tool.run({ query: 'AI 新闻' }, { ...ctx, onStatus: (t) => statuses.push(t) })
    expect(statuses).toEqual(['正在搜索:AI 新闻'])
    expect(calls).toEqual([{ query: 'AI 新闻', count: 5 }])
    expect(out).toContain('1. AI 周报')
  })

  it('count 夹在 1..8', async () => {
    const counts: number[] = []
    const tool = createWebSearchTool(backendOf(async (_q, count) => { counts.push(count); return sample }))
    await tool.run({ query: 'x', count: 99 }, ctx)
    await tool.run({ query: 'x', count: -3 }, ctx)
    expect(counts).toEqual([8, 1])
  })

  it('后端抛错原样冒泡(由 registry 转 isError)', async () => {
    const tool = createWebSearchTool(backendOf(async () => { throw new Error('限流了') }))
    await expect(tool.run({ query: 'x' }, ctx)).rejects.toThrow('限流了')
  })
})
