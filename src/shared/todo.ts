export interface TodoItem {
  id: string
  title: string
  createdAt: number   // epoch ms
  dueAt: number | null // null = 无提醒的纯待办;有值 = 到点提醒
  done: boolean
  doneAt: number | null
  firedAt: number | null // 提醒已响过的时间戳;防重复响 + 面板标记
}

export interface TodoFile { version: number; items: TodoItem[] }
export const TODO_SCHEMA_VERSION = 1
export const MAX_TITLE_LEN = 500

export type TodoStatus = 'done' | 'overdue' | 'upcoming' | 'plain'

export function makeTodoId(now: number, rand: () => number): string {
  return `${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`
}

export function isOverdue(item: TodoItem, now: number): boolean {
  return !item.done && item.dueAt !== null && item.dueAt <= now
}

export function classify(item: TodoItem, now: number): TodoStatus {
  if (item.done) return 'done'
  if (item.dueAt === null) return 'plain'
  return item.dueAt <= now ? 'overdue' : 'upcoming'
}

// 排序权重:overdue(0) < upcoming(1) < plain(2) < done(3)
function rank(item: TodoItem, now: number): number {
  const s = classify(item, now)
  return s === 'overdue' ? 0 : s === 'upcoming' ? 1 : s === 'plain' ? 2 : 3
}

export function sortTodos(items: TodoItem[], now: number = Date.now()): TodoItem[] {
  return [...items].sort((a, b) => {
    const ra = rank(a, now), rb = rank(b, now)
    if (ra !== rb) return ra - rb
    // 已完成按 doneAt 降序;有 dueAt 的未完成组按 dueAt 升序;纯待办按 createdAt 升序
    if (ra === 3) return (b.doneAt ?? 0) - (a.doneAt ?? 0)
    if (a.dueAt !== null && b.dueAt !== null) return a.dueAt - b.dueAt
    return a.createdAt - b.createdAt
  })
}

export function nextDueItem(items: TodoItem[], now: number): TodoItem | null {
  let best: TodoItem | null = null
  for (const it of items) {
    if (it.done || it.firedAt !== null || it.dueAt === null) continue
    if (it.dueAt <= now) continue
    if (best === null || it.dueAt < (best.dueAt as number)) best = it
  }
  return best
}

export function overdueUnfired(items: TodoItem[], now: number): TodoItem[] {
  return items.filter((it) => !it.done && it.firedAt === null && it.dueAt !== null && it.dueAt <= now)
}

export function formatRelative(dueAt: number, now: number): string {
  const diff = dueAt - now
  if (diff < 0) return '已过期'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '马上'
  if (min < 60) return `${min}分钟后`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时后`
  return `${Math.floor(hr / 24)}天后`
}
