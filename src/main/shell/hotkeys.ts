import { globalShortcut } from 'electron'

const ACCELERATOR = 'CommandOrControl+Shift+Space'

export function registerHotkeys(onToggle: () => void): void {
  const ok = globalShortcut.register(ACCELERATOR, onToggle)
  if (!ok) console.warn(`[hotkeys] 注册失败: ${ACCELERATOR}(可能被占用)`)
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}
