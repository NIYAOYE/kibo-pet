import type { LlmProvider } from '../providers/llmProvider'

export interface Translator {
  translate(text: string, target: 'zh' | 'ja' | 'en', signal: AbortSignal): Promise<string>
}

const LANG_NAME: Record<'zh' | 'ja' | 'en', string> = { zh: '中文', ja: '日语', en: '英语' }

export function createLlmTranslator(provider: LlmProvider): Translator {
  return {
    async translate(text, target, signal) {
      const system = `你是翻译引擎。把用户给的文本整体翻译成${LANG_NAME[target]}。无论输入多短、多零碎、是否为不完整的句子(哪怕只是一个词、一行数据、半句话或列表片段),都必须翻译并只输出${LANG_NAME[target]}译文本身:不要解释、不要加引号、不要拒绝、不要原样返回原文。`
      let acc = ''
      for await (const chunk of provider.streamChat({ system, messages: [{ role: 'user', content: text }], maxOutputTokens: 2048, signal })) {
        if (chunk.type === 'text') acc += chunk.text
        else if (chunk.type === 'error') throw new Error(chunk.message)
      }
      return acc.trim()
    }
  }
}
