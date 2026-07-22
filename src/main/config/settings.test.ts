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
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, activePetId: 'luluka', provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' }, search: { backend: 'duckduckgo' as const }, memory: { embedding: null }, textTools: { autoCopyResult: false }, firecrawl: { enabled: false }, desktopControl: { enabled: false }, browserControl: { enabled: false, mode: 'isolated' as const }, appFocusLlmOpener: { enabled: false }, gpuAcceleration: { experimental: false }, tts: DEFAULT_SETTINGS.tts, ttsGenie: DEFAULT_SETTINGS.ttsGenie, live2d: { mouseTrackingEnabled: true } }
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
  it('归一化后 schemaVersion 升为 15', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(15)
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
  it('归一化后 schemaVersion 升为 15', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(15)
  })
})

describe('appFocusLlmOpener', () => {
  it('缺省 → 默认 enabled:false', () => {
    const f = tmpSettingsFile({ schemaVersion: 10, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: false })
  })
  it('保留合法的 enabled:true', () => {
    const f = tmpSettingsFile({ appFocusLlmOpener: { enabled: true } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: true })
  })
  it('非法值(非 true) → 回退 false', () => {
    const f = tmpSettingsFile({ appFocusLlmOpener: { enabled: 'yes' } })
    expect(loadSettings(f).appFocusLlmOpener).toEqual({ enabled: false })
  })
})

describe('gpuAcceleration', () => {
  it('缺省 → 默认 experimental:false', () => {
    const f = tmpSettingsFile({ schemaVersion: 13, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: false })
  })
  it('保留合法的 experimental:true', () => {
    const f = tmpSettingsFile({ gpuAcceleration: { experimental: true } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: true })
  })
  it('非法值(非 true) → 回退 false', () => {
    const f = tmpSettingsFile({ gpuAcceleration: { experimental: 'yes' } })
    expect(loadSettings(f).gpuAcceleration).toEqual({ experimental: false })
  })
})

describe('ttsGenie', () => {
  it('缺省 → 默认 runtimeInstallPath 空字符串', () => {
    const f = tmpSettingsFile({ schemaVersion: 11, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: '' })
  })
  it('保留合法的 runtimeInstallPath', () => {
    const f = tmpSettingsFile({ ttsGenie: { runtimeInstallPath: 'D:/genie-runtime' } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: 'D:/genie-runtime' })
  })
  it('runtimeInstallPath 非字符串 → 回退空字符串', () => {
    const f = tmpSettingsFile({ ttsGenie: { runtimeInstallPath: 123 } })
    expect(loadSettings(f).ttsGenie).toEqual({ runtimeInstallPath: '' })
  })
  it('归一化后 schemaVersion 升为 15', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(15)
  })
})

describe('tts.backend', () => {
  it('缺省 → 默认 gsv-tts-lite', () => {
    const f = tmpSettingsFile({ schemaVersion: 12, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).tts.backend).toBe('gsv-tts-lite')
  })
  it('保留合法值 genie-tts', () => {
    const f = tmpSettingsFile({ tts: { backend: 'genie-tts' } })
    expect(loadSettings(f).tts.backend).toBe('genie-tts')
  })
  it('非法值 → 回退默认 gsv-tts-lite', () => {
    const f = tmpSettingsFile({ tts: { backend: 'not-a-real-backend' } })
    expect(loadSettings(f).tts.backend).toBe('gsv-tts-lite')
  })
})

describe('live2d.mouseTrackingEnabled', () => {
  it('缺省时默认 true', () => {
    const f = tmpSettingsFile({ schemaVersion: 1 })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(true)
  })

  it('显式 false 时保留 false', () => {
    const f = tmpSettingsFile({ schemaVersion: 1, live2d: { mouseTrackingEnabled: false } })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(false)
  })

  it('非法值(非 boolean)时回落默认 true', () => {
    const f = tmpSettingsFile({ schemaVersion: 1, live2d: { mouseTrackingEnabled: 'yes' } })
    expect(loadSettings(f).live2d.mouseTrackingEnabled).toBe(true)
  })
})
