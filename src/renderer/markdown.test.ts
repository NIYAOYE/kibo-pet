import { describe, it, expect } from 'vitest'
import { renderMarkdownSafe } from './markdown'

describe('renderMarkdownSafe', () => {
  it('先转义 HTML,防止搜索结果里注入的标签被当作 DOM(XSS)', () => {
    const out = renderMarkdownSafe('<img src=x onerror=alert(1)> 普通文本')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('加粗 / 斜体 / 行内代码', () => {
    expect(renderMarkdownSafe('这是**重点**内容')).toContain('<strong>重点</strong>')
    expect(renderMarkdownSafe('这是*斜的*字')).toContain('<em>斜的</em>')
    expect(renderMarkdownSafe('用 `code` 表示')).toContain('<code>code</code>')
  })

  it('# 标题降级为加粗行(小气泡里不放大字号)', () => {
    const out = renderMarkdownSafe('### 核心结论')
    expect(out).toContain('<strong>核心结论</strong>')
    expect(out).not.toContain('<h3')
    expect(out).not.toContain('#')
  })

  it('连续 - / * 列表合并为 <ul><li>', () => {
    const out = renderMarkdownSafe('- 第一条\n- 第二条')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>第一条</li>')
    expect(out).toContain('<li>第二条</li>')
    expect(out).toContain('</ul>')
  })

  it('[文字](http链接) 渲染为可点击 a,并带 md-link 类', () => {
    const out = renderMarkdownSafe('见 [来源1](https://example.com/a)')
    expect(out).toContain('<a href="https://example.com/a" class="md-link">来源1</a>')
  })

  it('非 http(s) 的链接协议(javascript:)不渲染为 a,防止脚本注入', () => {
    const out = renderMarkdownSafe('[点我](javascript:alert(1))')
    expect(out).not.toContain('href="javascript')
    expect(out).not.toContain('<a ')
  })

  it('裸 http(s) URL 也变可点击链接', () => {
    const out = renderMarkdownSafe('来源:https://example.com/x')
    expect(out).toContain('<a href="https://example.com/x" class="md-link">https://example.com/x</a>')
  })

  it('表格分隔行(|---|---|)被丢弃,数据行按普通文本呈现(不显示成一堆竖线/横线)', () => {
    const out = renderMarkdownSafe('| 能力 | 说明 |\n|----|----|\n| 规划 | 拆解目标 |')
    expect(out).not.toContain('----')
    expect(out).toContain('能力')
    expect(out).toContain('拆解目标')
  })

  it('换行转 <br>,空行分段', () => {
    const out = renderMarkdownSafe('第一行\n第二行')
    expect(out).toContain('第一行<br>第二行')
  })

  it('纯文本原样(转义后)返回,不引入多余标签', () => {
    expect(renderMarkdownSafe('你好呀')).toBe('你好呀')
  })
})
