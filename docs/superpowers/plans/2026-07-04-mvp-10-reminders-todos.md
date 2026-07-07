# MVP-10 提醒 / 待办 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给桌宠加"主动提醒 + 待办清单":自然语言(Agent 工具)或待办面板创建待办/提醒,到点时宠物主动跳出来(系统通知 + greet 动画 + 气泡 + 自动弹开面板高亮),全本地零依赖。

**Architecture:** 统一"待办项"模型 `TodoItem`(`dueAt` 有值即提醒)。纯逻辑落 `src/shared/todo.ts`;主进程 `src/main/todos/` 下 `todoStore`(全局 `userData/todos.json` 原子写)+ `scheduler`(单 setTimeout 指向最近到期项 + 启动补提醒)。Agent 工具复用 MVP-08 注入式 toolRegistry 机制。面板是复用 dialog/settings 模式的独立 BrowserWindow。到点行为在 `shell/index.ts` 的 `onFire` 汇聚。

**Tech Stack:** Electron(CJS 主进程,**禁止** `"type":"module"`)· TypeScript(strict)· Vitest · `@shared/*` 别名 · 零新第三方依赖。

## Global Constraints

- 包管理器 **pnpm**;测试 `pnpm vitest run <file>`,类型 `pnpm typecheck`,构建 `pnpm build`。
- **零新第三方依赖**(时间格式化用纯手写函数,不引 date 库)。
- 跨进程值一律走 `src/shared` + `@shared/*`;**禁止硬编码 IPC 通道字符串**,用 `IPC` 常量。新增 IPC 能力四文件锁步:`src/shared/ipc.ts`(常量 + 类型)、`src/main/shell/index.ts`(handler)、`src/preload/index.ts`(expose)、渲染调用方。
- 纯逻辑 TDD(先写失败测试);GUI/Electron 接线由人工真机验收(本仓库无 GUI 自动化驱动)。
- 提交粒度:每个 Task 一提交(或多提交),conventional-commit 中文信息(`feat(todos): ...`)。
- 数据模型字段名以 Task 1 定义为准,后续 Task 严格复用;`TodoItem = { id, title, createdAt, dueAt, done, doneAt, firedAt }`。
- 存储全局 `userData/todos.json`(非 per-pet);提醒不落 transcript / 不进记忆库。
- 提醒只做一次性(每条响一次,`firedAt` 标记后不再响)。

---

### Task 1: 数据模型与纯逻辑 `src/shared/todo.ts`

**Files:**
- Create: `src/shared/todo.ts`
- Test: `src/shared/todo.test.ts`

**Interfaces:**
- Produces:
  - `interface TodoItem { id: string; title: string; createdAt: number; dueAt: number | null; done: boolean; doneAt: number | null; firedAt: number | null }`
  - `interface TodoFile { version: number; items: TodoItem[] }`
  - `const TODO_SCHEMA_VERSION = 1`,`const MAX_TITLE_LEN = 500`
  - `type TodoStatus = 'done' | 'overdue' | 'upcoming' | 'plain'`
  - `makeTodoId(now: number, rand: () => number): string`
  - `isOverdue(item: TodoItem, now: number): boolean`
  - `classify(item: TodoItem, now: number): TodoStatus`
  - `sortTodos(items: TodoItem[]): TodoItem[]`
  - `nextDueItem(items: TodoItem[], now: number): TodoItem | null`
  - `overdueUnfired(items: TodoItem[], now: number): TodoItem[]`
  - `formatRelative(dueAt: number, now: number): string`

- [ ] **Step 1: 写失败测试**

Create `src/shared/todo.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  makeTodoId, isOverdue, classify, sortTodos, nextDueItem, overdueUnfired,
  formatRelative, type TodoItem
} from './todo'

const base: Omit<TodoItem, 'id' | 'dueAt' | 'done' | 'doneAt' | 'firedAt'> = { title: 't', createdAt: 0 }
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/todo.test.ts`
Expected: FAIL(`todo.ts` 不存在 / 函数未定义)

- [ ] **Step 3: 实现 `src/shared/todo.ts`**

```ts
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
    // 有 dueAt 的组按 dueAt 升序;纯待办按 createdAt 升序;已完成按 doneAt 降序
    if (a.dueAt !== null && b.dueAt !== null) return a.dueAt - b.dueAt
    if (ra === 3) return (b.doneAt ?? 0) - (a.doneAt ?? 0)
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
```

> 注:`sortTodos` 加了默认 `now = Date.now()` 便于渲染层省参,但测试始终显式传 `now`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/todo.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交**

```bash
git add src/shared/todo.ts src/shared/todo.test.ts
git commit -m "feat(todos): 统一待办项数据模型 + 纯逻辑(排序/分类/最近到期/补提醒选取/相对时间)"
```

---

### Task 2: 持久化 `src/main/todos/todoStore.ts`

**Files:**
- Create: `src/main/todos/todoStore.ts`
- Test: `src/main/todos/todoStore.test.ts`

**Interfaces:**
- Consumes: `TodoItem`, `TodoFile`, `TODO_SCHEMA_VERSION`, `makeTodoId`(来自 `@shared/todo`)
- Produces:
  - `normalizeTodoFile(raw: unknown): TodoFile`
  - `loadTodoFile(file: string): TodoFile`
  - `saveTodoFile(file: string, data: TodoFile): void`
  - `interface TodoStore { list(): TodoItem[]; add(input: { title: string; dueAt: number | null }): TodoItem; toggleDone(id: string): TodoItem | null; remove(id: string): boolean; markFired(id: string): void; onChange(cb: () => void): () => void }`
  - `createTodoStore(opts: { file: string; now?: () => number; rand?: () => number }): TodoStore`

