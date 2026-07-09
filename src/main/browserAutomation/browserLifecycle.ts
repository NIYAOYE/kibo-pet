import type { BrowserControlSettings } from '@shared/llm'

export const DEFAULT_CDP_PORT = 9222

export type LaunchPlan =
  | { kind: 'isolated'; channel: 'chrome'; headless: false }
  | { kind: 'cdp'; endpointURL: string }

export function resolveLaunchPlan(
  settings: Pick<BrowserControlSettings, 'mode'>,
  opts: { cdpPort?: number }
): LaunchPlan {
  if (settings.mode === 'cdp') {
    const port = opts.cdpPort ?? DEFAULT_CDP_PORT
    return { kind: 'cdp', endpointURL: `http://localhost:${port}` }
  }
  return { kind: 'isolated', channel: 'chrome', headless: false }
}
