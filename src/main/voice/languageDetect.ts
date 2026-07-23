import type { TtsTargetLanguage } from '@shared/llm'

const CJK = /[一-鿿]/
const KANA = /[぀-ゟ゠-ヿ]/
const LATIN = /[A-Za-z]/

/** 粗略判断:朗读文本是否已经以 target 语言为主,若是则可跳过翻译直接送去合成。 */
export function needsTranslation(text: string, target: TtsTargetLanguage): boolean {
  if (target === 'auto') return false
  const chars = [...text].filter((c) => !/\s/.test(c))
  if (chars.length === 0) return false

  if (target === 'ja') return !chars.some((c) => KANA.test(c))

  if (target === 'zh') {
    const cjk = chars.filter((c) => CJK.test(c)).length
    return cjk / chars.length < 0.5
  }

  // target === 'en'
  const latin = chars.filter((c) => LATIN.test(c)).length
  return latin / chars.length < 0.5
}

/** 粗略判断:这段文本本身是什么语言。本地翻译需要显式源语言码(NLLB 不会自动识别),
 *  复用与 needsTranslation 相同的字符类启发式——含假名判定日语,否则按中文字符占比
 *  判定中文,都不成立时兜底英文。空文本没有可用信息,同样兜底英文,保证函数总有确定返回值。 */
export function detectSourceLanguage(text: string): 'zh' | 'ja' | 'en' {
  const chars = [...text].filter((c) => !/\s/.test(c))
  if (chars.length === 0) return 'en'
  if (chars.some((c) => KANA.test(c))) return 'ja'
  const cjk = chars.filter((c) => CJK.test(c)).length
  if (cjk / chars.length >= 0.5) return 'zh'
  return 'en'
}
