import { describe, it, expect } from 'vitest'
import { nextFrameIndex } from './spriteRenderer'

describe('nextFrameIndex', () => {
  it('advances within range', () => {
    expect(nextFrameIndex(0, 6, true)).toBe(1)
  })
  it('loops back to 0 when loop=true', () => {
    expect(nextFrameIndex(5, 6, true)).toBe(0)
  })
  it('holds last frame when loop=false', () => {
    expect(nextFrameIndex(4, 5, false)).toBe(4)
  })
})
