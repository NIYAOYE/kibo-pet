export interface PetSheet { rows: number; cols: number; cellWidth: number; cellHeight: number }
export interface PetAnimation { row: number; frames: number; fps: number; loop: boolean; durations?: number[] }
export interface PetVoice {
  refAudio: string; refText: string
  gptModel?: string; sovitsModel?: string
  onnxModel?: string
  /** Genie-TTS 后端专用:该角色模型/参考音频本身的语言,load_character 需要;GSV-TTS-Lite 后端不用这个字段(它按请求自动检测/强制)。onnxModel 存在时必填。 */
  language?: 'zh' | 'ja' | 'en'
}
export interface PetManifest {
  id: string; displayName: string; description: string; spritesheetPath: string
  sheet: PetSheet; animations: Record<string, PetAnimation>
  voice?: PetVoice
}
export interface FrameRect { x: number; y: number; w: number; h: number }

export function frameRect(sheet: PetSheet, row: number, col: number): FrameRect {
  return { x: col * sheet.cellWidth, y: row * sheet.cellHeight, w: sheet.cellWidth, h: sheet.cellHeight }
}

export function frameDurationMs(anim: PetAnimation, index: number): number {
  if (anim.durations && anim.durations[index] != null) return anim.durations[index]
  return Math.round(1000 / anim.fps)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

export function parsePetManifest(raw: unknown): PetManifest {
  const m = raw as Record<string, any>
  assert(m && typeof m === 'object', 'manifest must be an object')
  for (const k of ['id', 'displayName', 'description', 'spritesheetPath']) {
    assert(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} must be a non-empty string`)
  }
  const s = m.sheet
  assert(s && typeof s === 'object', 'manifest.sheet is required')
  for (const k of ['rows', 'cols', 'cellWidth', 'cellHeight']) {
    assert(typeof s[k] === 'number' && s[k] > 0, `manifest.sheet.${k} must be a positive number`)
  }
  assert(m.animations && typeof m.animations === 'object', 'manifest.animations is required')
  const animKeys = Object.keys(m.animations)
  assert(animKeys.length > 0, 'manifest.animations must not be empty')
  for (const key of animKeys) {
    const a = m.animations[key]
    for (const k of ['row', 'frames', 'fps']) {
      assert(typeof a[k] === 'number', `animation ${key}.${k} must be a number`)
    }
    assert(typeof a.loop === 'boolean', `animation ${key}.loop must be a boolean`)
  }
  if (m.voice !== undefined) {
    const v = m.voice
    assert(v && typeof v === 'object', 'manifest.voice must be an object when present')
    for (const k of ['refAudio', 'refText']) {
      assert(typeof v[k] === 'string' && v[k].length > 0, `manifest.voice.${k} must be a non-empty string`)
    }
    const hasGpt = typeof v.gptModel === 'string' && v.gptModel.length > 0
    const hasSovits = typeof v.sovitsModel === 'string' && v.sovitsModel.length > 0
    assert(hasGpt === hasSovits, 'manifest.voice.gptModel and sovitsModel must both be present or both be absent')
    const hasOnnx = typeof v.onnxModel === 'string' && v.onnxModel.length > 0
    assert(hasGpt || hasOnnx, 'manifest.voice must provide either onnxModel or both gptModel/sovitsModel')
    if (hasOnnx) {
      assert(v.language === 'zh' || v.language === 'ja' || v.language === 'en', 'manifest.voice.language must be zh/ja/en when onnxModel is present')
    }
  }
  return m as PetManifest
}
