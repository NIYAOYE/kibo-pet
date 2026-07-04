import type { ChatMessage, ChatSendAttachment } from '@shared/ipc'
import { renderMarkdownSafe } from './markdown'

const BUBBLE_MS = 4000

const panel = document.getElementById('panel') as HTMLElement
const bubble = document.getElementById('bubble') as HTMLElement
const history = document.getElementById('history') as HTMLElement
const input = document.getElementById('input') as HTMLInputElement
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const pickBtn = document.getElementById('pick') as HTMLButtonElement
const shotBtn = document.getElementById('shot') as HTMLButtonElement
const attachStrip = document.getElementById('attach') as HTMLElement

const MAX_ATTACH = 6
let pending: ChatSendAttachment[] = []

function renderPending(): void {
  attachStrip.innerHTML = ''
  attachStrip.style.display = pending.length ? 'flex' : 'none'
  pending.forEach((a, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'thumb'
    const im = document.createElement('img')
    im.src = `data:${a.mimeType};base64,${a.dataBase64}`
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = '移除'
    x.addEventListener('click', () => { pending.splice(i, 1); renderPending() })
    wrap.append(im, x)
    attachStrip.appendChild(wrap)
  })
}

function addPending(atts: ChatSendAttachment[]): void {
  for (const a of atts) { if (pending.length >= MAX_ATTACH) break; pending.push(a) }
  renderPending()
}

/** 渲染层统一降采样到 ≤1568 JPEG,保证 IPC payload 有界 */
async function downscale(file: File, maxEdge = 1568): Promise<ChatSendAttachment> {
  const bmp = await createImageBitmap(file)
  const longest = Math.max(bmp.width, bmp.height)
  const s = longest > maxEdge ? maxEdge / longest : 1
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const url = c.toDataURL('image/jpeg', 0.85)
  return { kind: 'image', mimeType: 'image/jpeg', dataBase64: url.split(',')[1] }
}

async function addFiles(files: Iterable<File>): Promise<void> {
  const out: ChatSendAttachment[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try { out.push(await downscale(f)) } catch { /* 跳过坏图 */ }
  }
  if (out.length) addPending(out)
}

let collapsed = true
let bubbleTimer: number | null = null
let streaming = '' // 进行中的 pet 回复(逐字累积)
let statusEl: HTMLElement | null = null

function clearStatus(): void {
  document.getElementById('status-msg')?.remove()
  statusEl = null
}

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
  clearStatus()
  const temp = document.getElementById('streaming-msg')
  if (temp) temp.remove()
  history.innerHTML = ''
  for (const m of messages) {
    const el = document.createElement('div')
    el.className = `msg ${m.role}`
    // pet 回复渲染安全 Markdown 子集(转义后再套有限规则,防注入);用户消息保持纯文本。
    // 流式过程中仍是纯文本(renderStreaming),完成时主进程回推 CHAT_UPDATE 触发本函数,
    // 消息由纯文本"定格"为格式化 Markdown,避免半截标签的闪烁。
    if (m.role === 'pet') {
      el.innerHTML = renderMarkdownSafe(m.text)
    } else {
      const n = m.attachments?.length ?? 0
      if (n > 0) {
        const mark = document.createElement('span')
        mark.className = 'imgmark'
        mark.textContent = `🖼×${n}`
        el.appendChild(mark)
      }
      el.appendChild(document.createTextNode(m.text))
    }
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
  if (!text && pending.length === 0) return
  // 开新一轮:立即抹掉上一条(正在流式/将被取消)回复的累积与显示,让"打断"在视觉上
  // 即时生效——不必等主进程回推 CHAT_UPDATE。否则 collapsed 气泡会残留旧文字直到淡出,
  // 且被取消回复的残留前缀会串进新回复(取消结果被静默丢弃,不发 onDone/onError)。
  streaming = ''
  document.getElementById('streaming-msg')?.remove()
  clearStatus()
  if (bubbleTimer !== null) { clearTimeout(bubbleTimer); bubbleTimer = null }
  bubble.classList.remove('show')
  bubble.textContent = ''
  window.chatApi.send({ text, attachments: pending.length ? pending : undefined })
  input.value = ''
  pending = []
  renderPending()
}

toggleBtn.addEventListener('click', () => setCollapsed(!collapsed))
sendBtn.addEventListener('click', submit)
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
pickBtn.addEventListener('click', async () => {
  const atts = await window.mediaApi.pickImage()
  if (atts.length) addPending(atts)
})
shotBtn.addEventListener('click', async () => {
  const att = await window.mediaApi.captureRegion()
  if (att) addPending([att])
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
})
window.addEventListener('paste', (e) => {
  const files: File[] = []
  for (const it of e.clipboardData?.items ?? []) {
    if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f) }
  }
  if (files.length) void addFiles(files)
})
window.chatApi.onUpdate(render)
window.chatApi.onStream((text) => {
  clearStatus()
  streaming += text
  showBubble(streaming)
  renderStreaming()
})
window.chatApi.onDone(() => { streaming = '' })
window.chatApi.onError((message) => {
  clearStatus()
  streaming = ''
  showBubble(`⚠ ${message}`)
  const el = document.createElement('div')
  el.className = 'msg pet'
  el.textContent = `⚠ ${message}`
  history.appendChild(el)
  history.scrollTop = history.scrollHeight
})
window.chatApi.onStatus((text) => {
  showBubble(`🔍 ${text}`)
  if (!statusEl) {
    statusEl = document.createElement('div')
    statusEl.id = 'status-msg'
    statusEl.className = 'msg pet status'
    history.appendChild(statusEl)
  }
  statusEl.textContent = `🔍 ${text}`
  history.scrollTop = history.scrollHeight
})

// 渲染层是折叠态的唯一真源:窗口每次重新显示时,把当前折叠态重新告知主进程,
// 纠正主进程窗口尺寸与面板态可能出现的不同步(否则展开后关闭再开会卡在错误尺寸,无法恢复)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.chatApi.setSize(collapsed)
})

setCollapsed(true)
