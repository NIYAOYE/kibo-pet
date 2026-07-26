import { describe, it, expect } from 'vitest'
import { resolveStateMotion, nextSequentialIndex } from './live2dStateMapResolver'
import type { Live2DStateMapEntry } from '@shared/petPackage'

describe('resolveStateMotion', () => {
  it('命中的状态直接返回其 motionGroup', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'idle')).toEqual({
      motionGroup: 'Idle', selection: 'random', loop: true, expression: undefined, lipSync: undefined
    })
  })

  it('有 motionGroup 的状态直接命中,不走 fallback', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      greet: { motionGroup: 'TapBody', selection: 'random', fallback: 'idle' },
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'greet')?.motionGroup).toBe('TapBody')
  })

  it('状态存在但没有 motionGroup,按 fallback 回退', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      happy: { fallback: 'idle' },
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'happy')?.motionGroup).toBe('Idle')
  })

  it('解析只有 expression 的状态而不回退', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      greet: { expression: 'smile', fallback: 'idle' },
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }

    expect(resolveStateMotion(stateMap, 'greet')).toEqual({
      motionGroup: undefined, selection: 'random', loop: undefined, expression: 'smile', lipSync: undefined
    })
  })

  it('状态完全不在 stateMap 里,回退到 idle', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true }
    }
    expect(resolveStateMotion(stateMap, 'surprised')?.motionGroup).toBe('Idle')
  })

  it('idle 本身也没有映射时返回 null,不抛错', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {}
    expect(resolveStateMotion(stateMap, 'talk')).toBeNull()
  })

  it('fallback 成环时不死循环,最终返回 null', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      a: { fallback: 'b' },
      b: { fallback: 'a' }
    }
    expect(resolveStateMotion(stateMap, 'a')).toBeNull()
  })

  it('selection 为固定索引/expression/lipSync 字段透传', () => {
    const stateMap: Record<string, Live2DStateMapEntry> = {
      talk: { motionGroup: 'Idle', selection: 2, expression: 'smile', lipSync: true }
    }
    expect(resolveStateMotion(stateMap, 'talk')).toEqual({
      motionGroup: 'Idle', selection: 2, loop: undefined, expression: 'smile', lipSync: true
    })
  })
})

describe('nextSequentialIndex', () => {
  it('从 undefined 开始返回 0', () => {
    expect(nextSequentialIndex(undefined)).toBe(0)
  })
  it('每次调用递增 1', () => {
    expect(nextSequentialIndex(0)).toBe(1)
    expect(nextSequentialIndex(4)).toBe(5)
  })
})
