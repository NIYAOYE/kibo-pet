import type { ToolSpec } from './toolSpec'
import type { TodoStore } from '../todos/todoStore'
import { sortTodos, classify, formatRelative, MAX_TITLE_LEN, type TodoItem } from '@shared/todo'

function resolveTarget(items: TodoItem[], arg: { id?: unknown; title?: unknown }):
  { ok: true; item: TodoItem } | { ok: false; message: string } {
  if (typeof arg.id === 'string' && arg.id.length > 0) {
    const idQuery = arg.id
    const exact = items.find((it) => it.id === idQuery)
    if (exact) return { ok: true, item: exact }
    const idMatches = items.filter((it) => it.id.startsWith(idQuery))
    if (idMatches.length === 1) return { ok: true, item: idMatches[0] }
    if (idMatches.length === 0) return { ok: false, message: `没找到 id 为「${idQuery}」的待办。用 list_todos 看看现有待办。` }
    return { ok: false, message: `有多条待办的 id 都以「${idQuery}」开头,请提供更长的 id 前缀。` }
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
