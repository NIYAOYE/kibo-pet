import { describe, it, expect } from 'vitest'
import { resolvePresetId } from './llm'

describe('resolvePresetId', () => {
  it('精确匹配 kind + baseURL', () => {
    expect(resolvePresetId('anthropic', undefined)).toBe('anthropic')
    expect(resolvePresetId('openai-compat', 'https://api.openai.com/v1')).toBe('openai')
    expect(resolvePresetId('openai-compat', 'https://api.deepseek.com/v1')).toBe('deepseek')
  })

  it('自定义 baseURL 匹配不到时,退回同 kind 首个预设(保证 kind 不被改错)', () => {
    // 回归:此前会回退到 PRESETS[0](anthropic),导致保存时把 openai-compat 写成 anthropic
    expect(resolvePresetId('openai-compat', 'https://my-proxy.local/v1')).toBe('openai')
  })

  it('无同 kind 预设时才回退到列表首项', () => {
    expect(resolvePresetId('fake', undefined)).toBe('anthropic')
  })
})