- [ ] **Step 1: 写失败测试**

Create `src/main/todos/todoStore.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/todos/todoStore.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/main/todos/todoStore.ts`**

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TodoItem, TodoFile, TODO_SCHEMA_VERSION, makeTodoId } from '@shared/todo'

function normItem(raw: unknown): TodoItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.title !== 'string' || r.title.length === 0) return null
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    id: r.id,
    title: r.title,
    createdAt: num(r.createdAt, 0),
    dueAt: numOrNull(r.dueAt),
    done: r.done === true,
    doneAt: numOrNull(r.doneAt),
    firedAt: numOrNull(r.firedAt)
  }
}

export function normalizeTodoFile(raw: unknown): TodoFile {
  const r = (raw ?? {}) as Record<string, unknown>
  const items = Array.isArray(r.items)
    ? r.items.map(normItem).filter((x): x is TodoItem => x !== null)
    : []
  return { version: TODO_SCHEMA_VERSION, items }
}

export function loadTodoFile(file: string): TodoFile {
  try {
    return normalizeTodoFile(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return { version: TODO_SCHEMA_VERSION, items: [] }
  }
}

export function saveTodoFile(file: string, data: TodoFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

export interface TodoStore {
  list(): TodoItem[]
  add(input: { title: string; dueAt: number | null }): TodoItem
  toggleDone(id: string): TodoItem | null
  remove(id: string): boolean
  markFired(id: string): void
  onChange(cb: () => void): () => void
}

export function createTodoStore(opts: { file: string; now?: () => number; rand?: () => number }): TodoStore {
  const now = opts.now ?? Date.now
  const rand = opts.rand ?? Math.random
  let items = loadTodoFile(opts.file).items
  const subs = new Set<() => void>()

  function persist(): void {
    saveTodoFile(opts.file, { version: TODO_SCHEMA_VERSION, items })
    for (const cb of subs) cb()
  }

  return {
    list: () => items,
    add(input): TodoItem {
      const item: TodoItem = {
        id: makeTodoId(now(), rand),
        title: input.title,
        createdAt: now(),
        dueAt: input.dueAt,
        done: false,
        doneAt: null,
        firedAt: null
      }
      items = [...items, item]
      persist()
      return item
    },
    toggleDone(id): TodoItem | null {
      let hit: TodoItem | null = null
      items = items.map((it) => {
        if (it.id !== id) return it
        hit = { ...it, done: !it.done, doneAt: !it.done ? now() : null }
        return hit
      })
      if (hit) persist()
      return hit
    },
    remove(id): boolean {
      const before = items.length
      items = items.filter((it) => it.id !== id)
      if (items.length === before) return false
      persist()
      return true
    },
    markFired(id): void {
      let changed = false
      items = items.map((it) => (it.id === id ? (changed = true, { ...it, firedAt: now() }) : it))
      if (changed) persist()
    },
    onChange(cb): () => void {
      subs.add(cb)
      return () => subs.delete(cb)
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/todos/todoStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/todos/todoStore.ts src/main/todos/todoStore.test.ts
git commit -m "feat(todos): todoStore 全局 todos.json 原子写 + 归一化 + onChange 订阅"
```

---

### Task 3: 调度器 `src/main/todos/scheduler.ts`

**Files:**
- Create: `src/main/todos/scheduler.ts`
- Test: `src/main/todos/scheduler.test.ts`

**Interfaces:**
- Consumes: `TodoStore`(Task 2)、`nextDueItem`/`overdueUnfired`/`TodoItem`(`@shared/todo`)
- Produces:
  - `const MAX_TIMER_DELAY = 2_147_483_647`
  - `interface Scheduler { start(): void; stop(): void; rearm(): void }`
  - `createScheduler(opts: { store: TodoStore; now: () => number; onFire: (item: TodoItem) => void; onCatchup?: (items: TodoItem[]) => void; setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimer?: (h: ReturnType<typeof setTimeout>) => void }): Scheduler`

- [ ] **Step 1: 写失败测试**

Create `src/main/todos/scheduler.test.ts`:

```ts
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
    const timer = fakeTimer()
    const sch = createScheduler({ store, now: () => 0, onFire: () => {}, setTimer: timer.set, clearTimer: timer.clear })
    sch.rearm()
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/todos/scheduler.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/main/todos/scheduler.ts`**

```ts
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
    handle = setTimer(() => { handle = null; fire() }, Math.max(0, delay))
  }

  function fire(): void {
    const item = nextDueItem(opts.store.list(), opts.now())
    if (!item) { rearm(); return }
    opts.store.markFired(item.id) // → onChange → rearm(取下一条)
    opts.onFire(item)
  }

  // store 变更(增删改/标记)后自动校准最近到期项
  opts.store.onChange(() => rearm())

  return {
    start(): void {
      const overdue = overdueUnfired(opts.store.list(), opts.now())
      for (const it of overdue) opts.store.markFired(it.id)
      if (overdue.length > 0 && opts.onCatchup) opts.onCatchup(overdue)
      rearm()
    },
    stop: clear,
    rearm
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/todos/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/todos/scheduler.ts src/main/todos/scheduler.test.ts
git commit -m "feat(todos): 调度器单定时器指向最近到期项 + 启动补提醒 + 定时器上限封顶"
```

---

### Task 4: Agent 工具 `todoTools.ts` + promptAssembler 当前时间注入 + 注册进 chat

**Files:**
- Create: `src/main/tools/todoTools.ts`
- Test: `src/main/tools/todoTools.test.ts`
- Modify: `src/main/agent/promptAssembler.ts`(加 `nowMs` 参数 + 时间小节)
- Test: `src/main/agent/promptAssembler.test.ts`(加"当前时间"用例;若文件不存在则新建仅含该用例)
- Modify: `src/main/shell/chat.ts`(import + 注册 todo 工具 + 传 nowMs)
- Modify: `src/main/shell/chat.test.ts`(makeStore 补 `todoStore` 假实现)

**Interfaces:**
- Consumes: `ToolSpec`(`../tools/toolSpec`)、`TodoStore`(Task 2)、`sortTodos`/`classify`/`formatRelative`/`MAX_TITLE_LEN`/`TodoItem`(`@shared/todo`)
- Produces:
  - `createTodoTools(deps: { store: TodoStore; now: () => number }): ToolSpec[]`(顺序:`add_todo`,`list_todos`,`complete_todo`,`remove_todo`)
  - promptAssembler 新签名:`assemblePrompt(persona, transcript, skills?, memory?, nowMs?): AssembledPrompt`

- [ ] **Step 1: 写 todoTools 失败测试**

Create `src/main/tools/todoTools.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/tools/todoTools.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/main/tools/todoTools.ts`**

```ts
import type { ToolSpec } from './toolSpec'
import type { TodoStore } from '../todos/todoStore'
import { sortTodos, classify, formatRelative, MAX_TITLE_LEN, type TodoItem } from '@shared/todo'

function resolveTarget(items: TodoItem[], arg: { id?: unknown; title?: unknown }):
  { ok: true; item: TodoItem } | { ok: false; message: string } {
  if (typeof arg.id === 'string' && arg.id.length > 0) {
    const byId = items.find((it) => it.id === arg.id)
    if (byId) return { ok: true, item: byId }
    return { ok: false, message: `没找到 id 为「${arg.id}」的待办。用 list_todos 看看现有待办。` }
  }
  if (typeof arg.title === 'string' && arg.title.trim().length > 0) {
    const q = arg.title.trim()
    const matches = items.filter((it) => !it.done && it.title.includes(q))
    if (matches.length === 1) return { ok: true, item: matches[0] }
    if (matches.length === 0) return { ok: false, message: `没找到叫「${q}」的待办。` }
    return { ok: false, message: `有多条匹配「${q}」的待办,请先用 list_todos 看 id 再指定。` }
  }
  return { ok: false, message: '请提供待办的 id 或标题。' }
}

function fmtLocal(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN')
}

export function createTodoTools(deps: { store: TodoStore; now: () => number }): ToolSpec[] {
  const { store, now } = deps

  const add: ToolSpec = {
    name: 'add_todo',
    description:
      '给用户添加一条待办或提醒。用户说"加个待办/提醒我…"时调用。若用户给了时间(如"20分钟后""今天下午3点"),' +
      '把它换算成绝对时间填进 dueAt(用系统提示里的"当前时间"换算);没给时间就省略 dueAt,当作纯待办。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '待办内容' },
        dueAt: { type: 'string', description: '可选。到期/提醒时间,ISO-8601 或 "2026-07-04 15:30" 形式的本地时间' }
      },
      required: ['title']
    },
    async run(input) {
      const { title, dueAt } = input as { title: string; dueAt?: string }
      const t = (title ?? '').trim()
      if (!t) return '标题不能为空,请告诉我要记什么。'
      if (t.length > MAX_TITLE_LEN) return `标题太长了(上限 ${MAX_TITLE_LEN} 字),精简一下吧。`
      let due: number | null = null
      if (dueAt !== undefined && dueAt !== null && String(dueAt).trim() !== '') {
        const ms = Date.parse(String(dueAt))
        if (Number.isNaN(ms)) return '那个时间格式我没认出来,请用形如 2026-07-04 15:30 的时间。'
        if (ms <= now()) return '那个时间已经过去了,请给一个将来的时间。'
        due = ms
      }
      store.add({ title: t, dueAt: due })
      return due === null
        ? `好啦,已记下待办:${t}。`
        : `好啦,已设提醒:${t}(${formatRelative(due, now())},${fmtLocal(due)})。`
    }
  }

  const list: ToolSpec = {
    name: 'list_todos',
    description: '列出用户当前未完成的待办/提醒。用户问"我有哪些待办/提醒"时调用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const open = sortTodos(store.list(), now()).filter((it) => !it.done)
      if (open.length === 0) return '现在没有待办。'
      return open.map((it) => {
        const tag = it.dueAt === null ? '' :
          classify(it, now()) === 'overdue' ? `(已过期:${fmtLocal(it.dueAt)})` : `(${formatRelative(it.dueAt, now())})`
        return `- [${it.id.slice(0, 6)}] ${it.title} ${tag}`.trim()
      }).join('\n')
    }
  }

  const complete: ToolSpec = {
    name: 'complete_todo',
    description: '把某条待办标记为完成。可给 id 或 title(标题需能唯一定位)。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: []
    },
    async run(input) {
      const r = resolveTarget(store.list(), input as { id?: string; title?: string })
      if (!r.ok) return r.message
      store.toggleDone(r.item.id)
      return `已完成:${r.item.title} ✓`
    }
  }

  const remove: ToolSpec = {
    name: 'remove_todo',
    description: '删除某条待办/提醒。可给 id 或 title(标题需能唯一定位)。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: []
    },
    async run(input) {
      const r = resolveTarget(store.list(), input as { id?: string; title?: string })
      if (!r.ok) return r.message
      store.remove(r.item.id)
      return `已删除:${r.item.title}`
    }
  }

  return [add, list, complete, remove]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/tools/todoTools.test.ts`
Expected: PASS

- [ ] **Step 5: promptAssembler 加"当前时间"——先写测试**

在 `src/main/agent/promptAssembler.test.ts` 追加(若文件不存在,新建并 `import { assemblePrompt } from './promptAssembler'` + 一个空 persona 桩;persona 结构见现有 personaLoader 的 `PersonaBlocks`,各字段为字符串):

```ts
import { describe, it, expect } from 'vitest'
import { assemblePrompt } from './promptAssembler'
import type { PersonaBlocks } from '../persona/personaLoader'

const persona: PersonaBlocks = { persona: '你是宠物', voice: '', behavior: '', tools: '' }

describe('promptAssembler 当前时间注入', () => {
  it('给 nowMs 时 system 含"当前时间"', () => {
    const { system } = assemblePrompt(persona, [], [], undefined, 1_700_000_000_000)
    expect(system).toContain('当前时间')
  })
  it('不给 nowMs 时不含"当前时间"', () => {
    const { system } = assemblePrompt(persona, [], [], undefined)
    expect(system).not.toContain('当前时间')
  })
})
```

> 先确认 `PersonaBlocks` 字段名与 `src/main/persona/personaLoader.ts` 一致(`persona`/`voice`/`behavior`/`tools`);若不同,按实际字段构造桩。

- [ ] **Step 6: 运行确认失败**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: FAIL(system 不含"当前时间")

- [ ] **Step 7: 改 `src/main/agent/promptAssembler.ts`**

在文件内加时间小节函数,并把 `assemblePrompt` 签名加第 5 参 `nowMs`,拼到 system 最前:

```ts
function timeSection(nowMs?: number): string {
  if (nowMs === undefined) return ''
  return (
    '# 当前时间\n现在是 ' + new Date(nowMs).toLocaleString('zh-CN') +
    '。当用户说"X分钟后/今天下午3点"等相对时间时,据此换算成绝对时间再调用工具。\n\n'
  )
}
```

把 `assemblePrompt` 签名与 system 拼装改为:

```ts
export function assemblePrompt(
  persona: PersonaBlocks,
  transcript: ChatMessage[],
  skills: SkillMeta[] = [],
  memory?: MemoryContext,
  nowMs?: number
): AssembledPrompt {
  const system =
    timeSection(nowMs) +
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    skillsSection(skills) +
    memorySection(memory)
  // ...(window/messages 部分保持不变)
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: PASS

- [ ] **Step 9: 把 todo 工具接进 `src/main/shell/chat.ts`**

顶部 import 增加:

```ts
import { createTodoTools } from '../tools/todoTools'
import type { TodoStore } from '../todos/todoStore'
```

在 `createChatStore` 的 opts 类型里加一行(紧挨 `memory: MemoryManager` 之后):

```ts
  todoStore: TodoStore
```

在 `handleSend` 内构建 registry 的数组末尾追加 todo 工具:

```ts
      const registry = createToolRegistry([
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t)),
        createReadClipboardTool({ readText: () => opts.clipboard.readText() }),
        createWriteClipboardTool({ writeText: (t) => opts.clipboard.writeText(t) }),
        ...createTodoTools({ store: opts.todoStore, now: () => Date.now() })
      ])
```

在 `handleSend` 里 `assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled)` 调用补第 5 参 `Date.now()`:

```ts
        const { system, messages } = assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled, Date.now())
```

(runQuickAction 内的 assemblePrompt 不改。)

- [ ] **Step 10: 修 `src/main/shell/chat.test.ts` 的 makeStore**

在 `makeStore` 内、`createChatStore({...})` 的 opts 里补一个假 todoStore。先在文件顶部加 import:

```ts
import type { TodoStore } from '../todos/todoStore'
```

在 `createChatStore({` 的 opts 中(`memory,` 之后)加:

```ts
    todoStore: {
      list: () => [],
      add: (i) => ({ id: 'x', title: i.title, createdAt: 0, dueAt: i.dueAt, done: false, doneAt: null, firedAt: null }),
      toggleDone: () => null,
      remove: () => false,
      markFired: () => {},
      onChange: () => () => {}
    } as TodoStore,
```

- [ ] **Step 11: 跑相关测试确认全绿**

Run: `pnpm vitest run src/main/shell/chat.test.ts src/main/tools/todoTools.test.ts src/main/agent/promptAssembler.test.ts`
Expected: PASS(注意:chat.test 里 `seen[0].tools` 现含 `add_todo` 等,但断言只 `toContain('save_memory')`,不受影响)

- [ ] **Step 12: 提交**

```bash
git add src/main/tools/todoTools.ts src/main/tools/todoTools.test.ts src/main/agent/promptAssembler.ts src/main/agent/promptAssembler.test.ts src/main/shell/chat.ts src/main/shell/chat.test.ts
git commit -m "feat(todos): add_todo/list_todos/complete_todo/remove_todo 工具 + promptAssembler 注入当前时间 + 挂进对话 registry"
```

---

### Task 5: IPC 契约 + 校验 + preload + petBrain 'remind' 事件

**Files:**
- Modify: `src/shared/ipc.ts`(通道常量 + `TodoApi` + `window.todoApi`)
- Modify: `src/shared/ipcValidation.ts`(`validateTodoAdd` + `validateTodoId`)
- Test: `src/shared/ipcValidation.test.ts`(加 todo 校验用例;文件已存在则追加)
- Modify: `src/shared/petBrain.ts`(`PetEvent` 加 `'remind'` + `applyEvent` 映射 greet)
- Test: `src/shared/petBrain.test.ts`(加 'remind' → greet 用例)
- Modify: `src/preload/index.ts`(暴露 `todoApi`)

**Interfaces:**
- Produces:
  - `IPC.LIST_TODOS/ADD_TODO/TOGGLE_TODO/REMOVE_TODO/TODO_UPDATE/TODO_FIRED/OPEN_TODO_PANEL`
  - `interface TodoApi { list(): Promise<TodoItem[]>; add(input: { title: string; dueAt: number | null }): Promise<TodoItem[]>; toggle(id: string): Promise<TodoItem[]>; remove(id: string): Promise<TodoItem[]>; onUpdate(cb: (items: TodoItem[]) => void): void; onFired(cb: (id: string) => void): void; openPanel(): void }`
  - `window.todoApi: TodoApi`
  - `validateTodoAdd(v): { title: string; dueAt: number | null } | null`
  - `validateTodoId(v): string | null`
  - `PetEvent` 增加 `'remind'`

- [ ] **Step 1: petBrain 'remind' — 写失败测试**

在 `src/shared/petBrain.test.ts` 追加:

```ts
describe('petBrain remind 事件', () => {
  it("'remind' 使宠物进入 greet(复用打招呼动画)", () => {
    const ctx = initBrain()
    const res = step(ctx, input({ dtMs: 0, event: 'remind' }))
    expect(res.ctx.state).toBe('greet')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: FAIL(TS 报 `'remind'` 不在 `PetEvent`,或状态不是 greet)

- [ ] **Step 3: 改 `src/shared/petBrain.ts`**

`PetEvent` 类型加 `'remind'`:

```ts
export type PetEvent = 'pickup' | 'drop' | 'wake' | 'dialogOpen' | 'dialogClose' | 'messageSent' | 'replyDone' | 'remind'
```

`applyEvent` 的 switch 里加一分支(放在 `messageSent` 附近):

```ts
    case 'remind': return { ...enterState(ctx, 'greet'), idleAccumMs: 0 }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/shared/petBrain.test.ts`
Expected: PASS

- [ ] **Step 5: ipcValidation — 写失败测试**

在 `src/shared/ipcValidation.test.ts`(若不存在则新建并 `import { validateTodoAdd, validateTodoId } from './ipcValidation'`)追加:

```ts
import { describe, it, expect } from 'vitest'
import { validateTodoAdd, validateTodoId } from './ipcValidation'

describe('validateTodoAdd', () => {
  it('合法:标题 + null dueAt', () => {
    expect(validateTodoAdd({ title: '买菜', dueAt: null })).toEqual({ title: '买菜', dueAt: null })
  })
  it('合法:标题 + 数值 dueAt', () => {
    expect(validateTodoAdd({ title: '开会', dueAt: 1_700_000_000_000 })).toEqual({ title: '开会', dueAt: 1_700_000_000_000 })
  })
  it('空标题 / 非对象 / 非法 dueAt → null', () => {
    expect(validateTodoAdd({ title: '   ', dueAt: null })).toBeNull()
    expect(validateTodoAdd(null)).toBeNull()
    expect(validateTodoAdd({ title: 'x', dueAt: 'nope' })).toBeNull()
    expect(validateTodoAdd({ title: 'x', dueAt: -5 })).toBeNull()
  })
  it('超长标题 → null', () => {
    expect(validateTodoAdd({ title: 'a'.repeat(1000), dueAt: null })).toBeNull()
  })
})

describe('validateTodoId', () => {
  it('非空字符串通过,其它 null', () => {
    expect(validateTodoId('abc')).toBe('abc')
    expect(validateTodoId('')).toBeNull()
    expect(validateTodoId(123)).toBeNull()
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL(函数未定义)

- [ ] **Step 7: 改 `src/shared/ipcValidation.ts`**

顶部 import 加 `MAX_TITLE_LEN`:

```ts
import { MAX_TITLE_LEN } from './todo'
```

文件末尾追加:

```ts
export function validateTodoAdd(v: unknown): { title: string; dueAt: number | null } | null {
  if (!isObject(v)) return null
  if (typeof v.title !== 'string') return null
  const title = v.title.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LEN) return null
  let dueAt: number | null = null
  if (v.dueAt !== null && v.dueAt !== undefined) {
    if (typeof v.dueAt !== 'number' || !Number.isFinite(v.dueAt) || v.dueAt <= 0) return null
    dueAt = v.dueAt
  }
  return { title, dueAt }
}

export function validateTodoId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null
}
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: PASS

- [ ] **Step 9: 改 `src/shared/ipc.ts` 的通道常量 + 类型**

在 `IPC` 常量对象里(`RELAUNCH_APP` 之后)追加:

```ts
  LIST_TODOS: 'todos:list',
  ADD_TODO: 'todos:add',
  TOGGLE_TODO: 'todos:toggle',
  REMOVE_TODO: 'todos:remove',
  TODO_UPDATE: 'todos:update',
  TODO_FIRED: 'todos:fired',
  OPEN_TODO_PANEL: 'todos:open-panel'
```

文件顶部 import 加 `TodoItem`:

```ts
import type { TodoItem } from './todo'
```

在 `SettingsApi` 声明之后加 `TodoApi`:

```ts
export interface TodoApi {
  list(): Promise<TodoItem[]>
  add(input: { title: string; dueAt: number | null }): Promise<TodoItem[]>
  toggle(id: string): Promise<TodoItem[]>
  remove(id: string): Promise<TodoItem[]>
  onUpdate(cb: (items: TodoItem[]) => void): void
  onFired(cb: (id: string) => void): void
  openPanel(): void
}
```

把全局声明补 `todoApi`:

```ts
declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi }
}
```

并在文件底部 `export type { PetEvent, Bounds }` 处一并导出 `TodoItem`(方便渲染层从 `@shared/ipc` 取):

```ts
export type { PetEvent, Bounds }
export type { TodoItem } from './todo'
```

- [ ] **Step 10: 改 `src/preload/index.ts` 暴露 todoApi**

import 里加 `type TodoApi, type TodoItem`(并入现有 `@shared/ipc` import 列表)。在 `overlayApi` 定义之后加:

```ts
const todoApi: TodoApi = {
  list: (): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.LIST_TODOS),
  add: (input): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.ADD_TODO, input),
  toggle: (id: string): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.TOGGLE_TODO, id),
  remove: (id: string): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.REMOVE_TODO, id),
  onUpdate: (cb: (items: TodoItem[]) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TODO_UPDATE)
    ipcRenderer.on(IPC.TODO_UPDATE, (_e, items: TodoItem[]) => cb(items))
  },
  onFired: (cb: (id: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TODO_FIRED)
    ipcRenderer.on(IPC.TODO_FIRED, (_e, id: string) => cb(id))
  },
  openPanel: (): void => ipcRenderer.send(IPC.OPEN_TODO_PANEL)
}
```

在底部 expose 段加:

```ts
contextBridge.exposeInMainWorld('todoApi', todoApi)
```

- [ ] **Step 11: 类型检查 + 相关测试**

Run: `pnpm typecheck`
Expected: PASS(无类型错误)

Run: `pnpm vitest run src/shared/petBrain.test.ts src/shared/ipcValidation.test.ts`
Expected: PASS

- [ ] **Step 12: 提交**

```bash
git add src/shared/ipc.ts src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts src/shared/petBrain.ts src/shared/petBrain.test.ts src/preload/index.ts
git commit -m "feat(todos): IPC 通道/TodoApi/todoApi 暴露 + 增删校验 + petBrain 新增 remind 事件"
```

---

### Task 6: 待办面板窗口 + shell 接线 + 到点行为(人工真机验收)

> 本 Task 是 GUI/Electron 集成层,无自动化 GUI 驱动(项目惯例);自动化只保证 `pnpm build`/`pnpm typecheck`/`pnpm test` 全绿,行为由人工在真实窗口走查。

**Files:**
- Create: `src/main/shell/todoWindow.ts`
- Create: `src/renderer/todoPanel.html`
- Create: `src/renderer/todoPanel.ts`
- Modify: `electron.vite.config.*`(渲染多入口:注册 `todoPanel.html`——参照现有 `dialog.html`/`settings.html`/`regionOverlay.html` 的入口写法)
- Modify: `src/main/shell/index.ts`(建 store/scheduler/todoWindow + IPC handlers + onFire 行为 + store.onChange→面板)
- Modify: `src/main/shell/tray.ts`(菜单加"待办清单")

**Interfaces:**
- Consumes: `createTodoStore`(Task 2)、`createScheduler`(Task 3)、`IPC`/`TodoApi`/`TodoItem`(Task 5)、`validateTodoAdd`/`validateTodoId`(Task 5)、`sortTodos`/`classify`/`formatRelative`(`@shared/todo`)
- Produces:
  - `interface TodoWindowController { open(): void; window(): BrowserWindow | null; pushUpdate(items: TodoItem[]): void; pushFired(id: string): void }`
  - `createTodoWindow(opts: { preload: string; url: string | undefined; todoHtml: string }): TodoWindowController`

- [ ] **Step 1: `src/main/shell/todoWindow.ts`**(参照 [dialogWindow.ts](../../../src/main/shell/dialogWindow.ts) 的窗口构建 + 安全基线)

```ts
import { BrowserWindow } from 'electron'
import { IPC, type TodoItem } from '@shared/ipc'

