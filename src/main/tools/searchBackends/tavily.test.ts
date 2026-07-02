import { describe, it, expect } from 'vitest'
import { createTavilyBackend, mapTavilyResults } from './tavily'

describe('mapTavilyResults', () => {
  it('样例响应映射为 SearchResult[]', () => {
    expect(mapTavilyResults({
      results: [
        { title: 'AI 周报', url: 'https://a.com', content: '本周进展……', score: 0.98 },
        { title: '缺字段的', url: 'https://b.com' }
      ]
    })).toEqual([
      { title: 'AI 周报', url: 'https://a.com', snippet: '本周进展……' },
      { title: '缺字段的', url: 'https://b.com', snippet: '' }
    ])
  })
  it('无 results 字段返回空数组', () => {
    expect(mapTavilyResults({})).toEqual([])
    expect(mapTavilyResults(null)).toEqual([])
  })
})

describe('createTavilyBackend', () => {
  it('未配 key 直接抛可读错误,不发请求', async () => {
    let fetched = false
    const fetchFn: typeof fetch = (async () => { fetched = true; return new Response('{}') }) as typeof fetch
    await expect(createTavilyBackend(() => null, fetchFn).search('x', 5, new AbortController().signal))
      .rejects.toThrow(/Tavily/)
    expect(fetched).toBe(false)
  })

  it('POST 到 api.tavily.com,带 api_key/query/max_results', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null
    const fetchFn: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'u', content: 'c' }] }), { status: 200 })
    }) as typeof fetch
    const results = await createTavilyBackend(() => 'tvly-key', fetchFn).search('AI 新闻', 3, new AbortController().signal)
    expect(results).toHaveLength(1)
    expect(captured!.url).toBe('https://api.tavily.com/search')
    expect(captured!.body).toMatchObject({ api_key: 'tvly-key', query: 'AI 新闻', max_results: 3 })
  })

  it('HTTP 非 200 抛人话错误', async () => {
    const fetchFn: typeof fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    await expect(createTavilyBackend(() => 'bad', fetchFn).search('x', 5, new AbortController().signal))
      .rejects.toThrow(/401/)
  })
})
