import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { parseLive2DManifest } from '@shared/petPackage'
import { resolveAutoLive2DManifest } from './live2dAutoManifest'

const input = (overrides: Partial<{ folderName: string; modelPaths: readonly string[]; occupiedIds: ReadonlySet<string> }> = {}) => ({
  folderName: 'Panda cake',
  modelPaths: ['Panda cake/Panda cake.model3.json'],
  occupiedIds: new Set<string>(),
  ...overrides
})

describe('resolveAutoLive2DManifest', () => {
  test.each([
    null,
    { schemaVersion: 1, render: { type: 'sprite' } },
    { render: { type: 'unknown' } }
  ])('leaves non-Live2D raw manifests untouched: %o', (raw) => {
    expect(resolveAutoLive2DManifest(raw, input())).toBeNull()
  })

  test('generates a parseable manifest from the only model file', () => {
    const result = resolveAutoLive2DManifest(undefined, input())

    expect(result).toMatchObject({
      ok: true,
      mode: 'generated',
      completedFields: ['pet.json'],
      manifest: {
        schemaVersion: 2,
        id: 'panda-cake',
        displayName: 'Panda cake',
        description: 'Panda cake',
        render: {
          type: 'live2d',
          model: 'Panda cake/Panda cake.model3.json',
          viewport: { width: 360, height: 480, resolutionCap: 1.5 },
          transform: {
            scale: 1, offsetX: 0, offsetY: 0,
            anchorX: 0.5, anchorY: 1,
            bubbleAnchorX: 0.5, bubbleAnchorY: 0,
            autoFitted: false
          },
          interaction: { mirrorOnWalk: false, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
          stateMap: {}
        }
      }
    })
    if (result?.ok) parseLive2DManifest(result.manifest)
  })

  test('treats occupied IDs case-insensitively', () => {
    const result = resolveAutoLive2DManifest(undefined, input({ occupiedIds: new Set(['PANDA-CAKE']) }))

    expect(result).toMatchObject({
      ok: true,
      manifest: { id: `panda-cake-${createHash('sha256').update('Panda cake/Panda cake.model3.json').digest('hex').slice(0, 8)}` }
    })
  })

  test('adds a deterministic counter when the first hashed candidate is occupied', () => {
    const hash = createHash('sha256').update('Panda cake/Panda cake.model3.json').digest('hex').slice(0, 8)
    const result = resolveAutoLive2DManifest(undefined, input({
      occupiedIds: new Set(['PANDA-CAKE', `PANDA-CAKE-${hash}`])
    }))

    expect(result).toMatchObject({ ok: true, manifest: { id: `panda-cake-${hash}-2` } })
  })

  test('completes missing Live2D fields without replacing custom viewport or state map', () => {
    const stateMap = { idle: { motionGroup: 'Idle', loop: true } }
    const result = resolveAutoLive2DManifest({
      id: 'custom-panda',
      displayName: 'Custom Panda',
      description: 'Custom description',
      render: {
        type: 'live2d',
        model: 'models/custom.model3.json',
        viewport: { width: 500, height: 600, resolutionCap: 2 },
        stateMap
      }
    }, input({ modelPaths: ['unrelated.model3.json', 'another.model3.json'] }))

    expect(result).toMatchObject({
      ok: true,
      mode: 'completed',
      completedFields: ['schemaVersion', 'render.transform', 'render.interaction'],
      manifest: {
        render: {
          viewport: { width: 500, height: 600, resolutionCap: 2 },
          stateMap,
          transform: { autoFitted: false, anchorX: 0.5, anchorY: 1 },
          interaction: { mirrorOnWalk: false, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' }
        }
      }
    })
    if (result?.ok) parseLive2DManifest(result.manifest)
  })

  test('does not mask an invalid present viewport', () => {
    const result = resolveAutoLive2DManifest({
      render: { type: 'live2d', viewport: 123 }
    }, input())

    expect(result).toMatchObject({ ok: false, reason: 'invalid-manifest' })
  })

  test.each([
    ['missing-live2d-model', [], '未找到 Live2D 模型文件(.model3.json)。'],
    ['ambiguous-live2d-model', ['one.model3.json', 'two.model3.json'], '找到多个 Live2D 模型文件:one.model3.json、two.model3.json。']
  ] as const)('reports %s when a generated manifest has %o model files', (reason, modelPaths, message) => {
    expect(resolveAutoLive2DManifest(undefined, input({ modelPaths }))).toMatchObject({ ok: false, reason, message })
  })
})
