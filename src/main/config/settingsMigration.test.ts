import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, normalizeSettings } from './settings'

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

  it('读 v1 文件(无 search)补默认 duckduckgo 并升到 v3', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 1,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    }))
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(6)
    expect(s.search).toEqual({ backend: 'duckduckgo' })
    expect(s.memory).toEqual({ embedding: null })
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

  it('文件缺失时默认设置含 search 和 memory 段', () => {
    const s = loadSettings(join(tmpdir(), 'definitely-missing', 'nope.json'))
    expect(s.search.backend).toBe('duckduckgo')
    expect(s.memory).toEqual({ embedding: null })
    expect(s.schemaVersion).toBe(6)
  })
})

describe('v2 -> v3 迁移(memory)', () => {
  const dirs: string[] = []
  const tempFile = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-settings-'))
    dirs.push(dir)
    const file = join(dir, 'settings.json')
    writeFileSync(file, content, 'utf-8')
    return file
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('v2 设置(无 memory)加载后补 memory.embedding = null,schemaVersion 升为 3', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 2,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      search: { backend: 'tavily' }
    }))
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(6)
    expect(s.memory).toEqual({ embedding: null })
    expect(s.provider.model).toBe('deepseek-chat') // 原字段不丢
    expect(s.search.backend).toBe('tavily')
  })

  it('合法 embedding 配置原样保留', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 3,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' } }
    }))
    expect(loadSettings(file).memory.embedding).toEqual({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3'
    })
  })

  it('embedding 缺 model 或 baseURL 为空 → 归一化为 null', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 3,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: { baseURL: 'https://x.example/v1' } }
    }))
    expect(loadSettings(file).memory.embedding).toBeNull()
  })
})

describe('MVP-08 textTools 迁移', () => {
  it('缺失 textTools 时补默认 autoCopyResult:false 且 schemaVersion 升到 6', () => {
    const out = normalizeSettings({
      schemaVersion: 4,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null }
    })
    expect(out.schemaVersion).toBe(6)
    expect(out.textTools).toEqual({ autoCopyResult: false })
  })

  it('保留已存的 autoCopyResult:true', () => {
    const out = normalizeSettings({ textTools: { autoCopyResult: true } })
    expect(out.textTools.autoCopyResult).toBe(true)
  })

  it('textTools 非法值退化为默认 false', () => {
    const out = normalizeSettings({ textTools: { autoCopyResult: 'yes' } })
    expect(out.textTools.autoCopyResult).toBe(false)
  })
})

describe('MVP-12 firecrawl 迁移', () => {
  it('缺失 firecrawl 时补默认 { enabled:false } 且 schemaVersion 升到 6', () => {
    const out = normalizeSettings({
      schemaVersion: 5,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false }
    })
    expect(out.schemaVersion).toBe(6)
    expect(out.firecrawl).toEqual({ enabled: false, baseURL: undefined })
  })

  it('保留已存的 enabled:true 与 baseURL', () => {
    const out = normalizeSettings({ firecrawl: { enabled: true, baseURL: 'https://self.host' } })
    expect(out.firecrawl.enabled).toBe(true)
    expect(out.firecrawl.baseURL).toBe('https://self.host')
  })

  it('enabled 非布尔退化 false;空 baseURL 归一为 undefined', () => {
    const out = normalizeSettings({ firecrawl: { enabled: 'yes', baseURL: '   ' } })
    expect(out.firecrawl.enabled).toBe(false)
    expect(out.firecrawl.baseURL).toBeUndefined()
  })
})
