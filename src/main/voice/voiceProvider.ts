import type { TtsSettings } from '@shared/llm'
import type { VoiceSidecar, PcmChunk } from './voiceSidecar'
import type { Translator } from './translate'
import { needsTranslation } from './languageDetect'
import { toSpeakableText } from './speakableText'

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
          toSpeak = await opts.translator.translate(speakable, settings.targetLanguage, ctrl.signal)
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
