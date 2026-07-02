import type { SearchBackend, SearchResult } from './searchBackend'

const ENDPOINT = 'https://html.duckduckgo.com/html/'
// 常规浏览器 UA:DDG 的 html 端点对无 UA/爬虫 UA 更容易限流
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** DDG 结果链接是 //duckduckgo.com/l/?uddg=<encoded>&rut=... 跳转包装,还原真实 URL */
function realUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : href
}

/**
 * 从 html.duckduckgo.com/html 结果页抽取结构化结果。
 * 字符串级抽取(不引 DOM 库):result__a 是标题链接,result__snippet 是摘要,按出现顺序配对。
 * 页面结构变动时此函数是唯一要改的地方(fixture 单测钉住当前结构)。
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
  return links.map((link, i) => ({
    title: decodeEntities(stripTags(link[2])).trim(),
    url: realUrl(decodeEntities(link[1])),
    snippet: decodeEntities(stripTags(snippets[i]?.[1] ?? '')).trim()
  }))
}

export function createDuckDuckGoBackend(fetchFn: typeof fetch = fetch): SearchBackend {
  return {
    async search(query, count, signal) {
      const res = await fetchFn(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
        signal,
        headers: { 'User-Agent': USER_AGENT }
      })
      if (!res.ok) throw new Error(`搜索请求失败(HTTP ${res.status})`)
      const items = parseDuckDuckGoHtml(await res.text())
      if (items.length === 0) throw new Error('没有找到搜索结果(接口可能变动或被限流,可稍后再试或在设置中切换 Tavily)')
      return items.slice(0, count)
    }
  }
}
