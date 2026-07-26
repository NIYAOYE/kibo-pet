import { describe, expect, it } from 'vitest'
import type { Live2DPerformanceInstruction } from '@shared/live2dPerformance'
import { createLive2DPerformanceTool } from './live2dPerformance'

const snapshot = {
  petId: 'BQD',
  expressions: ['笑咪咪'],
  parameters: [{ id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 }]
}

describe('createLive2DPerformanceTool', () => {
  it('validates and dispatches a performance for the current model', async () => {
    const sent: Live2DPerformanceInstruction[] = []
    const tool = createLive2DPerformanceTool({
      snapshot,
      now: () => 1000,
      dispatch: (instruction) => { sent.push(instruction); return true }
    })

    await tool.run({
      expression: '笑咪咪',
      parameters: [{ id: 'ParamAngleX', value: 99 }],
      durationMs: 900,
      fadeInMs: 100,
      fadeOutMs: 200
    }, { signal: new AbortController().signal })

    expect(sent).toEqual([{
      expression: '笑咪咪',
      parameters: [{ id: 'ParamAngleX', value: 30, weight: 1 }],
      durationMs: 900,
      fadeInMs: 100,
      fadeOutMs: 200
    }])
  })

  it('includes the current model capabilities in a generic tool definition', () => {
    const tool = createLive2DPerformanceTool({ snapshot, now: () => 0, dispatch: () => true })

    expect(tool.name).toBe('live2d_perform')
    expect(tool.description).toContain('笑咪咪')
    expect(tool.description).toContain('ParamAngleX: range -30 to 30, default 0')
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { parameters: { type: 'array' } }
    })
  })

  it('does not dispatch again during its local cooldown', async () => {
    const sent: Live2DPerformanceInstruction[] = []
    const tool = createLive2DPerformanceTool({
      snapshot,
      now: () => 1000,
      dispatch: (instruction) => { sent.push(instruction); return true }
    })
    const input = { expression: '笑咪咪', parameters: [], durationMs: 500, fadeInMs: 0, fadeOutMs: 0 }

    await tool.run(input, { signal: new AbortController().signal })
    const result = await tool.run(input, { signal: new AbortController().signal })

    expect(sent).toHaveLength(1)
    expect(result).toContain('cooldown')
  })

  it('returns a stale-pet error when dispatch rejects it', async () => {
    let calls = 0
    const tool = createLive2DPerformanceTool({
      snapshot,
      now: () => 1000,
      dispatch: () => { calls++; return false }
    })

    const result = await tool.run({
      expression: '笑咪咪', parameters: [], durationMs: 500, fadeInMs: 0, fadeOutMs: 0
    }, { signal: new AbortController().signal })

    expect(calls).toBe(1)
    expect(result).toContain('stale')
  })
})
