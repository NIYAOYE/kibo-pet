export const GENIE_RUNTIME_MARKER_VERSION = 1

export interface GenieRuntimeMarker {
  markerVersion: number
  genieTtsVersion: string
}

export function parseGenieRuntimeMarker(raw: string): GenieRuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.genieTtsVersion !== 'string') return null
    return { markerVersion: j.markerVersion, genieTtsVersion: j.genieTtsVersion }
  } catch {
    return null
  }
}

export function isGenieRuntimeUsable(marker: GenieRuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === GENIE_RUNTIME_MARKER_VERSION
}

export function serializeGenieRuntimeMarker(m: GenieRuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
