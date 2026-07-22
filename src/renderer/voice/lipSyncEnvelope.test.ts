import { describe, it, expect } from 'vitest'
import { computeEnvelope, createLipSyncSmoother } from './lipSyncEnvelope'

describe('computeEnvelope', () => {
  it('全静音(全 0)数组 → 包络全 0', () => {
    const pcm = new Float32Array(2000) // 全 0
    const envelope = computeEnvelope(pcm, 16000, 20) // 16000Hz, 20ms/窗 = 320 采样/窗
    expect(envelope.every((v) => v === 0)).toBe(true)
  })

  it('窗口数量按采样数/每窗采样数向上取整', () => {
    const pcm = new Float32Array(321) // 320 采样/窗(16000Hz*20ms/1000),多 1 个采样落入第 2 窗
    const envelope = computeEnvelope(pcm, 16000, 20)
    expect(envelope.length).toBe(2)
  })

  it('恒定振幅 1.0 的信号,RMS*gain 被 clamp 到 1', () => {
    const pcm = new Float32Array(320).fill(1)
    const envelope = computeEnvelope(pcm, 16000, 20, 4) // gain=4,rms=1 → 1*4 clamp 到 1
    expect(envelope[0]).toBe(1)
  })

  it('低振幅信号:RMS*gain 未超过 1 时不 clamp,按比例反映音量', () => {
    const pcm = new Float32Array(320).fill(0.1)
    const envelope = computeEnvelope(pcm, 16000, 20, 4) // rms=0.1, *4 = 0.4
    expect(envelope[0]).toBeCloseTo(0.4, 5)
  })
})

describe('createLipSyncSmoother', () => {
  it('目标从 0 跳到 1:多次 step 后单调上升且不超过 1', () => {
    const s = createLipSyncSmoother(60, 150)
    let prev = 0
    let level = 0
    for (let i = 0; i < 20; i++) {
      level = s.step(1, 16)
      expect(level).toBeGreaterThanOrEqual(prev)
      expect(level).toBeLessThanOrEqual(1)
      prev = level
    }
    expect(level).toBeGreaterThan(0.9) // 足够多次迭代后应接近目标
  })

  it('目标从 1 跳到 0:多次 step 后单调下降且不低于 0', () => {
    const s = createLipSyncSmoother(60, 150)
    for (let i = 0; i < 50; i++) s.step(1, 16) // 先升到接近 1
    let prev = 1
    let level = 1
    for (let i = 0; i < 30; i++) {
      level = s.step(0, 16)
      expect(level).toBeLessThanOrEqual(prev)
      expect(level).toBeGreaterThanOrEqual(0)
      prev = level
    }
    expect(level).toBeLessThan(0.1)
  })

  it('attackMs 越小,同样 dt 下向上追目标的速度越快(alpha 越大)', () => {
    const fast = createLipSyncSmoother(10, 150)
    const slow = createLipSyncSmoother(300, 150)
    const fastLevel = fast.step(1, 16)
    const slowLevel = slow.step(1, 16)
    expect(fastLevel).toBeGreaterThan(slowLevel)
  })
})
