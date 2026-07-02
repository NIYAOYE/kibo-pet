import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind } from '@shared/llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']

function normalize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const p = (r.provider ?? {}) as Record<string, unknown>
  const kind = KINDS.includes(p.kind as ProviderKind) ? (p.kind as ProviderKind) : DEFAULT_SETTINGS.provider.kind
  const model = typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_SETTINGS.provider.model
  const baseURL = typeof p.baseURL === 'string' && p.baseURL.length > 0 ? p.baseURL : undefined
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, provider: { kind, model, baseURL } }
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
