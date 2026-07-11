import type { Line } from '../lines/linesLoader'
import type { ForegroundWindowSample } from './foregroundWindowBridge'

export interface AppFocusRule { match: string[]; lines: Line[] }

export function parseAppFocusRules(raw: string): AppFocusRule[] {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return [] }
  if (typeof data !== 'object' || data === null) return []
  const rulesRaw = (data as Record<string, unknown>).app_focus
  if (!Array.isArray(rulesRaw)) return []

  const rules: AppFocusRule[] = []
  for (const item of rulesRaw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>

    if (!Array.isArray(rec.match)) continue
    const match = rec.match.filter((m): m is string => typeof m === 'string' && m.length > 0)
    if (match.length === 0) continue

    if (!Array.isArray(rec.lines)) continue
    const lines: Line[] = []
    for (const lineItem of rec.lines) {
      if (typeof lineItem !== 'object' || lineItem === null) continue
      const lineRec = lineItem as Record<string, unknown>
      if (typeof lineRec.text !== 'string') continue
      const line: Line = { text: lineRec.text }
      if (typeof lineRec.audio === 'string') line.audio = lineRec.audio
      lines.push(line)
    }
    if (lines.length === 0) continue

    rules.push({ match, lines })
  }
  return rules
}

export function matchAppFocusRule(
  rules: AppFocusRule[],
  sample: { processName: string; windowTitle: string }
): AppFocusRule | null {
  const haystack = `${sample.processName} ${sample.windowTitle}`.toLowerCase()
  for (const rule of rules) {
    if (rule.match.some((m) => haystack.includes(m.toLowerCase()))) return rule
  }
  return null
}

export interface AppFocusWatcherConfig {
  /** 轮询前台窗口的频率 */
  pollIntervalMs: number
  /** 任意两次 app_focus 触发之间的最小间隔,压住快速 alt-tab 刷屏 */
  minGapMs: number
  /** 同一条规则命中后,这么久之内不重复触发 */
  ruleCooldownMs: number
}

export const DEFAULT_APP_FOCUS_WATCHER_CONFIG: AppFocusWatcherConfig = {
  pollIntervalMs: 3_000,
  minGapMs: 20_000,
  ruleCooldownMs: 15 * 60_000
}

export interface AppFocusWatcherState {
  /** `processName windowTitle`,用于判定"前台真的变了"这个边沿 */
  lastSampleKey: string | null
  msSinceLastFire: number
  /** 与 rules 等长,记录每条规则距上次触发过了多久 */
  ruleLastFiredMsAgo: number[]
}

export function initAppFocusWatcher(ruleCount: number, cfg: AppFocusWatcherConfig): AppFocusWatcherState {
  return {
    lastSampleKey: null,
    msSinceLastFire: cfg.minGapMs, // 允许开局第一次匹配立即触发
    ruleLastFiredMsAgo: new Array(ruleCount).fill(Number.MAX_SAFE_INTEGER)
  }
}

export function stepAppFocusWatcher(
  state: AppFocusWatcherState,
  sample: ForegroundWindowSample | null,
  rules: AppFocusRule[],
  cfg: AppFocusWatcherConfig
): { state: AppFocusWatcherState; firedRuleIndex: number | null } {
  let next: AppFocusWatcherState = {
    ...state,
    msSinceLastFire: state.msSinceLastFire + cfg.pollIntervalMs,
    ruleLastFiredMsAgo: state.ruleLastFiredMsAgo.map((ms) => ms + cfg.pollIntervalMs)
  }

  if (!sample) return { state: next, firedRuleIndex: null }

  const sampleKey = `${sample.processName} ${sample.windowTitle}`
  if (sampleKey === next.lastSampleKey) return { state: next, firedRuleIndex: null }
  next = { ...next, lastSampleKey: sampleKey }

  const matched = matchAppFocusRule(rules, sample)
  if (!matched) return { state: next, firedRuleIndex: null }
  const matchedIndex = rules.indexOf(matched)

  if (next.msSinceLastFire < cfg.minGapMs) return { state: next, firedRuleIndex: null }
  if (next.ruleLastFiredMsAgo[matchedIndex] < cfg.ruleCooldownMs) return { state: next, firedRuleIndex: null }

  const ruleLastFiredMsAgo = [...next.ruleLastFiredMsAgo]
  ruleLastFiredMsAgo[matchedIndex] = 0
  next = { ...next, msSinceLastFire: 0, ruleLastFiredMsAgo }
  return { state: next, firedRuleIndex: matchedIndex }
}
