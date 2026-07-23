export interface TranslateRequest { text: string; source: 'zh' | 'ja' | 'en'; target: 'zh' | 'ja' | 'en' }

/** 单句 CPU 推理正常应在数十到数百毫秒量级完成;5s 已是明显异常,超时即回退 LLM 而不是让这一句卡住整段回复。 */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 5_000

export interface TranslateSidecar {
  start(): Promise<void>
  translate(req: TranslateRequest, signal: AbortSignal): Promise<string>
  stop(): void
}

export function createTranslateSidecar(opts: {
  port: number
  spawnProcess: () => { kill(): void; waitReady(): Promise<void> }
  postJson: (port: number, path: string, body: unknown, signal: AbortSignal) => Promise<unknown>
  timeoutMs?: number
}): TranslateSidecar {
  let proc: { kill(): void } | null = null

  return {
    async start(): Promise<void> {
      const p = opts.spawnProcess()
      proc = p
      await p.waitReady()
    },

    async translate(req: TranslateRequest, signal: AbortSignal): Promise<string> {
      if (signal.aborted) throw new Error('翻译请求已取消')
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS
      const request = new AbortController()
      const onCallerAbort = (): void => request.abort()
      signal.addEventListener('abort', onCallerAbort, { once: true })
      let timeout: ReturnType<typeof setTimeout> | null = null

      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            request.abort()
            reject(new Error(`本地翻译超时(${timeoutMs}ms)`))
          }, timeoutMs)
        })
        const result = await Promise.race([
          opts.postJson(opts.port, '/translate', req, request.signal),
          timeoutPromise
        ]) as { translation?: unknown }
        if (typeof result.translation !== 'string') throw new Error('本地翻译响应格式错误')
        return result.translation
      } finally {
        if (timeout !== null) clearTimeout(timeout)
        signal.removeEventListener('abort', onCallerAbort)
      }
    },

    stop(): void {
      proc?.kill()
      proc = null
    }
  }
}
