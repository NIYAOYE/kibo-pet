export const LIP_SYNC_WINDOW_MS = 20
export const DEFAULT_LIP_SYNC_ATTACK_MS = 60
export const DEFAULT_LIP_SYNC_RELEASE_MS = 150

/** 把一段 PCM 按固定时长窗口切片,每窗算 RMS 后乘 gain 并 clamp 到 [0,1]，
 *  产出与嘴部开合大致对应的数值序列。纯函数：不依赖 AudioContext，可直接喂数组测试。 */
export function computeEnvelope(pcm: Float32Array, sampleRate: number, windowMs: number, gain = 4): number[] {
  const samplesPerWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const windowCount = Math.ceil(pcm.length / samplesPerWindow)
  const envelope: number[] = []
  for (let w = 0; w < windowCount; w++) {
    const start = w * samplesPerWindow
    const end = Math.min(start + samplesPerWindow, pcm.length)
    let sumSquares = 0
    for (let i = start; i < end; i++) sumSquares += pcm[i] * pcm[i]
    const rms = Math.sqrt(sumSquares / (end - start))
    envelope.push(Math.min(1, rms * gain))
  }
  return envelope
}

export interface LipSyncSmoother {
  /** 把当前值向 target 推进一步,dtMs 是距上次调用的时间差。attack(target 更大时)和
   *  release(target 更小时)用不同的时间常数,分别对应嘴巴张开更快、闭合更慢的手感。 */
  step(target: number, dtMs: number): number
}

/** 指数逼近平滑器:每步按 `1 - e^(-dt/tau)` 的比例向目标靠近,tau 越小追得越快。
 *  attackMs 控制"目标增大"时的追赶速度,releaseMs 控制"目标减小"时的追赶速度。 */
export function createLipSyncSmoother(attackMs: number, releaseMs: number): LipSyncSmoother {
  let level = 0
  return {
    step(target: number, dtMs: number): number {
      const tau = target > level ? attackMs : releaseMs
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dtMs / tau)
      level += (target - level) * alpha
      return level
    }
  }
}
