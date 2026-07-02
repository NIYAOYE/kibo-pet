import type { ChatMessage } from '@shared/ipc'

const BUBBLE_MS = 4000

const panel = document.getElementById('panel') as HTMLElement
const bubble = document.getElementById('bubble') as HTMLElement
const history = document.getElementById('history') as HTMLElement
const input = document.getElementById('input') as HTMLInputElement
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement

let collapsed = true
let bubbleTimer: number | null = null
let streaming = '' // 进行中的 pet 回复(逐字累积)

function showBubble(text: string): void {
  bubble.textContent = text
  bubble.classList.add('show')
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), BUBBLE_MS)
}

function renderStreaming(): void {
  let temp = document.getElementById('streaming-msg')
  if (!temp) {
    temp = document.createElement('div')
    temp.id = 'streaming-msg'
    temp.className = 'msg pet'
    history.appendChild(temp)
  }
  temp.textContent = streaming
  history.scrollTop = history.scrollHeight
}

function render(messages: ChatMessage[]): void {
  const temp = document.getElementById('streaming-msg')
  if (temp) temp.remove()
  history.innerHTML = ''
  for (const m of messages) {
    const el = document.createElement('div')
    el.className = `msg ${m.role}`
    el.textContent = m.text
    history.appendChild(el)
  }
  history.scrollTop = history.scrollHeight
  const lastPet = [...messages].reverse().find((m) => m.role === 'pet')
  if (lastPet) showBubble(lastPet.text)
}

function setCollapsed(c: boolean): void {
  collapsed = c
  panel.classList.toggle('collapsed', c)
  panel.classList.toggle('expanded', !c)
  toggleBtn.textContent = c ? '⤢' : '⤡'
  toggleBtn.title = c ? '展开' : '收起'
  window.chatApi.setSize(c)
  // Returning to collapsed: re-show the last reply bubble (its fade timer may have
  // elapsed while expanded/hidden), so the thin bar shows the latest reply again.
  if (c && bubble.textContent) showBubble(bubble.textContent)
}

function submit(): void {
  const text = input.value.trim()
  if (!text) return
  // 开新一轮:立即抹掉上一条(正在流式/将被取消)回复的累积与显示,让"打断"在视觉上
  // 即时生效——不必等主进程回推 CHAT_UPDATE。否则 collapsed 气泡会残留旧文字直到淡出,
  // 且被取消回复的残留前缀会串进新回复(取消结果被静默丢弃,不发 onDone/onError)。
  streaming = ''
  document.getElementById('streaming-msg')?.remove()
  if (bubbleTimer !== null) { clearTimeout(bubbleTimer); bubbleTimer = null }
  bubble.classList.remove('show')
  bubble.textContent = ''
  window.chatApi.send({ text })
  input.value = ''
}

toggleBtn.addEventListener('click', () => setCollapsed(!collapsed))
sendBtn.addEventListener('click', submit)
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
window.chatApi.onUpdate(render)
window.chatApi.onStream((text) => {
  streaming += text
  showBubble(streaming)
  renderStreaming()
})
window.chatApi.onDone(() => { streaming = '' })
window.chatApi.onError((message) => {
  streaming = ''
  showBubble(`⚠ ${message}`)
  const el = document.createElement('div')
  el.className = 'msg pet'
  el.textContent = `⚠ ${message}`
  history.appendChild(el)
  history.scrollTop = history.scrollHeight
})

// 渲染层是折叠态的唯一真源:窗口每次重新显示时,把当前折叠态重新告知主进程,
// 纠正主进程窗口尺寸与面板态可能出现的不同步(否则展开后关闭再开会卡在错误尺寸,无法恢复)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.chatApi.setSize(collapsed)
})

setCollapsed(true)
