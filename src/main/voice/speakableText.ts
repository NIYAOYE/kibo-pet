/**
 * 把模型回复的原始 Markdown/特殊符号文本,转成适合朗读的纯文本。
 * 只处理"发音前归一化",不做任何朗读语言/翻译相关的事情。
 */

const CODE_FENCE = /(```|~~~)[\s\S]*?\1/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_BLOCK = /<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const HTML_TAG = /<\/?[a-z][^>]*>/gi
const MAILTO_URL = /\bmailto:[^\s<>"'，。！？；、）)\]】}]+/giu
const DATA_URL = /\bdata:[^\s<>"'，。！？；、）)\]】}]+/giu
const TRAILING_URL_PUNCTUATION = /[.,!?;:，。！？；：]+$/u
const LONG_HASH = /\b[a-f\d]{32,}\b/giu
const ALGORITHM_HASH = /\b(?:sha(?:1|224|256|384|512)|md5|blake2b?)\s*:\s*[a-f\d]{32,}\b/giu
const UUID = /\b[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/giu
const API_KEY = /\b(?:sk|pk|rk|ghp|api|token|key)[_-][a-z\d][a-z\d._-]{19,}\b/giu
const ENVIRONMENT_SECRET = /\b[A-Z][A-Z\d_]*(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)\s*=\s*(?:["'])?[a-z\d._-]{16,}(?:["'])?/giu
const NAMED_SECRET = /\b(?:api[_-]?key|token|secret)\s*[:=]\s*(?:["'])?[a-z\d._-]{16,}(?:["'])?/giu
const BEARER_TOKEN = /\b(?:authorization\s*:\s*)?bearer\s+[a-z\d._-]{20,}\b/giu
const JWT = /\beyJ[a-z\d_-]*\.[a-z\d_-]+\.[a-z\d_-]+\b/giu
const EXPLANATION_START = /\b(?:failed|failure|error|errors|because|is\s+missing|are\s+missing|was\s+missing|were\s+missing|cannot|unable\s+to)\b/iu

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
  s = s.replace(MARKDOWN_IMAGE, '')
  s = s.replace(/`[^`]*`/g, '') // 行内代码整体丢弃
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接只留文字
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1') // 加粗
  s = s.replace(/\*([^*\n]+)\*/g, '$1') // 斜体(*)
  s = s.replace(/_([^_\n]+)_/g, '$1') // 斜体(_)
  return s
}

function stripUrls(s: string): string {
  return s
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'，。！？；、）)\]】}]+/giu, preserveTrailingUrlPunctuation)
    .replace(MAILTO_URL, '')
    .replace(DATA_URL, '')
}

function preserveTrailingUrlPunctuation(url: string): string {
  return url.match(TRAILING_URL_PUNCTUATION)?.[0] ?? ''
}

function stripTechnicalTokens(s: string): string {
  return s
    .replace(ENVIRONMENT_SECRET, '')
    .replace(BEARER_TOKEN, '')
    .replace(NAMED_SECRET, '')
    .replace(API_KEY, '')
    .replace(JWT, '')
    .replace(UUID, '')
    .replace(ALGORITHM_HASH, '')
    .replace(LONG_HASH, '')
}

function stripLeadingTechnicalFragment(line: string): string {
  const explanation = EXPLANATION_START.exec(line)
  if (explanation?.index === undefined) return line

  const prefix = line.slice(0, explanation.index).trim()
  if (!isNonPackageCommandLine(prefix) && !isPathLine(prefix)) return line

  return line.slice(explanation.index).trimStart()
}