const SIZE = { width: 360, height: 480 }

export interface TodoWindowController {
  open(): void
  window(): BrowserWindow | null
  pushUpdate(items: TodoItem[]): void
  pushFired(id: string): void
}

export function createTodoWindow(opts: {
  preload: string
  url: string | undefined       // todoPanel.html 的 dev URL(含 /todoPanel.html),打包为 undefined
  todoHtml: string
}): TodoWindowController {
  let win: BrowserWindow | null = null

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: SIZE.width,
      height: SIZE.height,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    if (opts.url) w.loadURL(opts.url)
    else w.loadFile(opts.todoHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    window: () => win,
    open(): void {
      if (!win) win = build()
      win.show()
      win.focus()
    },
    pushUpdate(items: TodoItem[]): void {
      win?.webContents.send(IPC.TODO_UPDATE, items)
    },
    pushFired(id: string): void {
      win?.webContents.send(IPC.TODO_FIRED, id)
    }
  }
}
```

- [ ] **Step 2: `src/renderer/todoPanel.html`**(内联 CSP + 样式,参照 `dialog.html` 的 CSP 头)

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline';" />
  <title>待办清单</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; font-size: 13px; background: #1e1e24; color: #eee; }
    header { padding: 8px 12px; font-weight: 600; -webkit-app-region: drag; }
    #add { display: flex; gap: 6px; padding: 0 12px 8px; }
    #add input[type=text] { flex: 1; }
    input, button { background: #2a2a33; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; }
    button { cursor: pointer; }
    ul { list-style: none; margin: 0; padding: 0 12px 12px; }
    li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #333; }
    li .title { flex: 1; }
    li.done .title { text-decoration: line-through; opacity: .5; }
    li.overdue .due { color: #ff6b6b; }
    li.highlight { background: #3a3a22; border-radius: 4px; }
    .due { font-size: 11px; opacity: .7; }
    .del { border: none; background: none; color: #999; }
  </style>
</head>
<body>
  <header>⏰ 待办清单</header>
  <div id="add">
    <input id="title" type="text" placeholder="添加待办…" />
    <input id="due" type="datetime-local" />
    <button id="addBtn">＋</button>
  </div>
  <ul id="list"></ul>
  <script type="module" src="./todoPanel.ts"></script>
</body>
</html>
```

