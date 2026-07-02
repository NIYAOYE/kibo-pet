import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings } from './settings'

describe('settings v1 → v2 迁移', () => {
  const dirs: string[] = []
  const tempFile = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-settings-'))
    dirs.push(dir)
    const file = join(dir, 'settings.json')
    writeFileSync(file, content, 'utf-8')
    return file
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('读 v1 文件(无 search)补默认 duckduckgo 并升到 v2', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 1,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    }))
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(2)
    expect(s.search).toEqual({ backend: 'duckduckgo' })
    expect(s.provider.model).toBe('deepseek-chat') // 原有字段不丢
  })

  it('v2 文件里的 tavily 选择被保留', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 2,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'tavily' }
    }))
    expect(loadSettings(file).search.backend).toBe('tavily')
  })

  it('非法 backend 值回退 duckduckgo', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 2,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'bing!!' }
    }))
    expect(loadSettings(file).search.backend).toBe('duckduckgo')
  })

  it('文件缺失时默认设置含 search 段', () => {
    const s = loadSettings(join(tmpdir(), 'definitely-missing', 'nope.json'))
    expect(s.search.backend).toBe('duckduckgo')
    expect(s.schemaVersion).toBe(2)
  })
})
