import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface VectorEntry { factId: string; vector: number[] }
export interface VectorIndexFile { schemaVersion: 1; model: string; dims: number; entries: VectorEntry[] }

export function emptyIndex(model: string): VectorIndexFile {
  return { schemaVersion: 1, model, dims: 0, entries: [] }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function topKFactIds(query: number[], entries: VectorEntry[], k: number, threshold: number): string[] {
  return entries
    .map((e) => ({ id: e.factId, score: cosineSimilarity(query, e.vector) }))
    .filter((s) => s.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((s) => s.id)
}

export function missingFactIds(factIds: string[], index: VectorIndexFile): string[] {
  const have = new Set(index.entries.map((e) => e.factId))
  return factIds.filter((id) => !have.has(id))
}

/** dims 以首批向量为准;维度不符的丢弃(防脏数据污染召回) */
export function upsertVectors(index: VectorIndexFile, pairs: VectorEntry[]): VectorIndexFile {
  const dims = index.dims || pairs.find((p) => p.vector.length > 0)?.vector.length || 0
  const byId = new Map(index.entries.map((e) => [e.factId, e]))
  for (const p of pairs) {
    if (p.vector.length === dims && dims > 0) byId.set(p.factId, p)
  }
  return { schemaVersion: 1, model: index.model, dims, entries: [...byId.values()] }
}

/** schema/model 不符或数据损坏 → 空索引(权威源在 facts.json,索引可随时重建) */
export function parseIndex(raw: unknown, model: string): VectorIndexFile {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.schemaVersion !== 1 || r.model !== model || !Array.isArray(r.entries)) return emptyIndex(model)
  const dims = typeof r.dims === 'number' && r.dims > 0 ? Math.trunc(r.dims) : 0
  const entries = (r.entries as VectorEntry[]).filter(
    (e) =>
      e && typeof e.factId === 'string' && Array.isArray(e.vector) &&
      e.vector.length === dims && e.vector.every((n) => typeof n === 'number')
  )
  return { schemaVersion: 1, model, dims, entries }
}

export function loadIndexFor(file: string, model: string): VectorIndexFile {
  try {
    return parseIndex(JSON.parse(readFileSync(file, 'utf-8')), model)
  } catch {
    return emptyIndex(model)
  }
}

export function saveIndex(file: string, index: VectorIndexFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(index), 'utf-8')
  renameSync(tmp, file)
}
