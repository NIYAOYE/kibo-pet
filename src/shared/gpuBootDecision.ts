export interface GpuBootDecision {
  useHardwareAcceleration: boolean
  markerAction: 'write' | 'clear-and-disable-setting' | 'none'
}

export function decideGpuBoot(opts: {
  experimentalHardwareAcceleration: boolean
  markerPresent: boolean
}): GpuBootDecision {
  if (!opts.experimentalHardwareAcceleration) {
    return { useHardwareAcceleration: false, markerAction: 'none' }
  }
  if (opts.markerPresent) {
    return { useHardwareAcceleration: false, markerAction: 'clear-and-disable-setting' }
  }
  return { useHardwareAcceleration: true, markerAction: 'write' }
}
