import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings } from '@shared/llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']
const BACKENDS: SearchBackendKind[] = ['duckduckgo', 'tavily']

function normalize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const p = (r.provider ?? {}) as Record<string, unknown>
  const kind = KINDS.includes(p.kind as ProviderKind) ? (p.kind as ProviderKind) : DEFAULT_SETTINGS.provider.kind
  const model = typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_SETTINGS.provider.model
  const baseURL = typeof p.baseURL === 'string' && p.baseURL.length > 0 ? p.baseURL : undefined
  const s = (r.search ?? {}) as Record<string, unknown>
  const backend = BACKENDS.includes(s.backend as SearchBackendKind)
    ? (s.backend as SearchBackendKind)
    : DEFAULT_SETTINGS.search.backend
  const m = (r.memory ?? {}) as Record<string, unknown>
  const e = (m.embedding ?? null) as Record<string, unknown> | null
  const embedding =
    e && typeof e.baseURL === 'string' && e.baseURL.length > 0 &&
    typeof e.model === 'string' && e.model.length > 0
      ? { baseURL: e.baseURL, model: e.model }
      : null
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, provider: { kind, model, baseURL }, search: { backend }, memory: { embedding } }
}

export function loadSettings(file: string): AppSettings {
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8')
  renameSync(tmp, file)
}
