export interface ScriptSegment { lang: 'en' | 'other'; text: string }

/** 一段"拉丁字母/数字开头结尾、中间允许空格与常见半角标点"的连续片段,视为一个英文片段。
 *  句末标点贴着非英文侧(如中文句号、问号前一个字符如果是拉丁字母,这个标点本身不会被
 *  这个正则捕获,会落进相邻的 other 片段)——单独一个标点字符被当作"non-English"送去
 *  翻译或朗读是无害的(翻译一个逗号是恒等操作,朗读一个逗号大多数 TTS 引擎不发声或极短停顿),
 *  不是需要特殊处理的正确性问题。 */
const LATIN_RUN = /[A-Za-z0-9](?:[A-Za-z0-9 '".,!?;:()-]*[A-Za-z0-9])?/g

export function splitByScript(text: string): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  let cursor = 0
  LATIN_RUN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LATIN_RUN.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ lang: 'other', text: text.slice(cursor, match.index) })
    segments.push({ lang: 'en', text: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ lang: 'other', text: text.slice(cursor) })
  return segments
}
