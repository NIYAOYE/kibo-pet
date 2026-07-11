import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '@shared/llm'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pet-settings-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function tmpSettingsFile(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'petcfg-'))
  const f = join(dir, 'settings.json')
  writeFileSync(f, JSON.stringify(obj), 'utf-8')
  return f
}

describe('settings', () => {
  it('returns defaults when the file is missing', () => {
    expect(loadSettings(join(tmp(), 'settings.json'))).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips save then load', () => {
    const file = join(tmp(), 'settings.json')
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, tts: DEFAULT_SETTINGS.tts }
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

describe('activePetId', () => {
  it('v3 文件缺 activePetId → 补默认 luluka', () => {
    const f = tmpSettingsFile({ schemaVersion: 3, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('保留合法 activePetId', () => {
    const f = tmpSettingsFile({ activePetId: 'youka', provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).activePetId).toBe('youka')
  })
  it('非字符串 activePetId → 回退默认', () => {
    const f = tmpSettingsFile({ activePetId: 123 })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('含路径分隔/穿越的 activePetId → 回退默认(防路径穿越)', () => {
    const f = tmpSettingsFile({ activePetId: '../../evil' })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('归一化后 schemaVersion 升为 8', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(10)
  })
})

describe('browserControl', () => {
  it('缺省 browserControl → 默认 enabled:false, mode:isolated', () => {
    const f = tmpSettingsFile({ schemaVersion: 7, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: false, mode: 'isolated' })
  })
  it('mode 值非法(不是 isolated/cdp)→ 回退 isolated', () => {
    const f = tmpSettingsFile({ browserControl: { enabled: true, mode: 'weird' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: true, mode: 'isolated' })
  })
  it('保留合法的 cdp 模式', () => {
    const f = tmpSettingsFile({ browserControl: { enabled: true, mode: 'cdp' } })
    expect(loadSettings(f).browserControl).toEqual({ enabled: true, mode: 'cdp' })
  })
  it('chromePath 有非空字符串 → 去除首尾空白后保留', () => {
    const f = tmpSettingsFile({ browserControl: { enabled: true, mode: 'isolated', chromePath: '  C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe  ' } })
    expect(loadSettings(f).browserControl.chromePath).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })
  it('chromePath 缺省/空字符串/非字符串 → undefined', () => {
    expect(loadSettings(tmpSettingsFile({ browserControl: { enabled: true, mode: 'isolated' } })).browserControl.chromePath).toBeUndefined()
    expect(loadSettings(tmpSettingsFile({ browserControl: { enabled: true, mode: 'isolated', chromePath: '   ' } })).browserControl.chromePath).toBeUndefined()
    expect(loadSettings(tmpSettingsFile({ browserControl: { enabled: true, mode: 'isolated', chromePath: 123 } })).browserControl.chromePath).toBeUndefined()
  })
  it('归一化后 schemaVersion 升为 8', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(10)
  })
})