- [ ] **Step 3: `src/renderer/todoPanel.ts`**(用 `window.todoApi` + 共享纯逻辑渲染)

```ts
import { sortTodos, classify, formatRelative, type TodoItem } from '@shared/todo'

const listEl = document.getElementById('list') as HTMLUListElement
const titleEl = document.getElementById('title') as HTMLInputElement
const dueEl = document.getElementById('due') as HTMLInputElement
const addBtn = document.getElementById('addBtn') as HTMLButtonElement

let firedId: string | null = null

function render(items: TodoItem[]): void {
  const now = Date.now()
  listEl.innerHTML = ''
  for (const it of sortTodos(items, now)) {
    const li = document.createElement('li')
    const st = classify(it, now)
    li.className = [st === 'done' ? 'done' : '', st === 'overdue' ? 'overdue' : '', it.id === firedId ? 'highlight' : ''].filter(Boolean).join(' ')

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = it.done
    cb.onchange = async () => { render(await window.todoApi.toggle(it.id)) }

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = it.title

    const due = document.createElement('span')
    due.className = 'due'
    if (it.dueAt !== null) due.textContent = st === 'overdue' ? '已过期' : formatRelative(it.dueAt, now)

    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = '✕'
    del.onclick = async () => { render(await window.todoApi.remove(it.id)) }

    li.append(cb, title, due, del)
    listEl.appendChild(li)
  }
}

async function add(): Promise<void> {
  const title = titleEl.value.trim()
  if (!title) return
  const dueAt = dueEl.value ? new Date(dueEl.value).getTime() : null
  const items = await window.todoApi.add({ title, dueAt })
  titleEl.value = ''
  dueEl.value = ''
  render(items)
}

addBtn.onclick = () => { void add() }
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void add() })

window.todoApi.onUpdate((items) => render(items))
window.todoApi.onFired((id) => { firedId = id; void window.todoApi.list().then(render) })

void window.todoApi.list().then(render)
```

