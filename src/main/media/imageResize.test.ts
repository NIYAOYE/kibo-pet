import { describe, it, expect } from 'vitest'
import { targetSize } from './imageResize'

describe('targetSize', () => {
  it('最长边超阈值按比例缩', () => {
    expect(targetSize(2000, 1000, 1568)).toEqual({ width: 1568, height: 784 })
  })
  it('已在阈值内原样返回', () => {
    expect(targetSize(100, 100, 1568)).toEqual({ width: 100, height: 100 })
  })
  it('竖图按高缩', () => {
    expect(targetSize(1000, 2000, 1568)).toEqual({ width: 784, height: 1568 })
  })
  it('零尺寸不除零', () => {
    expect(targetSize(0, 0, 1568)).toEqual({ width: 0, height: 0 })
  })
})
