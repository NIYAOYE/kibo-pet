import type { BrowserControlSettings } from '@shared/llm'

export const DEFAULT_CDP_PORT = 9222

export type LaunchPlan =
  | { kind: 'isolated'; channel: 'chrome'; headless: false; executablePath?: string }
  | { kind: 'cdp'; endpointURL: string }

export function resolveLaunchPlan(
  settings: Pick<BrowserControlSettings, 'mode' | 'chromePath'>,
  opts: { cdpPort?: number }
): LaunchPlan {
  if (settings.mode === 'cdp') {
    const port = opts.cdpPort ?? DEFAULT_CDP_PORT
    // 显式用 127.0.0.1 而不是 localhost:Windows 上 localhost 常被解析成 ::1(IPv6 环回),
    // 而 Chrome --remote-debugging-port 默认只监听 127.0.0.1(IPv4),会导致
    // connectOverCDP 报 "connect EACCES ::1:<port>"(真机复现过)。
    return { kind: 'cdp', endpointURL: `http://127.0.0.1:${port}` }
  }
  const chromePath = settings.chromePath?.trim()
  return {
    kind: 'isolated',
    channel: 'chrome',
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {})
  }
}