- [ ] **Step 4: 渲染多入口注册**

打开 `electron.vite.config.*`,在 renderer 的 `build.rollupOptions.input` 里,仿照已有的 `dialog`/`settings`/`regionOverlay` 入口,加一行 `todoPanel: resolve(__dirname, 'src/renderer/todoPanel.html')`(键名与路径按现有条目的实际写法对齐)。

- [ ] **Step 5: 接线 `src/main/shell/index.ts`**

顶部 import 增加:

```ts
import { createTodoStore } from '../todos/todoStore'
import { createScheduler } from '../todos/scheduler'
import { createTodoWindow } from './todoWindow'
import { validateTodoAdd, validateTodoId } from '@shared/ipcValidation'
import { Notification } from 'electron'
```

(`Notification` 也可并入首行现有的 `electron` 解构 import。)

在 `const chat = createChatStore({...})` **之前**建 store（chat 要用到它):

```ts
  const todoStore = createTodoStore({ file: join(userData, 'todos.json') })
```

并把 `todoStore` 加进 `createChatStore({ ... })` 的参数(与 `memory` 并列)。

在 `createChatStore` 之后建面板窗口与到点行为:

```ts
  const todoPanelHtml = join(dirname, '../renderer/todoPanel.html')
  const todoWin = createTodoWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/todoPanel.html` : undefined,
    todoHtml: todoPanelHtml
  })

  // 到点三件套:系统通知 + 宠物 greet + 气泡 + 自动弹面板高亮
  function fireReminder(item: import('@shared/todo').TodoItem): void {
    if (Notification.isSupported()) new Notification({ title: '⏰ 提醒', body: item.title }).show()
    emitPetEvent('remind')
    if (!dialog.isOpen()) dialog.toggle(petBounds)
    dialog.window()?.webContents.send(IPC.CHAT_STATUS, `⏰ 提醒:${item.title}`)
    todoWin.open()
    todoWin.pushFired(item.id)
  }
  function catchupReminders(items: import('@shared/todo').TodoItem[]): void {
    const title = items.length > 1 ? `⏰ ${items.length} 条提醒已过期` : '⏰ 提醒'
    const body = items.length > 1 ? items.map((i) => i.title).join('、') : items[0].title
    if (Notification.isSupported()) new Notification({ title, body }).show()
    emitPetEvent('remind')
    todoWin.open()
    todoWin.pushFired(items[0].id)
  }

  const scheduler = createScheduler({
    store: todoStore,
    now: () => Date.now(),
    onFire: fireReminder,
    onCatchup: catchupReminders
  })

  // store 变更(工具/面板/到点)→ 推面板刷新(scheduler 已自行订阅重算)
  todoStore.onChange(() => todoWin.pushUpdate(todoStore.list()))
