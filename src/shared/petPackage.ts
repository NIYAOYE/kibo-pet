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

export interface Live2DViewport { width: number; height: number; resolutionCap: number }
export interface Live2DTransform {
  scale: number; offsetX: number; offsetY: number
  anchorX: number; anchorY: number
  bubbleAnchorX: number; bubbleAnchorY: number
}
export interface Live2DInteraction { mirrorOnWalk: boolean; mouseTracking: boolean; lipSyncParameter: string }
export interface Live2DStateMapEntry {
  motionGroup?: string
  selection?: 'random' | 'sequential' | number
  loop?: boolean
  expression?: string
  lipSync?: boolean
  fallback?: string
  /** 给未来 LLM 状态选择机制读的自然语言描述;Phase 2 只存不用。 */
  description?: string
}
export interface Live2DRender {
  type: 'live2d'
  model: string
  viewport: Live2DViewport
  transform: Live2DTransform
  interaction: Live2DInteraction
  stateMap: Record<string, Live2DStateMapEntry>
}
export interface Live2DManifest {
  schemaVersion: 2
  id: string; displayName: string; description: string
  thumbnail?: string
  render: Live2DRender
}

/** 便宜的判别式检查,不做完整校验;用来决定该走哪个解析器。 */
export function isLive2DManifestRaw(raw: unknown): boolean {
  const r = raw as Record<string, any>
  return !!(r && typeof r === 'object' && r.render && typeof r.render === 'object' && r.render.type === 'live2d')
}

export function parseLive2DManifest(raw: unknown): Live2DManifest {
  const m = raw as Record<string, any>
  assert(m && typeof m === 'object', 'manifest must be an object')
  assert(m.schemaVersion === 2, 'manifest.schemaVersion must be 2 for a live2d package')
  for (const k of ['id', 'displayName', 'description']) {
    assert(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} must be a non-empty string`)
  }
  if (m.thumbnail !== undefined) {
    assert(typeof m.thumbnail === 'string' && m.thumbnail.length > 0, 'manifest.thumbnail must be a non-empty string when present')
  }
  const r = m.render
  assert(r && typeof r === 'object', 'manifest.render is required')
  assert(r.type === 'live2d', 'manifest.render.type must be "live2d"')
  assert(typeof r.model === 'string' && r.model.length > 0, 'manifest.render.model must be a non-empty string')

  const vp = r.viewport
  assert(vp && typeof vp === 'object', 'manifest.render.viewport is required')
  for (const k of ['width', 'height', 'resolutionCap']) {
    assert(typeof vp[k] === 'number' && vp[k] > 0, `manifest.render.viewport.${k} must be a positive number`)
  }

  const tr = r.transform
  assert(tr && typeof tr === 'object', 'manifest.render.transform is required')
  for (const k of ['scale', 'offsetX', 'offsetY', 'anchorX', 'anchorY', 'bubbleAnchorX', 'bubbleAnchorY']) {
    assert(typeof tr[k] === 'number', `manifest.render.transform.${k} must be a number`)
  }

  const it = r.interaction
  assert(it && typeof it === 'object', 'manifest.render.interaction is required')
  assert(typeof it.mirrorOnWalk === 'boolean', 'manifest.render.interaction.mirrorOnWalk must be a boolean')
  assert(typeof it.mouseTracking === 'boolean', 'manifest.render.interaction.mouseTracking must be a boolean')
  assert(typeof it.lipSyncParameter === 'string' && it.lipSyncParameter.length > 0, 'manifest.render.interaction.lipSyncParameter must be a non-empty string')

  const sm = r.stateMap
  assert(sm && typeof sm === 'object', 'manifest.render.stateMap is required (may be empty)')
  for (const key of Object.keys(sm)) {
    const e = sm[key]
    assert(e && typeof e === 'object', `manifest.render.stateMap.${key} must be an object`)
    if (e.motionGroup !== undefined) assert(typeof e.motionGroup === 'string', `manifest.render.stateMap.${key}.motionGroup must be a string`)
    if (e.selection !== undefined) assert(e.selection === 'random' || e.selection === 'sequential' || typeof e.selection === 'number', `manifest.render.stateMap.${key}.selection must be "random"/"sequential"/number`)
    if (e.loop !== undefined) assert(typeof e.loop === 'boolean', `manifest.render.stateMap.${key}.loop must be a boolean`)
    if (e.expression !== undefined) assert(typeof e.expression === 'string', `manifest.render.stateMap.${key}.expression must be a string`)
    if (e.lipSync !== undefined) assert(typeof e.lipSync === 'boolean', `manifest.render.stateMap.${key}.lipSync must be a boolean`)
    if (e.fallback !== undefined) assert(typeof e.fallback === 'string', `manifest.render.stateMap.${key}.fallback must be a string`)
    if (e.description !== undefined) assert(typeof e.description === 'string', `manifest.render.stateMap.${key}.description must be a string`)
  }

  return m as Live2DManifest
}

export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }
