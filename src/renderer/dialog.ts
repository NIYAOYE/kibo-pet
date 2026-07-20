import type { ChatMessage, ChatSendAttachment, PetChatListItem } from '@shared/ipc'
import { frameRect } from '@shared/petPackage'
import { renderMarkdownSafe } from './markdown'
import { groupMessages, formatClockTime } from './chatFormat'

const panel = document.getElementById('panel') as HTMLElement
const history = document.getElementById('history') as HTMLElement
const input = document.getElementById('input') as HTMLTextAreaElement
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const pickBtn = document.getElementById('pick') as HTMLButtonElement
const shotBtn = document.getElementById('shot') as HTMLButtonElement
const attachStrip = document.getElementById('attach') as HTMLElement
const avatarEl = document.getElementById('avatar') as HTMLElement
const petNameEl = document.getElementById('pet-name') as HTMLElement
const headCollapseBtn = document.getElementById('headCollapse') as HTMLButtonElement
const petListEl = document.getElementById('pet-list') as HTMLElement

const MAX_ATTACH = 6
let pending: ChatSendAttachment[] = []
let avatarDataUrl = ''

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
  reportCollapsedHeight()
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

/** 从宠物 spritesheet 裁出 idle 动画首帧,作为聊天室头像;失败(如包缺 idle 动画)时静默放弃,
 *  头像元素退回 CSS 里的浅紫底色占位,不影响聊天功能本身。 */
async function loadAvatar(): Promise<void> {
  const pet = await window.petApi.getPet()
  petNameEl.textContent = pet.manifest.displayName
  const idle = pet.manifest.animations.idle
  if (!idle) return
  const rect = frameRect(pet.manifest.sheet, idle.row, 0)
  const img = new Image()
  img.src = pet.spritesheetDataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  avatarDataUrl = canvas.toDataURL()
  avatarEl.style.backgroundImage = `url(${avatarDataUrl})`
}

/** 左栏一行:头像(裁不出则退回 CSS 色块占位)+ 名字 + 末条预览;当前活跃宠物高亮且不可点。 */
function renderPetList(items: PetChatListItem[]): void {
  petListEl.innerHTML = ''
  for (const it of items) {
    const row = document.createElement('div')
    row.className = it.active ? 'pet-row active' : 'pet-row'
    const av = document.createElement('div')
    av.className = 'pr-avatar'
    if (it.avatarDataUrl) av.style.backgroundImage = `url(${it.avatarDataUrl})`
    const text = document.createElement('div')
    text.className = 'pr-text'
    const name = document.createElement('div')
    name.className = 'pr-name'
    name.textContent = it.displayName
    const last = document.createElement('div')
    last.className = 'pr-last'
    last.textContent = it.lastMessage ?? '还没聊过'
    text.append(name, last)
    row.append(av, text)
    if (!it.active) row.addEventListener('click', () => { void switchTo(it.id) })
    petListEl.appendChild(row)
  }
}

async function refreshPetList(): Promise<void> {
  try { renderPetList(await window.chatApi.listPetsForChat()) }
  catch (e) { console.warn('list pets failed', e) }
}

let switching = false
async function switchTo(petId: string): Promise<void> {
  if (switching) return
  switching = true
  try { await window.chatApi.switchPet(petId) }
  finally { switching = false }
  // 切换结果由 onSwitched 推送驱动界面刷新,这里不直接改 UI
}

let collapsed = true
let streaming = '' // 进行中的 pet 回复(逐字累积)
let streamingStartTime = 0
let statusEl: HTMLElement | null = null

function clearStatus(): void {
  document.getElementById('status-row')?.remove()
  statusEl = null
}

/** 组装一行消息:pet 一侧在左带头像(或占位)+ 时间在气泡右侧,user 一侧在右、时间在气泡左侧。 */
function buildRow(role: ChatMessage['role'], bubbleEl: HTMLElement, timestamp: number | undefined, showAvatar: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = `row ${role}`
  if (role === 'pet') {
    const av = document.createElement('div')
    av.className = showAvatar ? 'mini-avatar' : 'avatar-spacer'
    if (showAvatar && avatarDataUrl) av.style.backgroundImage = `url(${avatarDataUrl})`
    row.appendChild(av)
  }
  const time = timestamp != null ? formatClockTime(timestamp) : null
  if (role === 'user' && time) {
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = time
    row.appendChild(t)
  }
  row.appendChild(bubbleEl)
  if (role === 'pet' && time) {
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = time
    row.appendChild(t)
  }
  return row
}

function buildBubble(m: ChatMessage): HTMLElement {
  const el = document.createElement('div')
  el.className = `bubble ${m.role}`
  // pet 回复渲染安全 Markdown 子集(转义后再套有限规则,防注入);用户消息保持纯文本。
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
  return el
}