```

在其它 `ipcMain.handle(...)` 附近注册 todo handlers:

```ts
  ipcMain.handle(IPC.LIST_TODOS, async () => todoStore.list())
  ipcMain.handle(IPC.ADD_TODO, async (_e, raw) => {
    const input = validateTodoAdd(raw)
    if (input) todoStore.add(input)
    return todoStore.list()
  })
  ipcMain.handle(IPC.TOGGLE_TODO, async (_e, raw) => {
    const id = validateTodoId(raw)
    if (id) todoStore.toggleDone(id)
    return todoStore.list()
  })
  ipcMain.handle(IPC.REMOVE_TODO, async (_e, raw) => {
    const id = validateTodoId(raw)
    if (id) todoStore.remove(id)
    return todoStore.list()
  })
  ipcMain.on(IPC.OPEN_TODO_PANEL, () => todoWin.open())
```

在 `registerHotkeys(...)`/`tray = createTray(...)` 附近(所有窗口与 chat 已就绪后)启动调度器:

```ts
  scheduler.start()
```

并在 `app.on('will-quit', ...)` 里补 `scheduler.stop()`:

```ts
  app.on('will-quit', () => { unregisterHotkeys(); scheduler.stop() })
```

- [ ] **Step 6: 托盘加入口 `src/main/shell/tray.ts`**

给 `createTray` 的 `handlers` 加 `onTodos: () => void`,并在菜单模板里加一项(放"设置"之前):

```ts
export function createTray(
  iconPath: string,
  handlers: { onSettings: () => void; onQuickAction: (id: string) => void; onTodos: () => void }
): Tray {
  // ...
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '快捷加工', submenu: QUICK_ACTIONS.map((a) => ({ label: a.label, click: () => handlers.onQuickAction(a.id) })) },
    { type: 'separator' },
    { label: '待办清单', click: () => handlers.onTodos() },
    { label: '设置', click: () => handlers.onSettings() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  return tray
}
```

在 `index.ts` 的 `createTray(...)` 调用里补 `onTodos: () => todoWin.open()`。

- [ ] **Step 7: 自动化全绿**

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm build`
Expected: 三包构建成功(含新 renderer 入口 `todoPanel.html`)

