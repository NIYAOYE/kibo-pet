import { nextDueItem, overdueUnfired, type TodoItem } from '@shared/todo'
import type { TodoStore } from './todoStore'

// Node/浏览器 setTimeout 的 32 位延时上限(~24.8 天);超过会立刻触发,故需封顶再续弦
export const MAX_TIMER_DELAY = 2_147_483_647

export interface Scheduler { start(): void; stop(): void; rearm(): void }

export function createScheduler(opts: {
  store: TodoStore
  now: () => number
  onFire: (item: TodoItem) => void
  onCatchup?: (items: TodoItem[]) => void
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}): Scheduler {
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))
  let handle: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (handle !== null) { clearTimer(handle); handle = null }
  }

  function rearm(): void {
    clear()
    const next = nextDueItem(opts.store.list(), opts.now())
    if (!next || next.dueAt === null) return
    const delay = next.dueAt - opts.now()
    if (delay > MAX_TIMER_DELAY) {
      handle = setTimer(() => { handle = null; rearm() }, MAX_TIMER_DELAY) // 封顶:到点仅重新武装,不触发
      return
    }
    handle = setTimer(() => { handle = null; fire(next.id) }, Math.max(0, delay))
  }

  function fire(id: string): void {
    // 不能用 nextDueItem 重新按"当前时间"筛选:真实时钟在定时器触发时已经推进到
    // (>=)dueAt,nextDueItem 的 dueAt>now 严格条件会把刚到期的这一项自己排除掉。
    // 改为直接按 id 取出定时器当初武装时锁定的那一项的最新状态。
    const item = opts.store.list().find((it) => it.id === id)
    if (!item || item.done || item.firedAt !== null) { rearm(); return }
    opts.store.markFired(item.id) // → onChange → rearm(取下一条)
    opts.onFire(item)
  }

  // store 变更(增删改/标记)后自动校准最近到期项
  const unsubscribe = opts.store.onChange(() => rearm())

  return {
    start(): void {
      const overdue = overdueUnfired(opts.store.list(), opts.now())
      for (const it of overdue) opts.store.markFired(it.id)
      if (overdue.length > 0 && opts.onCatchup) opts.onCatchup(overdue)
      rearm()
    },
    stop(): void {
      clear()
      unsubscribe()
    },
    rearm
  }
}
