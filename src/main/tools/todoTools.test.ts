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
  it('某条待办的完整 id 恰好是另一条 id 的字符串前缀时,精确匹配优先,不误判为歧义', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todotools-exactid-'))
    // 精心构造 rand 序列,使得两条待办共享相同的 now(36) 前缀段,
    // 且第一条的完整 id("...-1")恰好是第二条 id("...-11")的字符串前缀。
    const rands = [1.5e-9, 3.75e-8]
    let i = 0
    const store = createTodoStore({
      file: join(dir, 'todos.json'),
      now: () => NOW,
      rand: () => rands[i++]
    })
    const tools = createTodoTools({ store, now: () => NOW })
    const byName = (n: string) => tools.find((t) => t.name === n)!

    const shorter = store.add({ title: '短 id 待办', dueAt: null })
    const longer = store.add({ title: '长 id 待办', dueAt: null })
    expect(longer.id.startsWith(shorter.id)).toBe(true)
    expect(shorter.id).not.toBe(longer.id)

    const out = await byName('complete_todo').run({ id: shorter.id }, ctx)
    expect(out).not.toContain('多条')
    expect(out).toContain('短 id 待办')
    expect(store.list().find((it) => it.id === shorter.id)!.done).toBe(true)
    expect(store.list().find((it) => it.id === longer.id)!.done).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })
  it('list_todos 展示的 6 位 id 前缀能被 complete_todo 精确定位(即便标题有共同子串导致 title 匹配歧义)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todotools-idprefix-'))
    let seed = 0
    // now 固定,靠 rand 递增制造不同 id(与 make() 的固定 rand 不同,避免两条待办 id 相同)
    const store = createTodoStore({
      file: join(dir, 'todos.json'),
      now: () => NOW,
      rand: () => {
        seed += 1
        return seed / 3
      }
    })
    const tools = createTodoTools({ store, now: () => NOW })
    const byName = (n: string) => tools.find((t) => t.name === n)!

    const a = store.add({ title: '买东西-苹果', dueAt: null })
    const b = store.add({ title: '买东西-香蕉', dueAt: null })
    expect(a.id).not.toBe(b.id)

    // title 按此 query 会匹配到两条,构造歧义场景
    const ambiguous = await byName('complete_todo').run({ title: '买东西' }, ctx)
    expect(ambiguous).toContain('多条')

    const prefixA = a.id.slice(0, 6)
    expect(b.id.startsWith(prefixA)).toBe(false)
    const out = await byName('complete_todo').run({ id: prefixA }, ctx)
    expect(out).toContain('买东西-苹果')
    expect(store.list().find((it) => it.id === a.id)!.done).toBe(true)
    expect(store.list().find((it) => it.id === b.id)!.done).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })
})
