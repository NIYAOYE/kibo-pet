import { describe, it, expect } from 'vitest'
import { buildForegroundWindowScript, parseForegroundWindowOutput } from './foregroundWindowBridge'

describe('buildForegroundWindowScript', () => {
  it('包含 GetForegroundWindow/GetWindowThreadProcessId/GetWindowText 三个 P/Invoke 声明', () => {
    const s = buildForegroundWindowScript()
    expect(s).toContain('GetForegroundWindow')
    expect(s).toContain('GetWindowThreadProcessId')
    expect(s).toContain('GetWindowText')
  })

  it('脚本正文只含 ASCII 字符(Windows PowerShell 5.1 代码页坑,不写中文)', () => {
    const s = buildForegroundWindowScript()
    expect(/^[\x00-\x7F]*$/.test(s)).toBe(true)
  })

  it('固定输出两行 PROC:/TITLE: 前缀', () => {
    const s = buildForegroundWindowScript()
    expect(s).toContain('Write-Output "PROC:$procName"')
    expect(s).toContain('Write-Output "TITLE:$($sb.ToString())"')
  })
})

describe('parseForegroundWindowOutput', () => {
  it('解析正常两行输出', () => {
    const out = parseForegroundWindowOutput('PROC:Code\nTITLE:main.ts - Visual Studio Code\n')
    expect(out).toEqual({ processName: 'Code', windowTitle: 'main.ts - Visual Studio Code' })
  })

  it('标题为空仍能解析', () => {
    const out = parseForegroundWindowOutput('PROC:explorer\nTITLE:\n')
    expect(out).toEqual({ processName: 'explorer', windowTitle: '' })
  })

  it('缺 PROC 行 → null', () => {
    expect(parseForegroundWindowOutput('TITLE:only title\n')).toBeNull()
  })

  it('缺 TITLE 行时 windowTitle 退化为空串', () => {
    const out = parseForegroundWindowOutput('PROC:Code\n')
    expect(out).toEqual({ processName: 'Code', windowTitle: '' })
  })

  it('行顺序无关(容错乱序)', () => {
    const out = parseForegroundWindowOutput('TITLE:foo\nPROC:bar\n')
    expect(out).toEqual({ processName: 'bar', windowTitle: 'foo' })
  })
})
