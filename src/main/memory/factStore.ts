import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Fact { id: string; text: string; createdAt: string; updatedAt: string }
export interface FactsFile { schemaVersion: 1; facts: Fact[] }

export function normalizeFactText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function parseFacts(raw: unknown): FactsFile {
  const r = (raw ?? {}) as Record<string, unknown>
  const facts = Array.isArray(r.facts)
    ? (r.facts as Fact[]).filter(
        (f) =>
          f && typeof f.id === 'string' && typeof f.text === 'string' && f.text.length > 0 &&
          typeof f.createdAt === 'string' && typeof f.updatedAt === 'string'
      )
    : []
  return { schemaVersion: 1, facts: facts.map((f) => ({ id: f.id, text: f.text, createdAt: f.createdAt, updatedAt: f.updatedAt })) }
}

export function newFactId(rand: () => number = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')
  return `f_${Date.now().toString(36)}_${suffix}`
}

/** §7.4 MVP 判重:规范化文本完全相同 → 更新 updatedAt 而非新增 */
export function upsertFact(
  file: FactsFile, text: string, now: string, id: string
): { file: FactsFile; fact: Fact; deduped: boolean } {
  const norm = normalizeFactText(text)
  const existing = file.facts.find((f) => normalizeFactText(f.text) === norm)
  if (existing) {
    const fact: Fact = { ...existing, updatedAt: now }
    return { file: { schemaVersion: 1, facts: file.facts.map((f) => (f.id === existing.id ? fact : f)) }, fact, deduped: true }
  }
  const fact: Fact = { id, text: norm, createdAt: now, updatedAt: now }
  return { file: { schemaVersion: 1, facts: [...file.facts, fact] }, fact, deduped: false }
}

export function loadFacts(path: string): FactsFile {
  try {
    return parseFacts(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { schemaVersion: 1, facts: [] }
  }
}

export function saveFacts(path: string, file: FactsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
  renameSync(tmp, path)
}
