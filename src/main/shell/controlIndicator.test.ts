import { describe, it, expect } from 'vitest'
import { buildIndicatorHtml, escapeHtml } from './controlIndicator'

describe('escapeHtml', () => {
  it('转义 < > & "', () => {
    expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;')
  })
})

describe('buildIndicatorHtml', () => {
  it('包含宠物名 + 固定文案,不是 "AI"', () => {
    const html = buildIndicatorHtml('露露卡')
    expect(html).toContain('露露卡 正在控制鼠标')
    expect(html).not.toContain('AI 正在控制鼠标')
  })

  it('宠物 displayName 里的 HTML 特殊字符被转义(防止恶意宠物包注入)', () => {
    const html = buildIndicatorHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
