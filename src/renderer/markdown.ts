/**
 * 极简安全 Markdown 渲染器(桌宠对话气泡用)。
 *
 * 设计取舍:
 * - 只覆盖常见子集(加粗/斜体/行内代码/标题/无序列表/链接),小气泡里不追求全语法。
 * - 安全第一:搜索结果是不可信内容,模型可能把带标签的文本原样回显。所以**先整体转义
 *   HTML**,再在转义后的文本上套用有限的 Markdown 规则——本模块引入的标签只有自己生成
 *   的 <strong>/<em>/<code>/<a>/<ul>/<li>/<br>,不可能被注入出 <script>/<img onerror>。
 * - 链接只放行 http(s),javascript:/data: 等一律降级为纯文字,杜绝脚本协议注入。
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 行内规则。输入必须是已 HTML 转义的文本。 */
function inline(s: string): string {
  // Markdown 链接 [文字](http链接)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" class="md-link">$1</a>')
  // Markdown 链接但协议不是 http(s)(如 javascript:)→ 丢掉不安全的 href,只留文字
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 裸 http(s) URL → 链接;lookbehind 跳过刚生成的 href="..." 里的 URL,避免二次包裹
  s = s.replace(/(?<!")(https?:\/\/[^\s<)"]+)/g, '<a href="$1" class="md-link">$1</a>')
  // 加粗 / 斜体 / 行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return s
}

/** 是否为 Markdown 表格的分隔行(如 |----|----| 或 |:--|:-:|)。 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')
}

/** 表格数据行 → 普通文本(去掉首尾竖线,单元格用间隔符连接),避免满屏竖线。 */
function tableRowToText(line: string): string {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(' · ')
}

export function renderMarkdownSafe(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/)
  const blocks: string[] = []
  let listItems: string[] = []
  let textLines: string[] = []
  const flushList = (): void => {
    if (listItems.length) { blocks.push(`<ul>${listItems.join('')}</ul>`); listItems = [] }
  }
  const flushText = (): void => {
    if (textLines.length) { blocks.push(textLines.join('<br>')); textLines = [] }
  }

  for (const line of lines) {
    if (isTableSeparator(line)) { continue } // 分隔行丢弃
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (bullet) { flushText(); listItems.push(`<li>${inline(bullet[1])}</li>`); continue }
    flushList()
    const header = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (header) { flushText(); blocks.push(`<strong>${inline(header[1])}</strong>`); continue }
    if (line.trim() === '') { flushText(); continue } // 空行分段
    if (line.includes('|')) { textLines.push(inline(tableRowToText(line))); continue }
    textLines.push(inline(line))
  }
  flushText()
  flushList()
  return blocks.join('<br>')
}
