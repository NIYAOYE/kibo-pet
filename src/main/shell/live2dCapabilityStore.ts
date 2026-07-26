import type { Live2DCapabilitySnapshot, Live2DParameterCapability } from '@shared/live2dPerformance'

export interface Live2DCapabilityStore {
  activate(petId: string, epoch: string): void
  report(snapshot: Live2DCapabilitySnapshot, epoch: string): boolean
  current(): Live2DCapabilitySnapshot | null
  clear(petId: string, epoch: string): boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseParameter(value: unknown): Live2DParameterCapability | null {
  if (!isRecord(value)
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.min !== 'number' || !Number.isFinite(value.min)
    || typeof value.max !== 'number' || !Number.isFinite(value.max)
    || typeof value.defaultValue !== 'number' || !Number.isFinite(value.defaultValue)
    || value.min > value.max
    || value.defaultValue < value.min || value.defaultValue > value.max
    || (value.name !== undefined && typeof value.name !== 'string')
    || (value.group !== undefined && typeof value.group !== 'string')) return null

  const parameter: Live2DParameterCapability = {
    id: value.id,
    min: value.min,
    max: value.max,
    defaultValue: value.defaultValue
  }
  if (value.name !== undefined) parameter.name = value.name
  if (value.group !== undefined) parameter.group = value.group
  return parameter
}

/** Parses the renderer IPC boundary without trusting context-isolated input. */
export function parseLive2DCapabilitySnapshot(value: unknown): Live2DCapabilitySnapshot | null {
  if (!isRecord(value)
    || typeof value.petId !== 'string' || value.petId.length === 0
    || !Array.isArray(value.expressions) || !value.expressions.every((expression) => typeof expression === 'string')
    || !Array.isArray(value.parameters)) return null

  const parameters: Live2DParameterCapability[] = []
  for (const rawParameter of value.parameters) {
    const parameter = parseParameter(rawParameter)
    if (!parameter) return null
    parameters.push(parameter)
  }
  return { petId: value.petId, expressions: [...value.expressions], parameters }
}

export function createLive2DCapabilityStore(): Live2DCapabilityStore {
  let activePetId: string | undefined
  let activeEpoch: string | undefined
  let snapshot: Live2DCapabilitySnapshot | null = null

  return {
    activate(petId, epoch): void {
      activePetId = petId
      activeEpoch = epoch
      snapshot = null
    },
    report(next, epoch): boolean {
      if (next.petId !== activePetId || epoch !== activeEpoch) return false
      snapshot = next
      return true
    },
    current(): Live2DCapabilitySnapshot | null {
      return snapshot
    },
    clear(petId, epoch): boolean {
      if (petId !== activePetId || epoch !== activeEpoch) return false
      snapshot = null
      return true
    }
  }
}
