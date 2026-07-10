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
