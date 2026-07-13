import { describe, it, expect } from 'vitest'
import { shouldUseGenieBackend } from './index'

describe('shouldUseGenieBackend', () => {
  it('onnxModel present → true (Genie-TTS)', () => {
    expect(shouldUseGenieBackend({ onnxModel: 'voice/x', refAudio: 'a', refText: 'b', language: 'ja' })).toBe(true)
  })

  it('onnxModel absent, gptModel/sovitsModel present → false (GSV-TTS-Lite)', () => {
    expect(shouldUseGenieBackend({ gptModel: 'a.ckpt', sovitsModel: 'a.pth', refAudio: 'a', refText: 'b' })).toBe(false)
  })
})
