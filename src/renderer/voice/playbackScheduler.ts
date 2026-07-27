export interface PlaybackScheduler {
  /** 给定当前时刻与本块时长,返回本块应该开始播放的时刻,保证与前一块无缝衔接(不重叠、不留空档)。 */
  scheduleNext(now: number, chunkDurationS: number): number
  reset(): void
}

export function createPlaybackScheduler(): PlaybackScheduler {
  let nextStart = 0
  return {
    scheduleNext(now: number, chunkDurationS: number): number {
      const startAt = Math.max(now, nextStart)
      nextStart = startAt + chunkDurationS
      return startAt
    },
    reset(): void {
      nextStart = 0
    }
  }
}
