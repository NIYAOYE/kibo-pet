import { describe, it, expect, vi } from 'vitest'
import { createScheduler, MAX_TIMER_DELAY } from './scheduler'
import type { TodoStore } from './todoStore'
import type { TodoItem } from '@shared/todo'

// 极简假 timer:记录待触发回调 + 延时,由测试手动触发
function fakeTimer() {
  let pending: { cb: () => void; ms: number } | null = null
  let handle = 1
  return {
    set: (cb: () => void, ms: number) => { pending = { cb, ms }; return handle++ as unknown as ReturnType<typeof setTimeout> },
    clear: (_h: ReturnType<typeof setTimeout>) => { pending = null },
    pendingMs: () => pending?.ms ?? null,
    fire: () => { const p = pending; pending = null; p?.cb() }
  }
}

// 极简可变 store(仅调度器用到的方法)
function memStore(items: TodoItem[]): TodoStore & { items: TodoItem[] } {
  const subs = new Set<() => void>()
  const s = {
    items,
    list: () => s.items,
    add: () => { throw new Error('unused') },
    toggleDone: () => null,
    remove: () => false,
    markFired: (id: string) => { s.items = s.items.map((it) => it.id === id ? { ...it, firedAt: 999 } : it); for (const c of subs) c() },
    onChange: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb) }
  }
  return s as TodoStore & { items: TodoItem[] }
}

function item(p: Partial<TodoItem>): TodoItem {
  return { id: 'i', title: 't', createdAt: 0, dueAt: null, done: false, doneAt: null, firedAt: null, ...p }
}

describe('scheduler', () => {
  it('start 补提醒已过期未响项(onCatchup),并标记 fired', () => {
    const store = memStore([item({ id: 'a', dueAt: 100 }), item({ id: 'b', dueAt: 5000 })])
    const caught: string[] = []
    const timer = fakeTimer()
    const sch = createScheduler({
      store, now: () => 1000, onFire: () => {}, onCatchup: (its) => caught.push(...its.map((i) => i.id)),
      setTimer: timer.set, clearTimer: timer.clear
    })
    sch.start()
    expect(caught).toEqual(['a'])
    expect(store.list().find((i) => i.id === 'a')?.firedAt).not.toBeNull()
  })

  it('rearm 对最近将来项设定时器,delay = due - now', () => {
    const store = memStore([item({ id: 'b', dueAt: 5000 })])
    const timer = fakeTimer()
    const sch = createScheduler({ store, now: () => 1000, onFire: () => {}, setTimer: timer.set, clearTimer: timer.clear })
    sch.rearm()
    expect(timer.pendingMs()).toBe(4000)
  })

  it('定时器触发 → onFire 该项 + 标 fired', () => {
    const store = memStore([item({ id: 'b', dueAt: 2000 })])
    const fired: string[] = []
    const timer = fakeTimer()
    const sch = createScheduler({ store, now: () => 1000, onFire: (it) => fired.push(it.id), setTimer: timer.set, clearTimer: timer.clear })
    sch.rearm()
    timer.fire()
    expect(fired).toEqual(['b'])
    expect(store.list()[0].firedAt).not.toBeNull()
  })

  it('超过定时器上限时封顶(不误触发)', () => {
    const store = memStore([item({ id: 'far', dueAt: 10 * MAX_TIMER_DELAY })])
    const fired: string[] = []
    const timer = fakeTimer()
    const sch = createScheduler({ store, now: () => 0, onFire: (it) => fired.push(it.id), setTimer: timer.set, clearTimer: timer.clear })
    sch.rearm()
    expect(timer.pendingMs()).toBe(MAX_TIMER_DELAY)
    // 封顶定时器到点:不应触发 onFire,而是 rearm() 重新计算并再次封顶(项仍远未到期)
    timer.fire()
    expect(fired).toEqual([])
    expect(store.list()[0].firedAt).toBeNull()
    expect(timer.pendingMs()).toBe(MAX_TIMER_DELAY)
  })

  it('无将来项时不设定时器', () => {
    const store = memStore([item({ id: 'p', dueAt: null })])
    const timer = fakeTimer()
    const sch = createScheduler({ store, now: () => 0, onFire: () => {}, setTimer: timer.set, clearTimer: timer.clear })
    sch.rearm()
    expect(timer.pendingMs()).toBeNull()
  })
})
