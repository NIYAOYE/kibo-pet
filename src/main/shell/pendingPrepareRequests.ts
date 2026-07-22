export interface PrepareResult {
  ok: boolean
  error?: string
}

export interface PendingPrepareRequests {
  /** 登记一个等待中的请求;超时后自动以 { ok:false, error:'MODEL_LOAD_TIMEOUT' } 完成。 */
  wait(requestId: string, timeoutMs: number): Promise<PrepareResult>
  /** 渲染层回报结果时调用;requestId 未知(已超时/从未注册)时安静忽略。 */
  resolve(requestId: string, result: PrepareResult): void
}

/** switchPet() 的"等渲染层确认新模型准备好"计时器薄封装,与 Electron 解耦以便注入假计时器测试。 */
export function createPendingPrepareRequests(
  setTimeoutFn: typeof setTimeout = setTimeout,
  clearTimeoutFn: typeof clearTimeout = clearTimeout
): PendingPrepareRequests {
  const resolvers = new Map<string, (r: PrepareResult) => void>()

  return {
    wait(requestId, timeoutMs) {
      return new Promise((resolvePromise) => {
        const timer = setTimeoutFn(() => {
          resolvers.delete(requestId)
          resolvePromise({ ok: false, error: 'MODEL_LOAD_TIMEOUT' })
        }, timeoutMs)
        resolvers.set(requestId, (r) => {
          clearTimeoutFn(timer)
          resolvePromise(r)
        })
      })
    },
    resolve(requestId, result) {
      const fn = resolvers.get(requestId)
      if (!fn) return
      resolvers.delete(requestId)
      fn(result)
    }
  }
}
