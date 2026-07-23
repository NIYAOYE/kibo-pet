export const TRANSLATE_RUNTIME_MARKER_VERSION = 1

export interface TranslateRuntimeMarker {
  markerVersion: number
  nllbModelRepo: string
}

export function parseTranslateRuntimeMarker(raw: string): TranslateRuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.nllbModelRepo !== 'string') return null
    return { markerVersion: j.markerVersion, nllbModelRepo: j.nllbModelRepo }
  } catch {
    return null
  }
}

export function isTranslateRuntimeUsable(marker: TranslateRuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === TRANSLATE_RUNTIME_MARKER_VERSION
}

export function serializeTranslateRuntimeMarker(m: TranslateRuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
