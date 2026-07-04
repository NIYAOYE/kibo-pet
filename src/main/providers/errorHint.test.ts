import { describe, it, expect } from 'vitest'
import { describeProviderError } from './errorHint'

describe('describeProviderError', () => {
  it('视觉相关错误加换模型提示', () => {
    expect(describeProviderError('model does not support image input')).toContain('支持视觉的模型')
  })
  it('工具相关错误加 function calling 提示', () => {
    expect(describeProviderError('this model does not support tools')).toContain('function calling')
  })
  it('无关错误原样返回', () => {
    expect(describeProviderError('rate limit exceeded')).toBe('rate limit exceeded')
  })
  it('视觉优先于工具(同时命中时给视觉提示)', () => {
    expect(describeProviderError('vision tool unsupported')).toContain('支持视觉的模型')
  })
})
