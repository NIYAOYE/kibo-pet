/** LLM token 清洗与流式分句缓冲,移植自 minimal_tts/electron/SentenceBuffer.ts(逻辑与阈值不变,改写成工厂函数风格)。 */

export interface SentenceClock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(h: ReturnType<typeof setTimeout>): void
}

export interface SentenceBufferOptions {
  minLength?: number
  idleMs?: number
  maxLength?: number
  clock?: SentenceClock
  onIdle?: () => void
}

export interface SentenceBuffer {
  push(token: string): string[]
  flush(): string
  clear(): void
}

const DEFAULT_MIN_LENGTH = 2
const DEFAULT_IDLE_MS = 250
const DEFAULT_MAX_LENGTH = 80

const STRONG_PUNCT_RE = /[。！？!?.]/g
const SOFT_PUNCT_RE = /[，、,;：:]/
const MD_FENCE_RE = /```[a-zA-Z]*\n?|```/g
const URL_RE = /https?:\/\/\S+/g

function cleanToken(token: string): string {
  return token.replace(MD_FENCE_RE, '').replace(URL_RE, '').replace(/\n/g, ' ')
}

export function createSentenceBuffer(options?: SentenceBufferOptions): SentenceBuffer {
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH
  const idleMs = options?.idleMs ?? DEFAULT_IDLE_MS
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH
  const clock: SentenceClock = options?.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h)
  }
  const onIdle = options?.onIdle

  let buffer = ''
  let softBreakIndex = -1
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function cancelIdle(): void {
    if (idleTimer !== null) {
      clock.clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdle(): void {
    cancelIdle()
    idleTimer = clock.setTimeout(() => {
      idleTimer = null
      onIdle?.()
    }, idleMs)
  }

  function process(): string[] {
    const segments: string[] = []

    for (;;) {
      STRONG_PUNCT_RE.lastIndex = 0
      const match = STRONG_PUNCT_RE.exec(buffer)
      if (!match) break
      const end = match.index + match[0].length
      const segment = buffer.substring(0, end).trim()
      buffer = buffer.substring(end)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    const softMatch = SOFT_PUNCT_RE.exec(buffer)
    if (softMatch) {
      if (softBreakIndex === -1) softBreakIndex = softMatch.index + softMatch[0].length
    }
    if (softBreakIndex !== -1 && buffer.length > softBreakIndex) {
      const segment = buffer.substring(0, softBreakIndex).trim()
      buffer = buffer.substring(softBreakIndex)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    while (buffer.length >= maxLength) {
      let breakIdx = buffer.lastIndexOf(' ', maxLength)
      if (breakIdx <= 0) breakIdx = maxLength
      const segment = buffer.substring(0, breakIdx).trim()
      buffer = buffer.substring(breakIdx)
      softBreakIndex = -1
      if (segment.length >= minLength) segments.push(segment)
    }

    if (buffer.trim().length >= minLength) scheduleIdle()

    return segments
  }

  return {
    push(token: string): string[] {
      cancelIdle()
      buffer += cleanToken(token)
      return process()
    },
    flush(): string {
      cancelIdle()
      const result = buffer.trim()
      buffer = ''
      softBreakIndex = -1
      return result
    },
    clear(): void {
      cancelIdle()
      buffer = ''
      softBreakIndex = -1
    }
  }
}
