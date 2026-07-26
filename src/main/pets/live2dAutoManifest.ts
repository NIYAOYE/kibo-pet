import { createHash } from 'node:crypto'
import { isLive2DManifestRaw, parseLive2DManifest, type Live2DManifest } from '@shared/petPackage'
import type { ImportReason } from '@shared/ipc'

export interface AutoLive2DManifestOptions {
  folderName: string
  modelPaths: readonly string[]
  occupiedIds: ReadonlySet<string>
}

export type AutoLive2DManifestResult =
  | null
  | { ok: true; mode: 'generated' | 'completed'; manifest: Live2DManifest; completedFields: string[] }
  | { ok: false; reason: ImportReason; message: string }

const DEFAULT_VIEWPORT = { width: 360, height: 480, resolutionCap: 1.5 }
const DEFAULT_TRANSFORM = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  anchorX: 0.5,
  anchorY: 1,
  bubbleAnchorX: 0.5,
  bubbleAnchorY: 0,
  autoFitted: false
}
const DEFAULT_INTERACTION = {
  mirrorOnWalk: false,
  mouseTracking: true,
  lipSyncParameter: 'ParamMouthOpenY'
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function displayNameForModel(modelPath: string, folderName: string): string {
  const fileName = modelPath.split(/[\\/]/).pop() ?? ''
  const name = fileName.replace(/\.model3\.json$/i, '')
  return name || folderName || 'Live2D'
}

function generatedId(folderName: string, modelPath: string, occupiedIds: ReadonlySet<string>): string {
  const base = folderName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'live2d'
  const occupied = new Set([...occupiedIds].map((id) => id.toLowerCase()))
  if (!occupied.has(base)) return base

  const hashed = `${base}-${createHash('sha256').update(modelPath).digest('hex').slice(0, 8)}`
  let candidate = hashed
  let suffix = 2
  while (occupied.has(candidate)) {
    candidate = `${hashed}-${suffix}`
    suffix += 1
  }
  return candidate
}

function modelFailure(modelPaths: readonly string[]): Extract<AutoLive2DManifestResult, { ok: false }> | undefined {
  if (modelPaths.length === 1) return undefined
  const reason: ImportReason = modelPaths.length === 0 ? 'missing-live2d-model' : 'ambiguous-live2d-model'
  const message = modelPaths.length === 0
    ? '未找到 Live2D 模型文件(.model3.json)。'
    : `找到多个 Live2D 模型文件:${modelPaths.join('、')}。`
  return { ok: false, reason, message }
}

function completeObject(
  target: UnknownRecord,
  key: string,
  defaults: UnknownRecord,
  path: string,
  completedFields: string[]
): unknown {
  const current = target[key]
  if (current === undefined) {
    completedFields.push(path)
    return { ...defaults }
  }
  if (!isRecord(current)) return current

  const completed = { ...current }
  for (const [key, value] of Object.entries(defaults)) {
    if (completed[key] === undefined) {
      completed[key] = value
      completedFields.push(`${path}.${key}`)
    }
  }
  return completed
}

/**
 * Builds a minimal valid manifest for a raw Live2D import, or fills only the
 * omitted fields of an existing Live2D manifest. Present invalid values are
 * deliberately preserved so the shared manifest parser remains authoritative.
 */
export function resolveAutoLive2DManifest(raw: unknown, options: AutoLive2DManifestOptions): AutoLive2DManifestResult {
  const isGenerated = raw === undefined
  if (!isGenerated && !isLive2DManifestRaw(raw)) return null

  const rawRecord: UnknownRecord = isGenerated ? {} : raw as UnknownRecord
  const rawRender = rawRecord.render
  if (!isGenerated && !isRecord(rawRender)) return invalidManifest(rawRecord)

  const render: UnknownRecord = isGenerated ? { type: 'live2d' } : { ...(rawRender as UnknownRecord) }
  const needsModel = render.model === undefined
  const modelError = needsModel ? modelFailure(options.modelPaths) : undefined
  if (modelError) return modelError

  const model = needsModel ? options.modelPaths[0] : render.model
  if (needsModel) render.model = model
  const labelModel = typeof model === 'string' && model.length > 0 ? model : options.modelPaths[0]
  const displayName = displayNameForModel(labelModel ?? '', options.folderName)
  const completedFields: string[] = []

  const manifest: UnknownRecord = isGenerated
    ? {
        schemaVersion: 2,
        id: generatedId(options.folderName, options.modelPaths[0], options.occupiedIds),
        displayName,
        description: displayName,
        render
      }
    : { ...rawRecord, render }

  if (!isGenerated) {
    if (manifest.schemaVersion === undefined) {
      manifest.schemaVersion = 2
      completedFields.push('schemaVersion')
    }
    if (manifest.id === undefined) {
      manifest.id = generatedId(options.folderName, typeof model === 'string' ? model : options.modelPaths[0] ?? '', options.occupiedIds)
      completedFields.push('id')
    }
    if (manifest.displayName === undefined) {
      manifest.displayName = displayName
      completedFields.push('displayName')
    }
    if (manifest.description === undefined) {
      manifest.description = displayName
      completedFields.push('description')
    }
    if (needsModel) completedFields.push('render.model')
  }

  render.viewport = completeObject(render, 'viewport', DEFAULT_VIEWPORT, 'render.viewport', completedFields)
  render.transform = completeObject(render, 'transform', DEFAULT_TRANSFORM, 'render.transform', completedFields)
  render.interaction = completeObject(render, 'interaction', DEFAULT_INTERACTION, 'render.interaction', completedFields)
  if (render.stateMap === undefined) {
    render.stateMap = {}
    if (!isGenerated) completedFields.push('render.stateMap')
  }

  try {
    const parsed = parseLive2DManifest(manifest)
    return {
      ok: true,
      mode: isGenerated ? 'generated' : 'completed',
      manifest: parsed,
      completedFields: isGenerated ? ['pet.json'] : completedFields
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-manifest',
      message: error instanceof Error ? error.message : 'The Live2D manifest is invalid.'
    }
  }
}

function invalidManifest(raw: UnknownRecord): Extract<AutoLive2DManifestResult, { ok: false }> {
  try {
    parseLive2DManifest(raw)
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-manifest',
      message: error instanceof Error ? error.message : 'The Live2D manifest is invalid.'
    }
  }
  return { ok: false, reason: 'invalid-manifest', message: 'The Live2D manifest is invalid.' }
}
