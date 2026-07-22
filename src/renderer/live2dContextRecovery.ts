export type ContextRecoveryState = 'healthy' | 'recovering' | 'given-up'
export type ContextRecoveryEvent = 'contextlost' | 'restore-succeeded' | 'restore-failed'

/** 见 docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md §2。
 *  given-up 是终态,进入后忽略一切后续事件,只能靠调用方(真实换宠物提交新 source 时)
 *  显式重新初始化,不属于这个状态机的事件集合。 */
export function nextContextRecoveryState(current: ContextRecoveryState, event: ContextRecoveryEvent): ContextRecoveryState {
  if (current === 'given-up') return 'given-up'
  if (current === 'healthy') {
    return event === 'contextlost' ? 'recovering' : 'healthy'
  }
  // current === 'recovering'
  if (event === 'contextlost') return 'given-up'
  if (event === 'restore-succeeded') return 'healthy'
  return 'given-up' // restore-failed
}
