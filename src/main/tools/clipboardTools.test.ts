import { describe, it, expect, vi } from 'vitest'
import {
  createReadClipboardTool,
  createWriteClipboardTool,
  UNTRUSTED_CLIPBOARD_HEADER
} from './clipboardTools'

const ctx = { signal: new AbortController().signal }

describe('read_clipboard', () => {
  it('name 与无必填参数', () => {
    const t = createReadClipboardTool({ readText: () => '' })
    expect(t.name).toBe('read_clipboard')
    expect(t.inputSchema.required ?? []).toEqual([])
  })

  it('读到文本时包裹反注入头', async () => {
    const t = createReadClipboardTool({ readText: () => '你好世界' })
    const out = await t.run({}, ctx)
    expect(out).toContain(UNTRUSTED_CLIPBOARD_HEADER)
    expect(out).toContain('你好世界')
  })

  it('空剪贴板返回友好提示,不含反注入头', async () => {
    const t = createReadClipboardTool({ readText: () => '   ' })
    const out = await t.run({}, ctx)
    expect(out).toContain('剪贴板里没有文字')
  })
})

describe('write_clipboard', () => {
  it('写入并返回确认', async () => {
    const writeText = vi.fn()
    const t = createWriteClipboardTool({ writeText })
    const out = await t.run({ text: '结果文本' }, ctx)
    expect(writeText).toHaveBeenCalledWith('结果文本')
    expect(out).toContain('已写入剪贴板')
  })
})