function renderStreaming(): void {
  let row = document.getElementById('streaming-row') as HTMLElement | null
  if (!row) {
    streamingStartTime = Date.now()
    const bubble = document.createElement('div')
    bubble.className = 'bubble pet'
    bubble.id = 'streaming-bubble'
    row = buildRow('pet', bubble, streamingStartTime, true)
    row.id = 'streaming-row'
    history.appendChild(row)
  }
  const bubble = document.getElementById('streaming-bubble') as HTMLElement
  bubble.textContent = streaming
  history.scrollTop = history.scrollHeight
}

function render(messages: ChatMessage[]): void {
  clearStatus()
  document.getElementById('streaming-row')?.remove()
  history.innerHTML = ''
  for (const group of groupMessages(messages)) {
    const groupEl = document.createElement('div')
    groupEl.className = 'group'
    if (group.role === 'pet') {
      const tag = document.createElement('div')
      tag.className = 'name-tag'
      tag.textContent = petNameEl.textContent ?? ''
      groupEl.appendChild(tag)
    }
    group.messages.forEach((m, i) => {
      const bubble = buildBubble(m)
      groupEl.appendChild(buildRow(m.role, bubble, m.timestamp, i === 0))
    })
    history.appendChild(groupEl)
  }
  history.scrollTop = history.scrollHeight
}

function reportCollapsedHeight(): void {
  if (!collapsed) return
  // 折叠态 #panel 为 height:auto,getBoundingClientRect().height 即内容自然高度
  requestAnimationFrame(() => {
    if (!collapsed) return
    const h = Math.ceil(panel.getBoundingClientRect().height)
    window.chatApi.reportCollapsedHeight(h)
  })
}

function setCollapsed(c: boolean): void {
  collapsed = c
  panel.classList.toggle('collapsed', c)
  panel.classList.toggle('expanded', !c)
  toggleBtn.textContent = c ? '⤢' : '⤡'
  toggleBtn.title = c ? '展开' : '收起'
  window.chatApi.setSize(c)
  reportCollapsedHeight()
  if (!c) void refreshPetList()
}

function submit(): void {
  const text = input.value.trim()
  if (!text && pending.length === 0) return
  // 开新一轮:立即抹掉上一条(正在流式/将被取消)回复的累积与显示,让"打断"在视觉上
  // 即时生效——不必等主进程回推 CHAT_UPDATE。否则 collapsed 气泡会残留旧文字直到淡出,
  // 且被取消回复的残留前缀会串进新回复(取消结果被静默丢弃,不发 onDone/onError)。
  streaming = ''
  document.getElementById('streaming-row')?.remove()
  clearStatus()
  window.chatApi.send({ text, attachments: pending.length ? pending : undefined })
  input.value = ''
  input.style.height = 'auto'
  pending = []
  renderPending()
}

toggleBtn.addEventListener('click', () => setCollapsed(!collapsed))
headCollapseBtn.addEventListener('click', () => setCollapsed(true))
sendBtn.addEventListener('click', submit)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  // Shift+Enter / 输入法组合中 → 走默认,插入换行
})
// textarea 随内容自增高(上限由 CSS max-height 接管,超出内部滚动)
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
  reportCollapsedHeight()
})
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
window.chatApi.onUpdate((messages) => {
  render(messages)
  void refreshPetList()
})
window.chatApi.onSwitched((p) => {
  petNameEl.textContent = p.displayName          // 立即更新右栏名字(避免等 loadAvatar)
  void loadAvatar().catch(() => { /* 头像纯装饰,失败不影响聊天功能 */ })  // 刷新右栏头像 + 内部 avatarDataUrl
  void refreshPetList()                           // 刷新左栏高亮 + 预览
})
window.chatApi.onStream((text) => {
  clearStatus()
  streaming += text
  renderStreaming()
})
window.chatApi.onDone(() => { streaming = '' })
window.chatApi.onError((message) => {
  clearStatus()
  streaming = ''
  const bubble = document.createElement('div')
  bubble.className = 'bubble pet'
  bubble.textContent = `⚠ ${message}`
  history.appendChild(buildRow('pet', bubble, Date.now(), true))
  history.scrollTop = history.scrollHeight
})
window.chatApi.onStatus((text) => {
  if (!statusEl) {
    const bubble = document.createElement('div')
    bubble.className = 'bubble pet status'
    bubble.id = 'status-bubble'
    const row = buildRow('pet', bubble, undefined, true)
    row.id = 'status-row'
    history.appendChild(row)
    statusEl = bubble
  }
  statusEl.textContent = `🔍 ${text}`
  history.scrollTop = history.scrollHeight
})

// 渲染层是折叠态的唯一真源:窗口每次重新显示时,把当前折叠态重新告知主进程,
// 纠正主进程窗口尺寸与面板态可能出现的不同步(否则展开后关闭再开会卡在错误尺寸,无法恢复)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    window.chatApi.setSize(collapsed)
    reportCollapsedHeight()
  }
})

setCollapsed(true)
void loadAvatar().catch(() => { /* 头像纯装饰,加载失败不影响聊天功能 */ })
