import { describe, it, expect } from 'vitest'
import { decideGpuBoot } from './gpuBootDecision'

describe('decideGpuBoot', () => {
  it('实验开关关闭 -> 不用硬件加速,不碰标记文件', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: false, markerPresent: false })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'none' })
  })

  it('实验开关关闭,即使标记文件残留也不管(开关本身就是唯一开关)', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: false, markerPresent: true })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'none' })
  })

  it('实验开关开启且无残留标记 -> 尝试硬件加速并写标记', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: true, markerPresent: false })
    expect(d).toEqual({ useHardwareAcceleration: true, markerAction: 'write' })
  })

  it('实验开关开启且标记残留(上次启动没能清掉) -> 强制降级+清标记+关开关', () => {
    const d = decideGpuBoot({ experimentalHardwareAcceleration: true, markerPresent: true })
    expect(d).toEqual({ useHardwareAcceleration: false, markerAction: 'clear-and-disable-setting' })
  })
})
