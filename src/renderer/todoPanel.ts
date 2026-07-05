import { sortTodos, classify, formatRelative, type TodoItem } from '@shared/todo'

const listEl = document.getElementById('list') as HTMLUListElement
const titleEl = document.getElementById('title') as HTMLInputElement
const dueEl = document.getElementById('due') as HTMLInputElement
const addBtn = document.getElementById('addBtn') as HTMLButtonElement
const closeBtn = document.getElementById('closeBtn') as HTMLButtonElement

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
closeBtn.onclick = () => { window.close() }

window.todoApi.onUpdate((items) => render(items))
window.todoApi.onFired((id) => { firedId = id; void window.todoApi.list().then(render) })

void window.todoApi.list().then(render)
