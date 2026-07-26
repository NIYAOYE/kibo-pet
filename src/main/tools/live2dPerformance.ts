import {
  formatLive2DCapabilities,
  validatePerformanceInstruction,
  type Live2DCapabilitySnapshot,
  type Live2DPerformanceInstruction
} from '@shared/live2dPerformance'
import type { ToolSpec } from './toolSpec'

const COOLDOWN_MS = 500

export function createLive2DPerformanceTool(deps: {
  snapshot: Live2DCapabilitySnapshot
  dispatch: (instruction: Live2DPerformanceInstruction) => boolean
  now?: () => number
}): ToolSpec {
  const now = deps.now ?? Date.now
  let lastDispatchAt = Number.NEGATIVE_INFINITY

  return {
    name: 'live2d_perform',
    description:
      'Trigger a brief Live2D expression or parameter performance. Only use this when a meaningful visual performance complements the user-facing reply; do not use it for every response.\n\n'
      + formatLive2DCapabilities(deps.snapshot),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        parameters: { type: 'array' },
        durationMs: { type: 'number' },
        fadeInMs: { type: 'number' },
        fadeOutMs: { type: 'number' }
      },
      required: ['parameters', 'durationMs', 'fadeInMs', 'fadeOutMs']
    },
    async run(input) {
      const validated = validatePerformanceInstruction(input, deps.snapshot)
      if (!validated.ok) return `Invalid Live2D performance: ${validated.reason}`
      const current = now()
      if (current - lastDispatchAt < COOLDOWN_MS) return 'Live2D performance cooldown is active.'
      if (!deps.dispatch(validated.value)) return 'Live2D performance was rejected because the pet is stale.'
      lastDispatchAt = current
      return 'Live2D performance started.'
    }
  }
}
