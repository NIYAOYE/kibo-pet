/**
 * 纯函数:构造 PowerShell + C#(Add-Type P/Invoke user32.dll)脚本文本,
 * 以及解析对应脚本的 stdout。不 import child_process/electron,可单测。
 * 真正执行脚本在 desktopControl.ts(自然层,靠真机验收)。
 *
 * 安全:任何模型可控的自由文本(打字内容、窗口标题查询词)一律 base64 编码后
 * 嵌入脚本、脚本内部再解码 —— 避免把不可信文本裸插值进 shell 命令引发注入。
 */

const NATIVE_HEADER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PetAgentAutomation
{
    public class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion U; }

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_KEYUP = 0x0002;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    }
}
"@
[PetAgentAutomation.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
`.trim()

function assertFiniteInt(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new Error(`${label} 必须是有限数字`)
  return Math.round(n)
}

function toBase64Utf16(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64')
}

export function buildClickScript(x: number, y: number, button: 'left' | 'right', double: boolean): string {
  const px = assertFiniteInt(x, 'x')
  const py = assertFiniteInt(y, 'y')
  const down = button === 'right' ? '0x0008' : '0x0002'
  const up = button === 'right' ? '0x0010' : '0x0004'
  const clickOnce = `[PetAgentAutomation.Native]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)\n[PetAgentAutomation.Native]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`
  const second = double ? `\nStart-Sleep -Milliseconds 60\n${clickOnce}` : ''
  return `${NATIVE_HEADER}\n[PetAgentAutomation.Native]::SetCursorPos(${px}, ${py}) | Out-Null\nStart-Sleep -Milliseconds 30\n${clickOnce}${second}\nWrite-Output "OK"`
}

export function buildTypeTextScript(text: string): string {
  const b64 = toBase64Utf16(text)
  return `${NATIVE_HEADER}
$bytes = [Convert]::FromBase64String("${b64}")
$text = [System.Text.Encoding]::Unicode.GetString($bytes)
foreach ($ch in $text.ToCharArray()) {
  $code = [uint16][char]$ch
  $down = New-Object PetAgentAutomation.Native+INPUT
  $down.type = [PetAgentAutomation.Native]::INPUT_KEYBOARD
  $down.U.ki.wScan = $code
  $down.U.ki.dwFlags = [PetAgentAutomation.Native]::KEYEVENTF_UNICODE
  $up = New-Object PetAgentAutomation.Native+INPUT
  $up.type = [PetAgentAutomation.Native]::INPUT_KEYBOARD
  $up.U.ki.wScan = $code
  $up.U.ki.dwFlags = [PetAgentAutomation.Native]::KEYEVENTF_UNICODE -bor [PetAgentAutomation.Native]::KEYEVENTF_KEYUP
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type]"PetAgentAutomation.Native+INPUT")
  [PetAgentAutomation.Native]::SendInput(1, [PetAgentAutomation.Native+INPUT[]]@($down), $sz) | Out-Null
  [PetAgentAutomation.Native]::SendInput(1, [PetAgentAutomation.Native+INPUT[]]@($up), $sz) | Out-Null
  Start-Sleep -Milliseconds 8
}
Write-Output "OK"`
}

export function buildPressKeyScript(vkCodes: number[]): string {
  const list = vkCodes.map((v) => assertFiniteInt(v, 'vkCode')).join(',')
  return `${NATIVE_HEADER}
$vks = @(${list})
foreach ($vk in $vks) { [PetAgentAutomation.Native]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
Start-Sleep -Milliseconds 20
for ($i = $vks.Length - 1; $i -ge 0; $i--) { [PetAgentAutomation.Native]::keybd_event([byte]$vks[$i], 0, 0x0002, [UIntPtr]::Zero) }
Write-Output "OK"`
}

const ENUM_TITLES_SNIPPET = `
$titles = New-Object System.Collections.Generic.List[string]
$callback = {
  param($hWnd, $lParam)
  if ([PetAgentAutomation.Native]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PetAgentAutomation.Native]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $t = $sb.ToString()
    if ($t.Trim().Length -gt 0) { $titles.Add($t) }
  }
  return $true
}
[PetAgentAutomation.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null`

export function buildListWindowsScript(): string {
  return `${NATIVE_HEADER}${ENUM_TITLES_SNIPPET}\n$titles | ForEach-Object { Write-Output $_ }`
}

export function parseListWindowsOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
}

export function buildFocusWindowScript(titleContains: string): string {
  const b64 = toBase64Utf16(titleContains)
  return `${NATIVE_HEADER}
$bytes = [Convert]::FromBase64String("${b64}")
$needle = [System.Text.Encoding]::Unicode.GetString($bytes).ToLowerInvariant()
$script:found = $null
$callback = {
  param($hWnd, $lParam)
  if ([PetAgentAutomation.Native]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PetAgentAutomation.Native]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $t = $sb.ToString()
    if ($script:found -eq $null -and $t.ToLowerInvariant().Contains($needle)) {
      $script:found = @{ Handle = $hWnd; Title = $t }
    }
  }
  return $true
}
[PetAgentAutomation.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($script:found) {
  [PetAgentAutomation.Native]::SetForegroundWindow($script:found.Handle) | Out-Null
  Write-Output "FOUND:$($script:found.Title)"
} else {
  Write-Output "NOTFOUND"
}`
}

export function parseFocusWindowOutput(stdout: string): { found: true; title: string } | { found: false } {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  if (line.startsWith('FOUND:')) return { found: true, title: line.slice('FOUND:'.length) }
  return { found: false }
}
