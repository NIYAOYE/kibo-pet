import type { TtsSettings } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'
import { needsTranslation } from './languageDetect'
import { toSpeakableText } from './speakableText'

export interface VoiceProvider {
  speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void>
  stop(): void
}

export function createVoiceProvider(opts: {
  sidecar: VoiceSidecar
  translator: Translator
  getSettings: () => TtsSettings
  onError: (message: string) => void
}): VoiceProvider {
  const inFlight = new Set<AbortController>()

  return {
    async speak(text: string, onChunk: (c: PcmChunk) => void): Promise<void> {
      const speakable = toSpeakableText(text)
      if (!speakable.trim()) return
      const settings = opts.getSettings()
      const ctrl = new AbortController()
      inFlight.add(ctrl)

      try {
        let toSpeak = speakable
        if (settings.targetLanguage !== 'auto' && needsTranslation(speakable, settings.targetLanguage)) {
          try {
            toSpeak = await opts.translator.translate(speakable, settings.targetLanguage, ctrl.signal)
          } catch (e) {
            opts.onError(`翻译失败,朗读已跳过本段:${String((e as Error)?.message ?? e)}`)
            return
          }
        }
        if (ctrl.signal.aborted || !toSpeak.trim()) return

        try {
          await opts.sidecar.speak({
            text: toSpeak,
            language: settings.targetLanguage,
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
          }, onChunk, ctrl.signal)
        } catch (e) {
          opts.onError(`语音合成失败:${String((e as Error)?.message ?? e)}`)
        }
      } finally {
        inFlight.delete(ctrl)
      }
    },
    stop(): void {
      for (const ctrl of inFlight) ctrl.abort()
      inFlight.clear()
    }
  }
}
