/**
 * 把模型回复的原始 Markdown/特殊符号文本,转成适合朗读的纯文本。
 * 只处理"发音前归一化",不做任何朗读语言/翻译相关的事情。
 */

const CODE_FENCE = /```[\s\S]*?```/g

/** 是否为 Markdown 表格的分隔行(如 |----|----| 或 |:--|:-:|)——与 renderer/markdown.ts 的同名判断保持一致。 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')
}

/** 表格数据行 → 纯文本(去掉首尾竖线,单元格用 · 连接)——与 renderer/markdown.ts 的处理风格保持一致。 */
function tableRowToText(line: string): string {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(' · ')
}

function stripInlineMarkdown(s: string): string {
  s = s.replace(/`[^`]*`/g, '') // 行内代码整体丢弃
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接只留文字
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1') // 加粗
  s = s.replace(/\*([^*\n]+)\*/g, '$1') // 斜体(*)
  s = s.replace(/_([^_\n]+)_/g, '$1') // 斜体(_)
  return s
}

const SYMBOL_MAP: Record<string, string> = {
  '℃': '摄氏度',
  '℉': '华氏度',
  '%': '百分之',
  '×': '乘',
  '÷': '除以',
  '≥': '大于等于',
  '≤': '小于等于',
  '≠': '不等于',
  '≈': '约等于',
  '±': '正负',
  '°': '度'
}
const SYMBOL_PATTERN = /[℃℉%×÷≥≤≠≈±°]/g

function mapSymbols(s: string): string {
  return s.replace(SYMBOL_PATTERN, (ch) => SYMBOL_MAP[ch] ?? ch)
}

export function toSpeakableText(raw: string): string {
  const noCode = raw.replace(CODE_FENCE, '')
  const lines = noCode.split(/\r?\n/).map((line) => {
    if (isTableSeparator(line)) return null
    let l = line
    const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (bullet) l = bullet[1]
    const header = l.match(/^\s*#{1,6}\s+(.*)$/)
    if (header) l = header[1]
    if (l.includes('|')) l = tableRowToText(l)
    l = stripInlineMarkdown(l)
    l = mapSymbols(l)
    return l
  })
  return lines.filter((l): l is string => l !== null).join('\n')
}
