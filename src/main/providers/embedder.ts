import type { AppSettings } from '@shared/llm'

export interface Embedder {
  readonly model: string
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>
}

/** openai-compat 标准 POST /embeddings;key 由外部注入,本模块不落盘不打日志 */
export function createOpenAiCompatEmbedder(
  cfg: { baseURL: string; model: string; getKey: () => string | null },
  fetchFn: typeof fetch = fetch
): Embedder {
  return {
    model: cfg.model,
    async embed(texts, signal) {
      const key = cfg.getKey()
      if (!key) throw new Error('未配置 embedding API key')
      const url = `${cfg.baseURL.replace(/\/+$/, '')}/embeddings`
      const res = await fetchFn(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model, input: texts })
      })
      if (!res.ok) throw new Error(`embedding 请求失败(HTTP ${res.status})`)
      const data = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
      const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (items.length !== texts.length) throw new Error('embedding 返回条数与请求不符')
      return items.map((d) => {
        if (!Array.isArray(d.embedding)) throw new Error('embedding 返回格式不符')
        return d.embedding
      })
    }
  }
}

/** 决定性伪 embedding(字符码散列到固定维度),仅测试用 */
export function createFakeEmbedder(dims = 8): Embedder {
  return {
    model: 'fake-embedding',
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dims).fill(0)
        for (let i = 0; i < t.length; i++) v[i % dims] += t.charCodeAt(i) / 1000
        return v
      })
    }
  }
}

/** embedding key 解析:独立 key 优先;留空且与聊天 provider 同 baseURL 时复用聊天 key */
export function resolveEmbeddingKey(
  settings: AppSettings,
  embeddingKey: string | null,
  chatKey: string | null
): string | null {
  if (embeddingKey) return embeddingKey
  const emb = settings.memory.embedding
  if (emb && settings.provider.baseURL && settings.provider.baseURL === emb.baseURL) return chatKey
  return null
}
