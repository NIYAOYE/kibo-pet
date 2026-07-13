import { describe, it, expect } from 'vitest'
import { resolveVoiceBackend } from './index'

describe('resolveVoiceBackend', () => {
  it('选中 genie-tts 且宠物提供 onnxModel → 返回 genie-tts', () => {
    const petVoice = { onnxModel: 'voice/x', refAudio: 'a', refText: 'b', language: 'ja' as const }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBe('genie-tts')
  })

  it('选中 genie-tts 但宠物没提供 onnxModel → 返回 null(不回退)', () => {
    const petVoice = { gptModel: 'a.ckpt', sovitsModel: 'a.pth', refAudio: 'a', refText: 'b' }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBeNull()
  })

  it('选中 gsv-tts-lite 且宠物提供 gptModel/sovitsModel → 返回 gsv-tts-lite', () => {
    const petVoice = { gptModel: 'a.ckpt', sovitsModel: 'a.pth', refAudio: 'a', refText: 'b' }
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBe('gsv-tts-lite')
  })

  it('选中 gsv-tts-lite 但宠物没提供 gptModel/sovitsModel → 返回 null(不回退)', () => {
    const petVoice = { onnxModel: 'voice/x', refAudio: 'a', refText: 'b', language: 'ja' as const }
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBeNull()
  })

  it('两套模型都提供、选中 genie-tts → 返回 genie-tts(不受另一套模型存在与否影响)', () => {
    const petVoice = {
      onnxModel: 'voice/x', gptModel: 'a.ckpt', sovitsModel: 'a.pth',
      refAudio: 'a', refText: 'b', language: 'ja' as const
    }
    expect(resolveVoiceBackend(petVoice, 'genie-tts')).toBe('genie-tts')
    expect(resolveVoiceBackend(petVoice, 'gsv-tts-lite')).toBe('gsv-tts-lite')
  })
})
