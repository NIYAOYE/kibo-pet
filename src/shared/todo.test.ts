import { describe, it, expect } from 'vitest'
import {
  makeTodoId, isOverdue, classify, sortTodos, nextDueItem, overdueUnfired,
  formatRelative, type TodoItem
} from './todo'

function item(p: Partial<TodoItem>): TodoItem {
  return { id: p.id ?? 'i', title: 't', createdAt: 0, dueAt: null, done: false, doneAt: null, firedAt: null, ...p }
}

describe('makeTodoId', () => {
  it('唯一且可注入随机', () => {
    const a = makeTodoId(1000, () => 0.1)
    const b = makeTodoId(1000, () => 0.9)
    expect(a).not.toEqual(b)
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('isOverdue / classify', () => {
  it('未完成且到期时间已过 = overdue', () => {
    expect(isOverdue(item({ dueAt: 100 }), 200)).toBe(true)
    expect(isOverdue(item({ dueAt: 300 }), 200)).toBe(false)
    expect(isOverdue(item({ dueAt: null }), 200)).toBe(false)
    expect(isOverdue(item({ dueAt: 100, done: true }), 200)).toBe(false)
  })
  it('classify 覆盖四态', () => {
    expect(classify(item({ done: true }), 200)).toBe('done')
    expect(classify(item({ dueAt: 100 }), 200)).toBe('overdue')
    expect(classify(item({ dueAt: 300 }), 200)).toBe('upcoming')
    expect(classify(item({ dueAt: null }), 200)).toBe('plain')
  })
})

describe('sortTodos', () => {
  it('过期→即将到期→纯待办→已完成;组内按 dueAt 升序', () => {
    const done = item({ id: 'done', done: true, dueAt: 50, doneAt: 60 })
    const plain = item({ id: 'plain', dueAt: null, createdAt: 5 })
    const soon = item({ id: 'soon', dueAt: 300 })
    const later = item({ id: 'later', dueAt: 400 })
    const overdue = item({ id: 'overdue', dueAt: 100 })
    const sorted = sortTodos([done, plain, later, soon, overdue])
    expect(sorted.map((t) => t.id)).toEqual(['overdue', 'soon', 'later', 'plain', 'done'])
  })

  it('两个已完成且都带 dueAt 的项,按 doneAt 降序而非 dueAt 升序', () => {
    // A 的 dueAt 更早但 doneAt 更早(更早完成);B 的 dueAt 更晚但 doneAt 更晚(更晚完成/更近完成)
    // 若误按 dueAt 升序排列会得到 [A, B],正确结果应为 [B, A]
    const a = item({ id: 'a', done: true, dueAt: 1000, doneAt: 3000 })
    const b = item({ id: 'b', done: true, dueAt: 2000, doneAt: 5000 })
    const sorted = sortTodos([a, b], 9999)
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a'])
  })
})

describe('nextDueItem', () => {
  it('取最近的未完成、未响、将来到期项', () => {
    const items = [
      item({ id: 'past', dueAt: 100 }),                 // 已过期不算(交给补提醒)
      item({ id: 'fired', dueAt: 300, firedAt: 250 }),  // 已响不算
      item({ id: 'done', dueAt: 350, done: true }),      // 完成不算
      item({ id: 'next', dueAt: 500 }),
      item({ id: 'far', dueAt: 900 })
    ]
    expect(nextDueItem(items, 200)?.id).toBe('next')
  })
  it('无将来项返回 null', () => {
    expect(nextDueItem([item({ dueAt: null })], 200)).toBeNull()
  })
})

describe('overdueUnfired', () => {
  it('已过期、未完成、未响的项', () => {
    const items = [
      item({ id: 'a', dueAt: 100 }),
      item({ id: 'b', dueAt: 100, firedAt: 90 }),
      item({ id: 'c', dueAt: 100, done: true }),
      item({ id: 'd', dueAt: 500 })
    ]
    expect(overdueUnfired(items, 200).map((t) => t.id)).toEqual(['a'])
  })
})

describe('formatRelative', () => {
  it('过去=已过期;分钟/小时/天', () => {
    expect(formatRelative(100, 200)).toBe('已过期')
    expect(formatRelative(200 + 30_000, 200)).toBe('马上')        // <1 分钟
    expect(formatRelative(200 + 20 * 60_000, 200)).toBe('20分钟后')
    expect(formatRelative(200 + 3 * 3_600_000, 200)).toBe('3小时后')
    expect(formatRelative(200 + 2 * 86_400_000, 200)).toBe('2天后')
  })
})
