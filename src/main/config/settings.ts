import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind, SearchBackendKind, type MemorySettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit } from '@shared/llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']
const BACKENDS: SearchBackendKind[] = ['duckduckgo', 'tavily']
const TTS_DEVICES: TtsDevice[] = ['auto', 'cuda', 'cpu']
const TTS_TARGET_LANGUAGES: TtsTargetLanguage[] = ['auto', 'zh', 'ja', 'en']
const TTS_PLAYBACK_TRIGGERS: TtsPlaybackTrigger[] = ['batch', 'stream']
const TTS_SYNTHESIS_CHUNKINGS: TtsSynthesisChunking[] = ['token', 'sentence']
const TTS_TEXT_SPLITS: TtsTextSplit[] = ['sentence', 'smart']

function normalizeNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** 合法宠物 id:仅字母数字下划线连字符,拒绝路径分隔/穿越(activePetId 会拼进文件路径)。 */
function normalizePetId(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) ? v : DEFAULT_SETTINGS.activePetId
}

export function normalizeSettings(raw: unknown): AppSettings {
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
  const tt = (r.textTools ?? {}) as Record<string, unknown>
  const autoCopyResult = tt.autoCopyResult === true
  const fc = (r.firecrawl ?? {}) as Record<string, unknown>
  const firecrawl = {
    enabled: fc.enabled === true,
    baseURL: typeof fc.baseURL === 'string' && fc.baseURL.trim().length > 0 ? fc.baseURL.trim() : undefined
  }
  const dc = (r.desktopControl ?? {}) as Record<string, unknown>
  const desktopControl = { enabled: dc.enabled === true }
  const bc = (r.browserControl ?? {}) as Record<string, unknown>
  const browserControl = {
    enabled: bc.enabled === true,
    mode: bc.mode === 'cdp' ? 'cdp' as const : 'isolated' as const,
    chromePath: typeof bc.chromePath === 'string' && bc.chromePath.trim().length > 0 ? bc.chromePath.trim() : undefined
  }
  const tt2 = (r.tts ?? {}) as Record<string, unknown>
  const tts = {
    enabled: tt2.enabled === true,
    runtimeInstallPath: typeof tt2.runtimeInstallPath === 'string' ? tt2.runtimeInstallPath : DEFAULT_SETTINGS.tts.runtimeInstallPath,
    device: TTS_DEVICES.includes(tt2.device as TtsDevice) ? (tt2.device as TtsDevice) : DEFAULT_SETTINGS.tts.device,
    useFlashAttn: tt2.useFlashAttn === true,
    targetLanguage: TTS_TARGET_LANGUAGES.includes(tt2.targetLanguage as TtsTargetLanguage) ? (tt2.targetLanguage as TtsTargetLanguage) : DEFAULT_SETTINGS.tts.targetLanguage,
    playbackTrigger: TTS_PLAYBACK_TRIGGERS.includes(tt2.playbackTrigger as TtsPlaybackTrigger) ? (tt2.playbackTrigger as TtsPlaybackTrigger) : DEFAULT_SETTINGS.tts.playbackTrigger,
    synthesisChunking: TTS_SYNTHESIS_CHUNKINGS.includes(tt2.synthesisChunking as TtsSynthesisChunking) ? (tt2.synthesisChunking as TtsSynthesisChunking) : DEFAULT_SETTINGS.tts.synthesisChunking,
    textSplit: TTS_TEXT_SPLITS.includes(tt2.textSplit as TtsTextSplit) ? (tt2.textSplit as TtsTextSplit) : DEFAULT_SETTINGS.tts.textSplit,
    isCutText: tt2.isCutText === undefined ? DEFAULT_SETTINGS.tts.isCutText : tt2.isCutText === true,
    cutMinLen: normalizeNumber(tt2.cutMinLen, DEFAULT_SETTINGS.tts.cutMinLen),
    cutMute: normalizeNumber(tt2.cutMute, DEFAULT_SETTINGS.tts.cutMute),
    speed: normalizeNumber(tt2.speed, DEFAULT_SETTINGS.tts.speed),
    noiseScale: normalizeNumber(tt2.noiseScale, DEFAULT_SETTINGS.tts.noiseScale),
    temperature: normalizeNumber(tt2.temperature, DEFAULT_SETTINGS.tts.temperature),
    topK: tt2.topK !== undefined && typeof tt2.topK === 'number' && Number.isFinite(tt2.topK) && tt2.topK >= 0 ? tt2.topK : DEFAULT_SETTINGS.tts.topK,
    topP: normalizeNumber(tt2.topP, DEFAULT_SETTINGS.tts.topP),
    repetitionPenalty: normalizeNumber(tt2.repetitionPenalty, DEFAULT_SETTINGS.tts.repetitionPenalty)
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding },
    textTools: { autoCopyResult },
    firecrawl,
    desktopControl,
    browserControl,
    tts
  }
}

export function loadSettings(file: string): AppSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf-8')))
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