Run: `pnpm test`
Expected: 全量测试通过(新增用例并入,原有用例不回归)

- [ ] **Step 8: 人工真机验收(逐项打勾)**

Run: `pnpm build && pnpm preview`(比 dev 更稳),按清单走查:

- [ ] 托盘右键有"待办清单",点开弹出面板窗口。
- [ ] 面板顶部输入标题 + 可选时间 → ＋ 添加,列表即时出现该项。
- [ ] 勾选复选框 → 标题划线(完成);✕ → 删除。
- [ ] 对宠物说"3分钟后提醒我喝水"(需已配置 Provider/Key)→ 宠物回话确认;面板出现该提醒且显示"3分钟后"。
- [ ] 到点:① 弹系统通知 ② 宠物播 greet 动画 ③ 对话框气泡出现"⏰ 提醒:喝水" ④ 面板自动弹出并高亮该条。
- [ ] 设一个 1 分钟后的提醒 → 退出应用 → 过 2 分钟重开 → 启动即补弹一次通知,面板里该项标"已过期"。
- [ ] "我有哪些待办" → 宠物调 list_todos 念出清单。
- [ ] 关掉再重开应用,`%APPDATA%\Pet-Agent\todos.json` 里的待办仍在;换 activePetId 重启后待办仍在(证明全局存储)。

