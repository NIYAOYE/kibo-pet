import { describe, it, expect } from 'vitest'
import { fpsForState } from './live2dFps'

describe('fpsForState', () => {
  it('sleep → 15', () => {
    expect(fpsForState('sleep')).toBe(15)
  })
  it('idle → 30', () => {
    expect(fpsForState('idle')).toBe(30)
  })
  it('拖拽/行走/说话/动作类状态 → 60', () => {
    for (const s of ['drag', 'walk-left', 'walk-right', 'talk', 'greet', 'thinking', 'happy', 'sad', 'cry', 'surprised', 'love']) {
      expect(fpsForState(s)).toBe(60)
    }
  })
  it('未知状态默认 60(不认识的状态按"活跃"处理,不静默拖累帧率)', () => {
    expect(fpsForState('some_future_state')).toBe(60)
  })
})
