/**
 * press_key 的白名单:只接受这里列出的键名,拒绝一切组合键/系统级快捷键
 * (Alt+F4、Win 键组合、Ctrl+Alt+Delete 等),把一次模型误判的破坏范围锁死。
 * vk code 参考:https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
 */
const VK_CONTROL = 0x11

const ALLOWLIST: Record<string, number[]> = Object.create(null)
ALLOWLIST.Enter = [0x0d]
ALLOWLIST.Tab = [0x09]
ALLOWLIST.Escape = [0x1b]
ALLOWLIST.Backspace = [0x08]
ALLOWLIST.Delete = [0x2e]
ALLOWLIST.ArrowUp = [0x26]
ALLOWLIST.ArrowDown = [0x28]
ALLOWLIST.ArrowLeft = [0x25]
ALLOWLIST.ArrowRight = [0x27]
ALLOWLIST['Ctrl+A'] = [VK_CONTROL, 0x41]
ALLOWLIST['Ctrl+C'] = [VK_CONTROL, 0x43]
ALLOWLIST['Ctrl+V'] = [VK_CONTROL, 0x56]
ALLOWLIST['Ctrl+X'] = [VK_CONTROL, 0x58]
ALLOWLIST['Ctrl+Z'] = [VK_CONTROL, 0x5a]

export const ALLOWED_KEY_NAMES: string[] = Object.keys(ALLOWLIST)

export function resolveKey(key: string): number[] | null {
  return ALLOWLIST[key] ?? null
}
