import type { SearchBackend, SearchResult } from './searchBackend'

const ENDPOINT = 'https://api.tavily.com/search'

export function mapTavilyResults(data: unknown): SearchResult[] {
  const results = ((data ?? {}) as { results?: Array<{ title?: string; url?: string; content?: string }> }).results ?? []
  return results.map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
}

/** key 由外部注入(来自 tavily secret store),本模块不落盘不打日志 */
export function createTavilyBackend(getKey: () => string | null, fetchFn: typeof fetch = fetch): SearchBackend {
  return {
    async search(query, count, signal) {
      const key = getKey()
      if (!key) throw new Error('未配置 Tavily API key:请在设置的「搜索」里填写,或切回免费搜索')
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: count })
      })
      if (!res.ok) throw new Error(`Tavily 请求失败(HTTP ${res.status}),请检查 key 是否有效`)
      return mapTavilyResults(await res.json())
    }
  }
}
