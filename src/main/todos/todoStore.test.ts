import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTodoFile, createTodoStore } from './todoStore'
import { TODO_SCHEMA_VERSION } from '@shared/todo'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'todostore-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const file = () => join(dir, 'todos.json')

describe('normalizeTodoFile', () => {
  it('非对象 / 坏数据退化空列表', () => {
    expect(normalizeTodoFile(null)).toEqual({ version: TODO_SCHEMA_VERSION, items: [] })
    expect(normalizeTodoFile('nope')).toEqual({ version: TODO_SCHEMA_VERSION, items: [] })
  })
  it('丢弃缺 id/title 的坏项,补全布尔/时间戳默认', () => {
    const raw = { version: 1, items: [
      { id: 'a', title: '好项', createdAt: 5, dueAt: 100 },
      { id: 'b' },                         // 缺 title → 丢弃
      { title: '缺id' },                    // 缺 id → 丢弃
      'garbage'
    ] }
    const out = normalizeTodoFile(raw)
    expect(out.items.map((i) => i.id)).toEqual(['a'])
    expect(out.items[0]).toEqual({ id: 'a', title: '好项', createdAt: 5, dueAt: 100, done: false, doneAt: null, firedAt: null })
  })
})

describe('createTodoStore', () => {
  it('add 生成项并落盘;list 反映', () => {
    const store = createTodoStore({ file: file(), now: () => 1000, rand: () => 0.5 })
    const it = store.add({ title: '买牛奶', dueAt: 5000 })
    expect(it.title).toBe('买牛奶')
    expect(it.dueAt).toBe(5000)
    expect(it.createdAt).toBe(1000)
    expect(store.list().map((i) => i.id)).toEqual([it.id])
    const onDisk = JSON.parse(readFileSync(file(), 'utf-8'))
    expect(onDisk.items[0].title).toBe('买牛奶')
  })
  it('toggleDone 置完成 + doneAt;remove 删除', () => {
    const store = createTodoStore({ file: file(), now: () => 2000, rand: () => 0.1 })
    const it = store.add({ title: 'x', dueAt: null })
    const toggled = store.toggleDone(it.id)
    expect(toggled?.done).toBe(true)
    expect(toggled?.doneAt).toBe(2000)
    expect(store.remove(it.id)).toBe(true)
    expect(store.list()).toEqual([])
  })
  it('markFired 记录时间戳', () => {
    const store = createTodoStore({ file: file(), now: () => 3000, rand: () => 0.2 })
    const it = store.add({ title: 'y', dueAt: 100 })
    store.markFired(it.id)
    expect(store.list()[0].firedAt).toBe(3000)
  })
  it('onChange 在每次变更后触发', () => {
    const store = createTodoStore({ file: file(), now: () => 1, rand: () => 0.3 })
    let n = 0
    const off = store.onChange(() => { n++ })
    const it = store.add({ title: 'z', dueAt: null })
    store.toggleDone(it.id)
    off()
    store.remove(it.id)
    expect(n).toBe(2) // add + toggle 计数;取消订阅后 remove 不计
  })
  it('重建 store 从磁盘恢复', () => {
    const s1 = createTodoStore({ file: file(), now: () => 1, rand: () => 0.4 })
    s1.add({ title: '持久', dueAt: null })
    const s2 = createTodoStore({ file: file() })
    expect(s2.list().map((i) => i.title)).toEqual(['持久'])
  })
  it('损坏文件退化为空,不抛', () => {
    writeFileSync(file(), '{ not json', 'utf-8')
    const store = createTodoStore({ file: file() })
    expect(store.list()).toEqual([])
  })
})
