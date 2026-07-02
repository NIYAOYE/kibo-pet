import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDuckDuckGoHtml, createDuckDuckGoBackend } from './duckduckgo'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'ddg.html'), 'utf-8')

describe('parseDuckDuckGoHtml', () => {
  it('解析出标题/URL/摘要,uddg 跳转链接还原为真实 URL,HTML 实体与标签清理', () => {
    const results = parseDuckDuckGoHtml(fixture)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'AI 新闻速递 & 周报',
      url: 'https://example.com/ai-news',
      snippet: '本周 AI 领域重要进展汇总,覆盖大模型与机器人。'
    })
    expect(results[1].url).toBe('https://direct.example.org/page')
  })

  it('坏 HTML / 无结果页返回空数组', () => {
    expect(parseDuckDuckGoHtml('<html><body>No results.</body></html>')).toEqual([])
    expect(parseDuckDuckGoHtml('')).toEqual([])
  })
})

describe('createDuckDuckGoBackend', () => {
  const okFetch = (body: string, status = 200): typeof fetch =>
    (async () => new Response(body, { status })) as typeof fetch

  it('请求带 q 参数与浏览器 UA,结果截断到 count', async () => {
    let captured: { url: string; ua: string } | null = null
    const fetchFn: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), ua: String((init?.headers as Record<string, string>)['User-Agent']) }
      return new Response(fixture, { status: 200 })
    }) as typeof fetch
    const results = await createDuckDuckGoBackend(fetchFn).search('AI 新闻', 1, new AbortController().signal)
    expect(results).toHaveLength(1)
    expect(captured!.url).toContain('html.duckduckgo.com/html/?q=AI%20%E6%96%B0%E9%97%BB')
    expect(captured!.ua).toContain('Mozilla/5.0')
  })

  it('HTTP 非 200 抛人话错误', async () => {
    await expect(createDuckDuckGoBackend(okFetch('', 429)).search('x', 5, new AbortController().signal))
      .rejects.toThrow(/429/)
  })

  it('解析为空抛「没有找到」错误(接口变动/限流可感知)', async () => {
    await expect(createDuckDuckGoBackend(okFetch('<html></html>')).search('x', 5, new AbortController().signal))
      .rejects.toThrow(/没有找到/)
  })
})