function stripEmbeddedPathsBeforeExplanation(line: string): string {
  const explanation = EXPLANATION_START.exec(line)
  if (explanation?.index === undefined) return line

  const beforeExplanation = line.slice(0, explanation.index)
  const withoutPath = beforeExplanation
    .replace(/(^|\s)[a-z]:[\\/][^<>:"|?*\r\n]*?(?=\s*$)/iu, '$1')
    .replace(/(^|\s)\.{1,2}\/[^\s]+(?=\s*$)/u, '$1')
    .replace(/(^|\s)\/(?:(?:[\w.-]+\/)+[\s\S]*?|[\w.-]+\.[a-z\d]{1,8})(?=\s*$)/iu, '$1')

  const remainder = line.slice(explanation.index)
  return withoutPath.trim() ? `${withoutPath}${remainder}` : remainder.trimStart()
}

function stripEmbeddedPaths(line: string): string {
  return line
    .replace(/\b[a-z]:[\\/][^<>:"|?*\r\n]*?(?=\s+(?:after|before|when|while|then|is|are|was|were|failed|because|error)\b)/iu, '')
    .replace(/(^|\s)\/(?:(?:[\w.-]+\/)+[\s\S]*?|[\w.-]+\.[a-z\d]{1,8})(?=\s+(?:after|before|when|while|then|is|are|was|were|failed|because|error)\b)/iu, '$1')
    .replace(/\b[a-z]:[\\/][^<>:"|?*\r\n]*?\.[a-z\d]{1,8}(?=\s|$)/giu, '')
    .replace(/(^|\s)\/[\s\S]*?\.[a-z\d]{1,8}(?=\s|$)/giu, '$1')
    .replace(/(^|\s)[\w.-]+(?:\/[\w.-]+)+\.[a-z\d]{1,8}(?=\s|$)/giu, '$1')
    .replace(/\b[a-z]:[\\/][^\s<>:"|?*]+/giu, '')
    .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]+(?=\s|$)/gu, '$1')
    .replace(/\.{1,2}\/[^\s]+/gu, '')
}

function isSentencePunctuationOnly(line: string): boolean {
  return /^[\s()\[\]{}<>.,!?;:，。！？；：（）【】「」『』]+$/u.test(line)
}

function isNonPackageCommandLine(value: string): boolean {
  const isGitCommand = /^git\s+(?:status|commit|diff|log|push|pull|clone|checkout|switch|add|restore|reset|rebase|branch)(?:\s+\S+)*$/iu.test(value)
  const isToolCommand = /^(?:npx\s+(?:@[\w./:-]+|[\w.-]+[./:-][\w./:-]*)|(?:curl|wget)\s+(?:--?\S+|https?:\/\/\S+)(?:\s+\S+)*|(?:docker|kubectl)\s+[\w.-]+(?:\s+--?\S+)*)$/iu.test(value)
  const isEchoCommand = /^echo(?:\s+\S+)+$/iu.test(value)
  const isLsCommand = /^ls(?:\s+\S+)*$/iu.test(value)
  const isCdCommand = /^cd\s+\S+(?:\s+\S+)*$/u.test(value)
  const isPythonScript = /^python(?:3)?\s+\S+\.(?:py|pyw)(?:\s+\S+)*$/iu.test(value)
  const isGoCommand = /^go\s+(?:test|run|build)(?:\s+(?:\.|\.\/[\w./-]+|[\w./-]+\.go|--?\S+))*$/iu.test(value)
  const isCargoCommand = /^(?:cargo\s+test(?:\s+(?:--?[\w-]+(?:\s+[\w@./-]+|=\S+)?|[\w.-]+))*|cargo\s+(?:run|build)(?:\s+--?[\w-]+(?:\s+[\w@./-]+|=\S+)?)*$)$/iu.test(value)
  const isNodeScript = /^node\s+\S+\.(?:[cm]?js|ts|json)(?:\s+\S+)*$/iu.test(value)

  return isGitCommand || isToolCommand || isEchoCommand || isLsCommand || isCdCommand || isPythonScript || isGoCommand || isCargoCommand || isNodeScript
}

function isPathLine(value: string): boolean {
  const isWindowsPath = /^(?:[a-z]:[\\/]|\\\\)[^<>:"|?*]+$/iu.test(value)
  const isUnixPath = /^(?:~?\/|\.{1,2}\/).+$/u.test(value)
  const isRelativePath = /^(?:[\w.-]+[\\/])+[\w.-]+$/u.test(value)
  const isFilename = /^[\w-]+\.[a-z]{1,8}$/iu.test(value)

  return isWindowsPath || isUnixPath || isRelativePath || isFilename
}

function isTechnicalOnlyLine(line: string): boolean {
  const value = line.trim()
  if (!value) return false

  const isPrompt = /^(?:[$#]\s+|(?:PS\s+)?[a-z]:\\[^>]*>\s*)/iu.test(value)
  const isPackageCommand = /^(?:pnpm|npm|yarn)\s+(?:install|add|remove|run|test|build|dev|exec|dlx|update|lint|typecheck)(?:\s+\S+)*$/iu.test(value) && !EXPLANATION_START.test(value)

  return isPrompt || isPackageCommand || isNonPackageCommandLine(value) || (isPathLine(value) && !EXPLANATION_START.test(value))
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
  const noCode = raw.replace(CODE_FENCE, '').replace(HTML_COMMENT, '').replace(HTML_BLOCK, '')
  const lines = noCode.split(/\r?\n/).map((line) => {
    if (isTableSeparator(line)) return null
    let l = line
    const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (bullet) l = bullet[1]
    const header = l.match(/^\s*#{1,6}\s+(.*)$/)
    if (header) l = header[1]
    if (l.includes('|')) l = tableRowToText(l)
    l = stripTechnicalTokens(l)
    l = stripInlineMarkdown(l)
    l = l.replace(HTML_TAG, '')
    if (isSentencePunctuationOnly(l) || (isTechnicalOnlyLine(l) && !EXPLANATION_START.test(l))) return null
    l = stripUrls(l)
    if (isSentencePunctuationOnly(l) || (isTechnicalOnlyLine(l) && !EXPLANATION_START.test(l))) return null
    l = stripLeadingTechnicalFragment(l)
    l = stripEmbeddedPaths(l)
    l = stripEmbeddedPathsBeforeExplanation(l)
    if (isSentencePunctuationOnly(l) || isTechnicalOnlyLine(l)) return null
    l = mapSymbols(l)
    return l
  })
  return lines.filter((l): l is string => l !== null).join('\n').trim()
}
