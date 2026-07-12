/**
 * 纯函数:构造 PowerShell 脚本(GetForegroundWindow + GetWindowThreadProcessId +
 * GetWindowText 拿前台窗口标题,Get-Process 拿进程名),以及解析其 stdout。
 * 不 import child_process/electron,可单测。真正执行脚本在 appFocusWatcher.ts。
 *
 * 脚本正文只写 ASCII(不写中文注释):Windows PowerShell 5.1 对没有 BOM 的脚本按系统
 * 默认代码页(而非 UTF-8)解码,非 ASCII 字节可能破坏后续解析
 * (automation/win32Bridge.ts 已踩过并记录的同款坑)。
 */

export function buildForegroundWindowScript(): string {
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PetAgentContext
{
    public class Native
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    }
}
"@
$hwnd = [PetAgentContext.Native]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[PetAgentContext.Native]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
$procId = 0
[PetAgentContext.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$procName = "unknown"
try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
Write-Output "PROC:$procName"
Write-Output "TITLE:$($sb.ToString())"
`.trim()
}

export interface ForegroundWindowSample { processName: string; windowTitle: string }

export function parseForegroundWindowOutput(stdout: string): ForegroundWindowSample | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim())
  const procLine = lines.find((l) => l.startsWith('PROC:'))
  const titleLine = lines.find((l) => l.startsWith('TITLE:'))
  if (!procLine) return null
  return {
    processName: procLine.slice('PROC:'.length),
    windowTitle: titleLine ? titleLine.slice('TITLE:'.length) : ''
  }
}
