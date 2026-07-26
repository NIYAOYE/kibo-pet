import type { Live2DStateMapEntry } from '@shared/petPackage'

export interface ResolvedMotion {
  motionGroup?: string
  selection: 'random' | 'sequential' | number
  loop?: boolean
  expression?: string
  lipSync?: boolean
}

/** 按 stateMap 的声明式 fallback 链解析出一个可播放的动作。schema 保证 fallback 链
 *  最终收敛到 'idle'(见 petPackage.ts 的 Live2DStateMapEntry 注释),这里额外用
 *  visited 集合防御一个手写坏了、真的成环的 pet.json——遇到环直接返回 null,交给
 *  调用方保持当前动画(自然待机),而不是死循环或抛错。 */
export function resolveStateMotion(
  stateMap: Record<string, Live2DStateMapEntry>,
  state: string,
  visited: Set<string> = new Set()
): ResolvedMotion | null {
  if (visited.has(state)) return null
  visited.add(state)
  const entry = stateMap[state]
  if (entry?.motionGroup || entry?.expression) {
    return {
      motionGroup: entry.motionGroup,
      selection: entry.selection ?? 'random',
      loop: entry.loop,
      expression: entry.expression,
      lipSync: entry.lipSync
    }
  }
  if (entry?.fallback) return resolveStateMotion(stateMap, entry.fallback, visited)
  if (state !== 'idle') return resolveStateMotion(stateMap, 'idle', visited)
  return null
}

/** stateMap 里 selection:'sequential' 的索引推进——不查询模型真实的动作数量
 *  (Phase 4 范围内没有走引擎 API 查询 Motion Group 大小的需求),超出真实数量时
 *  底层 model.motion() 会自然返回 false,由调用方的失败兜底逻辑处理。 */
export function nextSequentialIndex(previous: number | undefined): number {
  return (previous ?? -1) + 1
}
