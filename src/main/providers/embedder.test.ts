import { describe, it, expect, vi } from 'vitest'
import { createOpenAiCompatEmbedder, createFakeEmbedder, resolveEmbeddingKey } from './embedder'
import type { AppSettings } from '@shared/llm'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('createOpenAiCompatEmbedder', () => {
  const cfg = { baseURL: 'https://api.example.com/v1/', model: 'emb-1', getKey: () => 'sk-x' }

  it('POST {baseURL}/embeddings,带 Bearer key,按 index 排序返回向量', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] })
    )
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    const vectors = await emb.embed(['a', 'b'], new AbortController().signal)
    expect(vectors).toEqual([[1, 2], [3, 4]])
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/embeddings') // 尾斜杠被归一
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'emb-1', input: ['a', 'b'] })
  })

  it('无 key → 抛错', async () => {
    const emb = createOpenAiCompatEmbedder({ ...cfg, getKey: () => null })
    await expect(emb.embed(['a'], new AbortController().signal)).rejects.toThrow('key')
  })

  it('HTTP 非 2xx → 抛错(含状态码)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 401))
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    await expect(emb.embed(['a'], new AbortController().signal)).rejects.toThrow('401')
  })

  it('返回条数与请求不符 → 抛错', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1] }] }))
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    await expect(emb.embed(['a', 'b'], new AbortController().signal)).rejects.toThrow()
  })
})

describe('createFakeEmbedder', () => {
  it('决定性:同文本同向量,不同文本不同向量', async () => {
    const emb = createFakeEmbedder(4)
    const [a1] = await emb.embed(['你好'], new AbortController().signal)
    const [a2, b] = await emb.embed(['你好', '再见'], new AbortController().signal)
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
    expect(a1).toHaveLength(4)
  })
})

describe('resolveEmbeddingKey', () => {
  const base = (embBaseURL: string | null, chatBaseURL?: string): AppSettings => ({
    schemaVersion: 3,
    provider: { kind: 'openai-compat', baseURL: chatBaseURL, model: 'm' },
    search: { backend: 'duckduckgo' },
    memory: { embedding: embBaseURL ? { baseURL: embBaseURL, model: 'e' } : null }
  })
  it('有独立 key 优先用', () => {
    expect(resolveEmbeddingKey(base('https://a/v1', 'https://a/v1'), 'ek', 'ck')).toBe('ek')
  })
  it('无独立 key 且与聊天同 baseURL → 复用聊天 key', () => {
    expect(resolveEmbeddingKey(base('https://a/v1', 'https://a/v1'), null, 'ck')).toBe('ck')
  })
  it('无独立 key 且 baseURL 不同(或聊天无 baseURL,如 anthropic)→ null', () => {
    expect(resolveEmbeddingKey(base('https://b/v1', 'https://a/v1'), null, 'ck')).toBeNull()
    expect(resolveEmbeddingKey(base('https://b/v1', undefined), null, 'ck')).toBeNull()
  })
})
