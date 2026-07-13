import { describe, it, expect } from 'vitest'
import { frameRect, frameDurationMs, parsePetManifest } from './petPackage'

const sheet = { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 }

describe('frameRect', () => {
  it('computes pixel rect from row/col', () => {
    expect(frameRect(sheet, 0, 0)).toEqual({ x: 0, y: 0, w: 192, h: 208 })
    expect(frameRect(sheet, 2, 3)).toEqual({ x: 576, y: 416, w: 192, h: 208 })
  })
})

describe('frameDurationMs', () => {
  it('uses durations when present', () => {
    const anim = { row: 0, frames: 2, fps: 5, loop: true, durations: [280, 120] }
    expect(frameDurationMs(anim, 1)).toBe(120)
  })
  it('falls back to 1000/fps without durations', () => {
    const anim = { row: 1, frames: 8, fps: 8, loop: true }
    expect(frameDurationMs(anim, 0)).toBe(125)
  })
})

describe('parsePetManifest', () => {
  const valid = {
    id: 'luluka', displayName: '露露卡', description: 'x', spritesheetPath: 'spritesheet.webp',
    sheet, animations: { idle: { row: 0, frames: 6, fps: 5, loop: true } }
  }
  it('accepts a valid manifest', () => {
    expect(parsePetManifest(valid).id).toBe('luluka')
  })
  it('rejects missing animations', () => {
    const bad = { ...valid, animations: {} }
    expect(() => parsePetManifest(bad)).toThrow(/animations/)
  })
  it('rejects missing sheet fields', () => {
    const bad = { ...valid, sheet: { rows: 13, cols: 8 } }
    expect(() => parsePetManifest(bad)).toThrow(/sheet/)
  })
})

describe('parsePetManifest voice 字段(可选)', () => {
  const base = {
    id: 'alice', displayName: 'Alice', description: 'd', spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 1, fps: 1, loop: true } }
  }

  it('缺失 voice 字段 → 解析成功,voice 为 undefined', () => {
    const m = parsePetManifest(base)
    expect(m.voice).toBeUndefined()
  })

  it('完整 voice 字段 → 原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })
    expect(m.voice).toEqual({ gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' })
  })

  it('voice 字段存在但缺子字段 → 抛错', () => {
    expect(() => parsePetManifest({ ...base, voice: { gptModel: 'x' } })).toThrow()
  })

  it('voice 子字段为空字符串 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: '', sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })

  it('只提供 onnxModel(Genie-TTS 后端)→ 解析成功,原样保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' }
    })
    expect(m.voice).toEqual({ onnxModel: 'voice/alice-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja' })
  })

  it('gptModel/sovitsModel 与 onnxModel 都提供 → 都保留', () => {
    const m = parsePetManifest({
      ...base,
      voice: {
        gptModel: 'voice/a.ckpt', sovitsModel: 'voice/a.pth', onnxModel: 'voice/a-onnx',
        refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'ja'
      }
    })
    expect(m.voice?.onnxModel).toBe('voice/a-onnx')
    expect(m.voice?.gptModel).toBe('voice/a.ckpt')
  })

  it('既没有 onnxModel 也没有 gptModel/sovitsModel → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/onnxModel|gptModel/)
  })

  it('只给 gptModel 不给 sovitsModel(反之亦然)→ 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { gptModel: 'voice/a.ckpt', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
    expect(() => parsePetManifest({
      ...base,
      voice: { sovitsModel: 'voice/a.pth', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow()
  })

  it('onnxModel 存在但 language 缺失/非法 → 抛错', () => {
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt' }
    })).toThrow(/language/)
    expect(() => parsePetManifest({
      ...base,
      voice: { onnxModel: 'voice/a-onnx', refAudio: 'voice/a.wav', refText: 'voice/a.txt', language: 'fr' }
    })).toThrow(/language/)
  })
})
