import { renderMarkdownSafe } from './markdown'

const box = document.getElementById('box') as HTMLElement
const tail = document.getElementById('tail') as HTMLElement

let streaming = '' // 流式累积的纯文本

// 内容变化后测量 box+tail 的自然高度并上报主进程；rAF 合并高频调用(逐 token 流式输出时
// 最多每帧上报一次)，主进程夹取范围后重新摆位，实现"跟手实时长高"且不打爆 IPC。
let resizeScheduled = false
function scheduleReportSize(): void {
  if (resizeScheduled) return
  resizeScheduled = true
  requestAnimationFrame(() => {
    resizeScheduled = false
    window.bubbleApi.reportSize(box.scrollHeight + tail.offsetHeight)
  })
}

function clear(): void {
  streaming = ''
  box.textContent = ''
  box.classList.remove('status')
}

// 打开外部链接由主进程 will-navigate/openExternal 兜底,这里无需处理。
window.bubbleApi.onClear(() => clear())

// 自主/触碰台词：定格一句纯文本（非流式、非 Markdown 富渲染），auto-hide 由主进程控
window.bubbleApi.onLine((text) => {
  clear()
  box.textContent = text
  scheduleReportSize()
})

window.bubbleApi.onStream((text) => {
  box.classList.remove('status')
  streaming += text
  box.textContent = streaming            // 流式期间纯文本,避免半截标签闪烁
  box.scrollTop = box.scrollHeight
  scheduleReportSize()
})

window.bubbleApi.onStatus((text) => {
  // 状态行(检索中等)不并入回复累积;有回复文本时忽略状态,免得盖掉正文
  if (streaming) return
  box.classList.add('status')
  box.textContent = `🔍 ${text}`
  scheduleReportSize()
})

window.bubbleApi.onDone(() => {
  // 完成:把累积纯文本定格为安全 Markdown 子集
  if (streaming) box.innerHTML = renderMarkdownSafe(streaming)
  box.scrollTop = box.scrollHeight
  scheduleReportSize()
})

window.bubbleApi.onError((message) => {
  streaming = ''
  box.classList.remove('status')
  box.textContent = `⚠ ${message}`
  scheduleReportSize()
})

window.bubbleApi.onPlace((p) => {
  document.body.classList.toggle('tail-bottom', p.tailSide === 'bottom')
  document.body.classList.toggle('tail-top', p.tailSide === 'top')
  tail.style.setProperty('--tail-x', `${p.tailOffsetX}px`)
})
