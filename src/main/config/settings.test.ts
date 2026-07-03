import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '@shared/llm'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pet-settings-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('settings', () => {
  it('returns defaults when the file is missing', () => {
    expect(loadSettings(join(tmp(), 'settings.json'))).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips save then load', () => {
    const file = join(tmp(), 'settings.json')
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null } }
    saveSettings(file, s)
    expect(loadSettings(file)).toEqual(s)
  })

  it('fills missing provider fields and normalizes schemaVersion', () => {
    const file = join(tmp(), 'settings.json')
    saveSettings(file, { schemaVersion: 0, provider: { kind: 'anthropic', model: '' } } as never)
    const loaded = loadSettings(file)
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(loaded.provider.model).toBe(DEFAULT_SETTINGS.provider.model) // 空 model → 默认
  })

  it('returns defaults on malformed json', () => {
    const file = join(tmp(), 'settings.json')
    saveSettings(file, DEFAULT_SETTINGS)
    require('node:fs').writeFileSync(file, '{ not json', 'utf-8')
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })
})
