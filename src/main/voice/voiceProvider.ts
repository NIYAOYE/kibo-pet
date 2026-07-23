import type { TtsSettings } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'
import { needsTranslation, detectSourceLanguage } from './languageDetect'
import { toSpeakableText } from './speakableText'
import { splitByScript } from './mixedLanguageSplit'

export type VoiceSynthesisOutcome = 'spoken' | 'skipped' | 'failed'

export interface VoiceProvider {
  speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void>
  synthesize(text: string, onChunk: (c: PcmChunk) => void): Promise<VoiceSynthesisOutcome>
  stop(): void
}

export function createVoiceProvider(opts: {
  sidecar: VoiceSidecar
  translator: Translator
  getSettings: () => TtsSettings
  onError: (message: string) => void
}): VoiceProvider {
  const inFlight = new Set<AbortController>()

  async function synthesize(text: string, onChunk: (c: PcmChunk) => void): Promise<VoiceSynthesisOutcome> {
    const speakable = toSpeakableText(text)
    if (!speakable.trim()) return 'skipped'
    const settings = opts.getSettings()
    const ctrl = new AbortController()
    inFlight.add(ctrl)

    try {
      let toSpeak = speakable
      if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
        try {
          const scriptSegments = splitByScript(speakable)
          const targetLanguage = settings.targetLanguage
          const translated = await Promise.all(scriptSegments.map((s) =>
            s.lang === 'en' ? s.text : opts.translator.translate(s.text, targetLanguage, ctrl.signal)
          ))
          toSpeak = translated.join('')
        } catch (e) {
          if (ctrl.signal.aborted) return 'skipped'
          opts.onError(`翻译失败,朗读已跳过本段:${String((e as Error)?.message ?? e)}`)
          return 'failed'
        }
      }
      if (ctrl.signal.aborted || !toSpeak.trim()) return 'skipped'

      let receivedAudio = false
      try {
        await opts.sidecar.speak({
          text: toSpeak,
          language: settings.targetLanguage,
          // auto 模式没有目标语言可用,不能沿用之前"随便标个 en"的兜底——segments 现在直接
          // 决定 TTS 引擎用哪种语言的发音去读这段文字(见 gsv_server.py/genie_server.py),标错
          // 语言会导致英文发音引擎处理不了中/日文字符,真机验证出来的现象是大面积丢字漏句。
          // 用 detectSourceLanguage 现场猜一下这段文字实际是什么语言。
          segments: splitByScript(toSpeak).map((s) => ({
            lang: s.lang === 'en' ? 'en' : (settings.targetLanguage === 'auto' ? detectSourceLanguage(s.text) : settings.targetLanguage),
            text: s.text
          })),
          isCutText: settings.isCutText,
          cutMinLen: settings.cutMinLen,
          cutMute: settings.cutMute,
          synthesisChunking: settings.synthesisChunking,
          speed: settings.speed,
          noiseScale: settings.noiseScale,
          temperature: settings.temperature,
          topK: settings.topK,
          topP: settings.topP,
          repetitionPenalty: settings.repetitionPenalty
        }, (chunk) => {
          receivedAudio = true
          onChunk(chunk)
        }, ctrl.signal)
      } catch (e) {
        if (ctrl.signal.aborted) return 'skipped'
        opts.onError(`语音合成失败:${String((e as Error)?.message ?? e)}`)
        return 'failed'
      }

      if (receivedAudio) return 'spoken'
      if (ctrl.signal.aborted) return 'skipped'
      opts.onError('语音合成未返回音频,本段改为仅显示')
      return 'failed'
    } finally {
      inFlight.delete(ctrl)
    }
  }

  return {
    synthesize,
    async speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void> {
      await synthesize(text, onChunk)
    },
    stop(): void {
      for (const ctrl of inFlight) ctrl.abort()
      inFlight.clear()
    }
  }
}
