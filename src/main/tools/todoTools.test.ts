import { describe, it, expect } from 'vitest'
import { createTodoTools } from './todoTools'
import { createTodoStore } from '../todos/todoStore'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ctx = { signal: new AbortController().signal }
const NOW = 1_000_000

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'todotools-'))
  const store = createTodoStore({ file: join(dir, 'todos.json'), now: () => NOW, rand: () => 0.5 })
  const tools = createTodoTools({ store, now: () => NOW })
  const byName = (n: string) => tools.find((t) => t.name === n)!
  return { dir, store, byName, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('add_todo', () => {
  it('无 dueAt 建纯待办', async () => {
    const { store, byName, cleanup } = make()
    const out = await byName('add_todo').run({ title: '买牛奶' }, ctx)
    expect(store.list()[0].title).toBe('买牛奶')
    expect(store.list()[0].dueAt).toBeNull()
    expect(out).toContain('买牛奶')
    cleanup()
  })
  it('带将来 dueAt(ISO 字符串)建提醒', async () => {
    const { store, byName, cleanup } = make()
    const future = new Date(NOW + 3600_000).toISOString()
    await byName('add_todo').run({ title: '开会', dueAt: future }, ctx)
    expect(store.list()[0].dueAt).toBe(NOW + 3600_000)
    cleanup()
  })
  it('非法时间格式 → 错误文本,不建项', async () => {
    const { store, byName, cleanup } = make()
    const out = await byName('add_todo').run({ title: 'x', dueAt: '不是时间' }, ctx)
    expect(out).toContain('时间')
    expect(store.list()).toEqual([])
    cleanup()
  })
  it('过去时间 → 错误文本,不建项', async () => {
    const { store, byName, cleanup } = make()
    const past = new Date(NOW - 1000).toISOString()
    const out = await byName('add_todo').run({ title: 'x', dueAt: past }, ctx)
    expect(out).toContain('过去')
    expect(store.list()).toEqual([])
    cleanup()
  })
  it('空标题 → 错误文本', async () => {
    const { byName, cleanup } = make()
    const out = await byName('add_todo').run({ title: '   ' }, ctx)
    expect(out).toContain('标题')
    cleanup()
  })
})

describe('list_todos', () => {
  it('空时给出提示', async () => {
    const { byName, cleanup } = make()
    expect(await byName('list_todos').run({}, ctx)).toContain('没有待办')
    cleanup()
  })
  it('列出未完成项', async () => {
    const { store, byName, cleanup } = make()
    store.add({ title: '待办甲', dueAt: null })
    const out = await byName('list_todos').run({}, ctx)
    expect(out).toContain('待办甲')
    cleanup()
  })
})

describe('complete_todo / remove_todo', () => {
  it('按 title 唯一匹配完成', async () => {
    const { store, byName, cleanup } = make()
    store.add({ title: '交报告', dueAt: null })
    const out = await byName('complete_todo').run({ title: '交报告' }, ctx)
    expect(store.list()[0].done).toBe(true)
    expect(out).toContain('交报告')
    cleanup()
  })
  it('title 无匹配 → 错误文本', async () => {
    const { byName, cleanup } = make()
    const out = await byName('complete_todo').run({ title: '不存在' }, ctx)
    expect(out).toContain('没找到')
    cleanup()
  })
  it('title 多匹配 → 要求明确', async () => {
    const { store, byName, cleanup } = make()
    store.add({ title: '买东西A', dueAt: null })
    store.add({ title: '买东西B', dueAt: null })
    const out = await byName('complete_todo').run({ title: '买东西' }, ctx)
    expect(out).toContain('多条')
    cleanup()
  })
  it('remove_todo 按 id 删除', async () => {
    const { store, byName, cleanup } = make()
    const it = store.add({ title: '删我', dueAt: null })
    await byName('remove_todo').run({ id: it.id }, ctx)
    expect(store.list()).toEqual([])
    cleanup()
  })
})
