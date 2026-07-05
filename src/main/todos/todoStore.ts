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
