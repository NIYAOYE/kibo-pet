import { describe, it, expect } from 'vitest'
import { createPlaybackScheduler } from './playbackScheduler'

describe('createPlaybackScheduler', () => {
  it('第一个块:调度到 now 之后(空闲状态)', () => {
    const s = createPlaybackScheduler()
    expect(s.scheduleNext(10, 2)).toBe(10)
  })

  it('第二个块紧跟第一个块结束时间,不管 now 是多少', () => {
    const s = createPlaybackScheduler()
    s.scheduleNext(10, 2) // 占用 [10, 12)
    expect(s.scheduleNext(10.5, 3)).toBe(12) // 即便 now=10.5,也要等前一块播完
  })

  it('如果 now 已经超过前一块结束时间(播放卡顿追上了),从 now 重新开始,不留空档倒退', () => {
    const s = createPlaybackScheduler()
    s.scheduleNext(10, 1) // 占用 [10, 11)
    expect(s.scheduleNext(15, 2)).toBe(15) // now(15) 远超上次结束(11),从 now 重新排
  })

  it('resets cancelled audio so the next chunk starts at now', () => {
    const s = createPlaybackScheduler()
    s.scheduleNext(10, 30)

    s.reset()

    expect(s.scheduleNext(12, 2)).toBe(12)
  })
})
