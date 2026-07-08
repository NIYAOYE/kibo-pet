import { describe, it, expect, vi } from 'vitest'
import { createAutomationControl } from './automationControl'

function fakeExecFile(stdout: string, stderr = ''): (s: string) => Promise<{ stdout: string; stderr: string }> {
  return vi.fn(async () => ({ stdout, stderr }))
}

describe('createAutomationControl', () => {
  it('click 成功:execFile 收到脚本、返回 ok', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.click({ x: 10, y: 20, button: 'left', double: false })
    expect(r).toEqual({ ok: true })
    expect(execFile).toHaveBeenCalledTimes(1)
    expect((execFile as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('SetCursorPos(10, 20)')
  })

  it('click 失败:execFile 拒绝 → ok:false 带 error', async () => {
    const execFile = vi.fn(async () => { throw new Error('powershell 不存在') })
    const ac = createAutomationControl({ execFile })
    const r = await ac.click({ x: 1, y: 1, button: 'left', double: false })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('powershell 不存在')
  })

  it('typeText 超过 2000 字符直接拒绝,不调用 execFile', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.typeText('a'.repeat(2001))
    expect(r.ok).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('typeText 2000 字符以内正常执行', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.typeText('a'.repeat(2000))
    expect(r.ok).toBe(true)
  })

  it('pressKey 白名单外的键 → 拒绝,不调用 execFile', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.pressKey('Alt+F4')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Alt+F4')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('pressKey 白名单内正常执行', async () => {
    const execFile = fakeExecFile('OK\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.pressKey('Enter')
    expect(r.ok).toBe(true)
  })

  it('listWindows 解析多行标题', async () => {
    const execFile = fakeExecFile('记事本\r\n设置\r\n')
    const ac = createAutomationControl({ execFile })
    const r = await ac.listWindows()
    expect(r).toEqual({ ok: true, titles: ['记事本', '设置'] })
  })

  it('focusWindow 找到 → ok:true 带 title;找不到 → ok:false', async () => {
    const found = createAutomationControl({ execFile: fakeExecFile('FOUND:记事本\n') })
    expect(await found.focusWindow('记事')).toEqual({ ok: true, title: '记事本' })
    const notFound = createAutomationControl({ execFile: fakeExecFile('NOTFOUND\n') })
    const r = await notFound.focusWindow('不存在的窗口')
    expect(r.ok).toBe(false)
  })
})