- [ ] **Step 9: 提交**

```bash
git add src/main/shell/todoWindow.ts src/renderer/todoPanel.html src/renderer/todoPanel.ts src/main/shell/index.ts src/main/shell/tray.ts electron.vite.config.*
git commit -m "feat(todos): 待办面板窗口 + 托盘入口 + 到点三件套(通知/greet/气泡/弹面板)+ 启动补提醒接线"
```

---

## Self-Review

**Spec coverage**（对照 spec 各节):
- §2 数据模型 → Task 1 ✅
- §3 存储(全局 todos.json 原子写、退化、onChange)→ Task 2 ✅
- §4 调度器(单定时器最近项、封顶续弦、启动补提醒)→ Task 3 ✅
- §5 到点行为(通知/greet/气泡/弹面板 + 补提醒合并)→ Task 6 Step 5 + Task 5(remind 事件)✅
- §6 Agent 工具 + 当前时间注入 → Task 4 ✅
- §7 面板窗口 + 手动增删 → Task 6 ✅
- §8 IPC 契约 + 校验 + 提醒不落 transcript(到点仅走 CHAT_STATUS 气泡,不 appendMessage)→ Task 5 + Task 6 ✅
- §9 测试 & 验收 → 各 Task 的测试步骤 + Task 6 Step 8 ✅
- §10 非目标(循环/贪睡/声音)→ 未纳入任何 Task ✅
- §11 改动清单 → 与各 Task Files 一致 ✅

**Placeholder scan:** 无 TBD/TODO;每个改动步骤均给出完整代码或精确到行/字段的修改说明。`electron.vite.config` 入口写法要求"对齐现有条目",因该配置文件内容未在 spec 固定,实现者需照抄同目录现有 renderer 入口格式——这是有意的"跟随既有模式",非占位。

**Type consistency:** `TodoItem` 七字段在 Task 1 定义,Task 2/3/4/5/6 全程复用同名同型;`TodoStore` 方法名(`list/add/toggleDone/remove/markFired/onChange`)Task 2 定义后一致引用;`createScheduler`/`createTodoTools`/`createTodoWindow`/`TodoApi` 签名在各自 Interfaces 块声明并在实现中吻合;`nextDueItem`(非 `nextDueAt`)全程统一。
