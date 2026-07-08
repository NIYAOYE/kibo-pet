import { resolveKey, ALLOWED_KEY_NAMES } from './keyAllowlist'
import {
  buildClickScript, buildTypeTextScript, buildPressKeyScript,
  buildListWindowsScript, parseListWindowsOutput,
  buildFocusWindowScript, parseFocusWindowOutput
} from './win32Bridge'

export const MAX_TYPE_TEXT_LEN = 2000

export interface AutomationControl {
  click(input: { x: number; y: number; button: 'left' | 'right'; double: boolean }): Promise<{ ok: boolean; error?: string }>
  typeText(text: string): Promise<{ ok: boolean; error?: string }>
  pressKey(key: string): Promise<{ ok: boolean; error?: string }>
  listWindows(): Promise<{ ok: boolean; titles?: string[]; error?: string }>
  focusWindow(titleContains: string): Promise<{ ok: boolean; title?: string; error?: string }>
}

export function createAutomationControl(opts: {
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
}): AutomationControl {
  async function run(script: string): Promise<{ ok: boolean; stdout?: string; error?: string }> {
    try {
      const { stdout } = await opts.execFile(script)
      return { ok: true, stdout }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }

  return {
    async click(input) {
      const r = await run(buildClickScript(input.x, input.y, input.button, input.double))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async typeText(text) {
      if (text.length > MAX_TYPE_TEXT_LEN) return { ok: false, error: `打字内容过长(超过 ${MAX_TYPE_TEXT_LEN} 字符),请分批输入` }
      const r = await run(buildTypeTextScript(text))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async pressKey(key) {
      const vkCodes = resolveKey(key)
      if (!vkCodes) return { ok: false, error: `不支持的按键:${key}。可用:${ALLOWED_KEY_NAMES.join('、')}` }
      const r = await run(buildPressKeyScript(vkCodes))
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    async listWindows() {
      const r = await run(buildListWindowsScript())
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, titles: parseListWindowsOutput(r.stdout ?? '') }
    },
    async focusWindow(titleContains) {
      const r = await run(buildFocusWindowScript(titleContains))
      if (!r.ok) return { ok: false, error: r.error }
      const parsed = parseFocusWindowOutput(r.stdout ?? '')
      return parsed.found ? { ok: true, title: parsed.title } : { ok: false, error: `没找到标题包含"${titleContains}"的窗口` }
    }
  }
}
