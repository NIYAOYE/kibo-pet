export interface Live2DParameterCapability {
  id: string
  min: number
  max: number
  defaultValue: number
  name?: string
  group?: string
}

export interface Live2DCapabilitySnapshot {
  petId: string
  expressions: string[]
  parameters: Live2DParameterCapability[]
}

export interface Live2DPerformanceInstruction {
  expression?: string
  parameters: Array<{ id: string; value: number; weight: number }>
  durationMs: number
  fadeInMs: number
  fadeOutMs: number
}

export interface Live2DParameterVisibilityOverrides {
  allow?: readonly string[]
  deny?: readonly string[]
}

export type PerformanceInstructionValidation =
  | { ok: true; value: Live2DPerformanceInstruction }
  | { ok: false; reason: string }

const INTERNAL_ENGLISH_TOKENS = new Set(['physics', 'input', 'output', 'ram', 'cache', 'divider', 'controller'])
const INTERNAL_CHINESE_TOKENS = ['物理', '运算', '输入', '输出', '控制', '区切']

function isFiniteCapability(parameter: Live2DParameterCapability): boolean {
  return Boolean(parameter.id)
    && Number.isFinite(parameter.min)
    && Number.isFinite(parameter.max)
    && Number.isFinite(parameter.defaultValue)
    && parameter.min <= parameter.max
    && parameter.defaultValue >= parameter.min
    && parameter.defaultValue <= parameter.max
}

function hasInternalToken(parameter: Live2DParameterCapability): boolean {
  const labels = [parameter.id, parameter.name, parameter.group]
    .filter((label): label is string => typeof label === 'string')
  const englishWords = labels
    .flatMap((label) => label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/))
  return englishWords.some((word) => INTERNAL_ENGLISH_TOKENS.has(word))
    || INTERNAL_CHINESE_TOKENS.some((token) => labels.some((label) => label.includes(token)))
}

function toIdSet(ids: readonly string[] | undefined): Set<string> {
  return new Set((ids ?? []).map((id) => id.toLowerCase()))
}

/** Removes Core implementation controls while preserving explicit product overrides. */
export function classifyVisibleParameters(
  parameters: readonly Live2DParameterCapability[],
  overrides: Live2DParameterVisibilityOverrides = {}
): Live2DParameterCapability[] {
  const allowed = toIdSet(overrides.allow)
  const denied = toIdSet(overrides.deny)

  return parameters.filter((parameter) => {
    if (!isFiniteCapability(parameter)) return false
    const id = parameter.id.toLowerCase()
    if (denied.has(id)) return false
    return allowed.has(id) || !hasInternalToken(parameter)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function invalid(reason: string): PerformanceInstructionValidation {
  return { ok: false, reason }
}

/** Validates untrusted model output before it is handed to the Live2D Core. */
export function validatePerformanceInstruction(
  input: unknown,
  snapshot: Live2DCapabilitySnapshot
): PerformanceInstructionValidation {
  if (!isRecord(input)) return invalid('Instruction must be an object')

  const { expression, parameters, durationMs, fadeInMs, fadeOutMs } = input
  if (expression !== undefined && (typeof expression !== 'string' || !snapshot.expressions.includes(expression))) {
    return invalid(`Unknown expression: ${String(expression)}`)
  }
  if (!Array.isArray(parameters)) return invalid('Parameters must be an array')
  if (expression === undefined && parameters.length === 0) return invalid('An expression or parameter is required')
  if (parameters.length > 8) return invalid('At most 8 parameters are allowed')
  if (typeof durationMs !== 'number' || typeof fadeInMs !== 'number' || typeof fadeOutMs !== 'number'
    || !Number.isFinite(durationMs) || !Number.isFinite(fadeInMs) || !Number.isFinite(fadeOutMs)) {
    return invalid('Duration and fade timings must be finite')
  }

  const capabilities = new Map(snapshot.parameters.map((parameter) => [parameter.id, parameter]))
  const validatedParameters: Live2DPerformanceInstruction['parameters'] = []
  for (const parameter of parameters) {
    if (!isRecord(parameter) || typeof parameter.id !== 'string') return invalid('Invalid parameter entry')
    const capability = capabilities.get(parameter.id)
    if (!capability) return invalid(`Unknown parameter: ${parameter.id}`)
    if (!isFiniteCapability(capability)) return invalid(`Invalid parameter capability: ${parameter.id}`)
    if (typeof parameter.value !== 'number' || !Number.isFinite(parameter.value)) {
      return invalid(`Parameter value must be finite: ${parameter.id}`)
    }
    const weight = parameter.weight === undefined ? 1 : parameter.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      return invalid(`Parameter weight must be finite: ${parameter.id}`)
    }
    validatedParameters.push({
      id: parameter.id,
      value: clamp(parameter.value, capability.min, capability.max),
      weight: clamp(weight, 0, 1)
    })
  }

  const normalizedDuration = clamp(durationMs, 150, 5000)
  const value: Live2DPerformanceInstruction = {
    parameters: validatedParameters,
    durationMs: normalizedDuration,
    fadeInMs: clamp(fadeInMs, 0, normalizedDuration),
    fadeOutMs: clamp(fadeOutMs, 0, normalizedDuration)
  }
  if (expression !== undefined) value.expression = expression as string
  return { ok: true, value }
}

/** Formats the model's exact expression and parameter affordances for a tool prompt. */
export function formatLive2DCapabilities(snapshot: Live2DCapabilitySnapshot): string {
  const expressions = snapshot.expressions.length > 0 ? snapshot.expressions.join(', ') : '(none)'
  const parameters = snapshot.parameters.length > 0
    ? snapshot.parameters.map((parameter) =>
      `- ${parameter.id}: range ${parameter.min} to ${parameter.max}, default ${parameter.defaultValue}`
    ).join('\n')
    : '- (none)'
  return `Live2D performance capabilities for ${snapshot.petId}.\nExpressions: ${expressions}\nParameters:\n${parameters}`
}
