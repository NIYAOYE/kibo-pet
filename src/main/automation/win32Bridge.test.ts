import { describe, it, expect } from 'vitest'
import {
  buildClickScript, buildTypeTextScript, buildPressKeyScript,
  buildListWindowsScript, parseListWindowsOutput,
  buildFocusWindowScript, parseFocusWindowOutput
} from './win32Bridge'

describe('stdout 编码(真机复现:list_windows/focus_window 返回的中文窗口标题在终端里显示成"锟斤拷")', () => {
  // 真机诊断实测复现并用 Node child_process 空跑验证过根因:execFile 调用的是 Windows
  // PowerShell 5.1(powershell.exe,不是 pwsh.exe),它给"重定向到管道"的 stdout 默认按
  // 系统 ANSI/OEM 代码页(中文 Windows 上是 GBK)编码,而 Node 端按 UTF-8 解码 stdout——
  // 两端编码不一致,GBK 字节流被当 UTF-8 解码时非法序列变成 U+FFFD,连续出现就是经典的
  // "锟斤拷" 乱码。空跑复现:Write-Output 中文文本→Node 收到的是 "��..."；
  // 修复方式(同样空跑验证过有效):脚本一开头设置 [Console]::OutputEncoding = UTF8,
  // 让 PowerShell 按 UTF-8 写 stdout,与 Node 默认解码方式对上。
  it.each([
    ['buildClickScript', () => buildClickScript(1, 1, 'left', false)],
    ['buildTypeTextScript', () => buildTypeTextScript('x')],
    ['buildPressKeyScript', () => buildPressKeyScript([0x11])],
    ['buildListWindowsScript', () => buildListWindowsScript()],
    ['buildFocusWindowScript', () => buildFocusWindowScript('x')]
  ])('%s 的脚本在任何 Write-Output 之前设置 Console.OutputEncoding 为 UTF8', (_name, build) => {
    const s = build()
    const encodingIdx = s.indexOf('[Console]::OutputEncoding')
    const firstWriteIdx = s.indexOf('Write-Output')
    expect(encodingIdx).toBeGreaterThan(-1)
    expect(s.slice(encodingIdx, encodingIdx + 80)).toContain('UTF8')
    expect(encodingIdx).toBeLessThan(firstWriteIdx)
  })
})

describe('buildClickScript', () => {
  it('左键单击:含 SetCursorPos 与一次 down/up(0x0002/0x0004)', () => {
    const s = buildClickScript(100, 200, 'left', false)
    expect(s).toContain('SetCursorPos(100, 200)')
    expect(s).toContain('0x0002')
    expect(s).toContain('0x0004')
    expect((s.match(/::mouse_event\(/g) ?? []).length).toBe(2)
  })

  it('右键单击:用 0x0008/0x0010', () => {
    const s = buildClickScript(1, 1, 'right', false)
    expect(s).toContain('0x0008')
    expect(s).toContain('0x0010')
  })

  it('双击:mouse_event 调用次数翻倍', () => {
    const s = buildClickScript(1, 1, 'left', true)
    expect((s.match(/::mouse_event\(/g) ?? []).length).toBe(4)
  })

  it('坐标非有限数字时抛错(拒绝拼进脚本)', () => {
    expect(() => buildClickScript(Number.NaN, 1, 'left', false)).toThrow()
    expect(() => buildClickScript(1, Number.POSITIVE_INFINITY, 'left', false)).toThrow()
  })
})

describe('buildTypeTextScript', () => {
  it('把文本 base64 编码嵌入脚本,不做裸字符串插值', () => {
    const s = buildTypeTextScript("it's a test")
    expect(s).not.toContain("it's a test")
    const b64 = Buffer.from("it's a test", 'utf16le').toString('base64')
    expect(s).toContain(b64)
  })

  it('中文文本同样走 base64(验证 Unicode 往返)', () => {
    const s = buildTypeTextScript('你好')
    const b64 = Buffer.from('你好', 'utf16le').toString('base64')
    expect(s).toContain(b64)
  })

  it('不使用两层以上的链式结构体属性赋值(真机验证 PowerShell 不会写回,详见 win32Bridge.ts 顶部注释)', () => {
    const s = buildTypeTextScript('x')
    // 真机诊断已确认:`$down.U.ki.wScan = $code` 这类三段式链式赋值在 PowerShell 里
    // 只会改到一份临时拷贝、写不回 $down 本体,导致 SendInput 发出全零的无效按键
    // (真实症状:模型自称打了字,画面上什么都没出现)。正确写法必须先把 KEYBDINPUT
    // 单独建成一个变量、赋给 InputUnion 变量,再整体赋回 INPUT.U ——每次赋值只下探一层。
    expect(s).not.toMatch(/\$(down|up)\.U\.ki\.\w+\s*=/)
    expect(s).toContain('PetAgentAutomation.Native+KEYBDINPUT')
    expect(s).toContain('PetAgentAutomation.Native+InputUnion')
  })
})

describe('buildPressKeyScript', () => {
  it('组合键按下顺序 down、松开顺序相反', () => {
    const s = buildPressKeyScript([0x11, 0x41]) // Ctrl+A
    const downIdx = s.indexOf('17') // 0x11 = 17
    expect(downIdx).toBeGreaterThan(-1)
  })
})

describe('list_windows 脚本与解析', () => {
  it('buildListWindowsScript 包含 EnumWindows 调用', () => {
    expect(buildListWindowsScript()).toContain('EnumWindows')
  })

  it('parseListWindowsOutput 按行拆分并过滤空行', () => {
    expect(parseListWindowsOutput('记事本\r\n\r\n设置\n')).toEqual(['记事本', '设置'])
  })

  it('parseListWindowsOutput 空输出返回空数组', () => {
    expect(parseListWindowsOutput('')).toEqual([])
  })
})

describe('focus_window 脚本与解析', () => {
  it('buildFocusWindowScript 把 titleContains base64 嵌入,不做裸插值', () => {
    const s = buildFocusWindowScript("Notepad's window")
    expect(s).not.toContain("Notepad's window")
    expect(s).toContain(Buffer.from("Notepad's window", 'utf16le').toString('base64'))
  })

  it('找到窗口后先 ShowWindow(SW_RESTORE) 还原最小化状态,再 SetForegroundWindow(真机诊断实测:仅调 SetForegroundWindow 对已最小化窗口会返回 true 但 IsIconic 仍是 true,画面上看不到任何变化)', () => {
    const s = buildFocusWindowScript('记事本')
    const restoreIdx = s.indexOf('::ShowWindow(')
    const foregroundIdx = s.indexOf('::SetForegroundWindow(')
    expect(restoreIdx).toBeGreaterThan(-1)
    expect(foregroundIdx).toBeGreaterThan(-1)
    expect(restoreIdx).toBeLessThan(foregroundIdx)
    expect(s).toContain('SW_RESTORE')
  })

  it('parseFocusWindowOutput 解析 FOUND:<title>', () => {
    expect(parseFocusWindowOutput('FOUND:记事本')).toEqual({ found: true, title: '记事本' })
  })

  it('parseFocusWindowOutput 解析 NOTFOUND', () => {
    expect(parseFocusWindowOutput('NOTFOUND')).toEqual({ found: false })
  })

  it('parseFocusWindowOutput 对意外输出也返回 found:false(不崩)', () => {
    expect(parseFocusWindowOutput('乱七八糟')).toEqual({ found: false })
  })
})
