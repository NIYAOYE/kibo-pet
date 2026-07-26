import {
  classifyVisibleParameters,
  type Live2DCapabilitySnapshot,
  type Live2DParameterCapability,
  type Live2DPerformanceInstruction
} from '@shared/live2dPerformance'
import type { Live2DManifest } from '@shared/petPackage'
import { performanceWeightAt, type ActivePerformanceLayer } from './live2dPerformanceLayer'
import type { ExpressionDefinition } from './live2dAutoSetup'
import type { ResolvedMotion } from './live2dStateMapResolver'

/** FocusController drives these on every model update; performances must never compete with mouse tracking. */
const FOCUS_CONTROLLER_PARAMETER_IDS = new Set([
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamEyeBallX',
  'ParamEyeBallY'
])

interface CubismCoreParameterId {
  getString(): { s: string }
}

/** The documented Core parameter methods needed by the performance overlay. */
export interface CubismCoreParameterApi {
  getParameterCount(): number
  getParameterId(index: number): CubismCoreParameterId
  getParameterMinimumValue(index: number): number
  getParameterMaximumValue(index: number): number
  getParameterDefaultValue(index: number): number
  setParameterValueByIndex(index: number, value: number, weight?: number): void
}

export interface CollectedLive2DCapabilities {
  snapshot: Live2DCapabilitySnapshot
  parameterIndexes: Map<string, number>
}

/** The engine emits this immediately after baseline parameter work and before Core.model.update(). */
export interface PerformancePostBaselineEmitter {
  on(event: 'beforeModelUpdate', listener: () => void): unknown
  off(event: 'beforeModelUpdate', listener: () => void): unknown
}

/** Enumerates only Core controls that the shared visibility classifier permits. */
export function collectLive2DCapabilities(
  manifest: Live2DManifest,
  core: CubismCoreParameterApi,
  definitions: readonly ExpressionDefinition[] | undefined
): CollectedLive2DCapabilities {
  const all: Live2DParameterCapability[] = []
  const indexes = new Map<string, number>()
  for (let index = 0; index < core.getParameterCount(); index += 1) {
    const id = core.getParameterId(index).getString().s
    all.push({
      id,
      min: core.getParameterMinimumValue(index),
      max: core.getParameterMaximumValue(index),
      defaultValue: core.getParameterDefaultValue(index)
    })
    indexes.set(id, index)
  }

  const parameters = classifyVisibleParameters(all)
    .filter((parameter) => !FOCUS_CONTROLLER_PARAMETER_IDS.has(parameter.id))
  const parameterIndexes = new Map(parameters.map((parameter) => [parameter.id, indexes.get(parameter.id)!]))
  return {
    snapshot: {
      petId: manifest.id,
      expressions: (definitions ?? []).map((definition) => definition.Name),
      parameters
    },
    parameterIndexes
  }
}

export function collectLive2DCapabilitySnapshot(
  manifest: Live2DManifest,
  core: CubismCoreParameterApi,
  definitions: readonly ExpressionDefinition[] | undefined
): Live2DCapabilitySnapshot {
  return collectLive2DCapabilities(manifest, core, definitions).snapshot
}

/** Registers the overlay inside the engine's model-update phase, not on Pixi's pre-render ticker. */
export function attachPerformanceAfterBaseline(
  internalModel: PerformancePostBaselineEmitter,
  applyOverlay: () => void
): () => void {
  internalModel.on('beforeModelUpdate', applyOverlay)
  return () => { internalModel.off('beforeModelUpdate', applyOverlay) }
}

/** Executes the declared parts of a resolved state without inventing a motion for expression-only entries. */
export async function playResolvedState(
  resolved: ResolvedMotion,
  startMotion: (resolved: ResolvedMotion) => Promise<boolean>,
  playExpression: (expression: string) => void
): Promise<{ motionAttempted: boolean; motionSucceeded: boolean }> {
  const motionAttempted = Boolean(resolved.motionGroup)
  let motionSucceeded = false
  try {
    if (motionAttempted) motionSucceeded = await startMotion(resolved)
  } finally {
    if (resolved.expression) playExpression(resolved.expression)
  }
  return { motionAttempted, motionSucceeded }
}

/** Replaces the sole active performance; there are deliberately no queues or concurrent layers. */
export function replaceActivePerformanceLayer(
  _previous: ActivePerformanceLayer | null,
  instruction: Live2DPerformanceInstruction,
  startedAtMs: number
): ActivePerformanceLayer {
  return { instruction, startedAtMs }
}

/** Applies the active layer after the normal Cubism baseline update. */
export function applyActivePerformanceLayer(
  layer: ActivePerformanceLayer | null,
  core: CubismCoreParameterApi,
  parameterIndexes: ReadonlyMap<string, number>,
  lipSyncParameter: string,
  nowMs: number
): ActivePerformanceLayer | null {
  if (!layer) return null
  if (nowMs >= layer.startedAtMs + layer.instruction.durationMs) return null
  const envelope = performanceWeightAt(layer, nowMs)
  if (envelope === 0) return layer

  for (const parameter of layer.instruction.parameters) {
    if (parameter.id === lipSyncParameter || FOCUS_CONTROLLER_PARAMETER_IDS.has(parameter.id)) continue
    const index = parameterIndexes.get(parameter.id)
    if (index === undefined) continue
    core.setParameterValueByIndex(index, parameter.value, parameter.weight * envelope)
  }
  return layer
}
