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

  it('读 v1 文件(无 search)补默认 duckduckgo 并升到 v8', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 1,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    }))
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(10)
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
    expect(s.schemaVersion).toBe(10)
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

  it('v2 设置(无 memory)加载后补 memory.embedding = null,schemaVersion 升为 8', () => {
    const file = tempFile(JSON.stringify({
      schemaVersion: 2,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      search: { backend: 'tavily' }
    }))
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(10)
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
  it('缺失 textTools 时补默认 autoCopyResult:false 且 schemaVersion 升到 8', () => {
    const out = normalizeSettings({
      schemaVersion: 4,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null }
    })
    expect(out.schemaVersion).toBe(10)
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
  it('缺失 firecrawl 时补默认 { enabled:false } 且 schemaVersion 升到 8', () => {
    const out = normalizeSettings({
      schemaVersion: 5,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false }
    })
    expect(out.schemaVersion).toBe(10)
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

describe('desktopControl 迁移', () => {
  it('缺失 desktopControl 时补默认 { enabled:false } 且 schemaVersion 升到 8', () => {
    const out = normalizeSettings({
      schemaVersion: 6,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false },
      firecrawl: { enabled: false }
    })
    expect(out.schemaVersion).toBe(10)
    expect(out.desktopControl).toEqual({ enabled: false })
  })

  it('保留已存的 enabled:true', () => {
    const out = normalizeSettings({ desktopControl: { enabled: true } })
    expect(out.desktopControl.enabled).toBe(true)
  })

  it('enabled 非布尔退化为 false', () => {
    const out = normalizeSettings({ desktopControl: { enabled: 'yes' } })
    expect(out.desktopControl.enabled).toBe(false)
  })
})

describe('tts 迁移', () => {
  it('缺失 tts 时补齐 DEFAULT_TTS_SETTINGS 且 schemaVersion 升到 9', () => {
    const out = normalizeSettings({
      schemaVersion: 8,
      activePetId: 'luluka',
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: null },
      textTools: { autoCopyResult: false },
      firecrawl: { enabled: false },
      desktopControl: { enabled: false },
      browserControl: { enabled: false, mode: 'isolated' }
    })
    expect(out.schemaVersion).toBe(10)
    expect(out.tts).toEqual({
      enabled: false, runtimeInstallPath: '', device: 'auto', useFlashAttn: false,
      targetLanguage: 'auto', playbackTrigger: 'batch', synthesisChunking: 'sentence', textSplit: 'smart',
      isCutText: true, cutMinLen: 10, cutMute: 0.3,
      speed: 1, noiseScale: 0.5, temperature: 1, topK: 15, topP: 1, repetitionPenalty: 1.35
    })
  })

  it('保留已存的合法 tts 配置', () => {
    const out = normalizeSettings({
      tts: {
        enabled: true, runtimeInstallPath: 'D:\\voice-runtime', device: 'cuda', useFlashAttn: true,
        targetLanguage: 'ja', playbackTrigger: 'stream', synthesisChunking: 'token',
        isCutText: false, cutMinLen: 20, cutMute: 0.5,
        speed: 1.2, noiseScale: 0.4, temperature: 0.9, topK: 10, topP: 0.9, repetitionPenalty: 1.2
      }
    })
    expect(out.tts.enabled).toBe(true)
    expect(out.tts.runtimeInstallPath).toBe('D:\\voice-runtime')
    expect(out.tts.device).toBe('cuda')
    expect(out.tts.targetLanguage).toBe('ja')
    expect(out.tts.playbackTrigger).toBe('stream')
    expect(out.tts.synthesisChunking).toBe('token')
    expect(out.tts.speed).toBe(1.2)
  })

  it('非法枚举值退化为默认;非法数字退化为默认', () => {
    const out = normalizeSettings({
      tts: { device: 'quantum', targetLanguage: 'klingon', playbackTrigger: 'teleport', synthesisChunking: 'vibe', textSplit: 'quantum', speed: 'fast', topK: -1 }
    })
    expect(out.tts.device).toBe('auto')
    expect(out.tts.targetLanguage).toBe('auto')
    expect(out.tts.playbackTrigger).toBe('batch')
    expect(out.tts.synthesisChunking).toBe('sentence')
    expect(out.tts.textSplit).toBe('smart')
    expect(out.tts.speed).toBe(1)
    expect(out.tts.topK).toBe(15)
  })

  it('v9 设置(tts 无 textSplit)→ 补默认 smart,schemaVersion 升到 10', () => {
    const out = normalizeSettings({
      schemaVersion: 9,
      tts: {
        enabled: true, runtimeInstallPath: 'D:\\voice-runtime', device: 'cuda', useFlashAttn: false,
        targetLanguage: 'ja', playbackTrigger: 'stream', synthesisChunking: 'sentence',
        isCutText: true, cutMinLen: 10, cutMute: 0.3,
        speed: 1, noiseScale: 0.5, temperature: 1, topK: 15, topP: 1, repetitionPenalty: 1.35
      }
    })
    expect(out.schemaVersion).toBe(10)
    expect(out.tts.textSplit).toBe('smart')
    expect(out.tts.targetLanguage).toBe('ja') // 已有配置不受影响
  })

  it('已显式选了 sentence 切分的配置被保留,不被 smart 默认覆盖', () => {
    const out = normalizeSettings({ tts: { textSplit: 'sentence' } })
    expect(out.tts.textSplit).toBe('sentence')
  })
})
