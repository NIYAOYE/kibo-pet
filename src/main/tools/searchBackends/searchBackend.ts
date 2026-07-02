export interface SearchResult { title: string; url: string; snippet: string }

export interface SearchBackend {
  search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]>
}
