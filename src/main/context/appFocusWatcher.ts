import { pickFromPool, type Line } from '../lines/linesLoader'
import { buildForegroundWindowScript, parseForegroundWindowOutput, type ForegroundWindowSample } from './foregroundWindowBridge'

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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppFocusWatcherHandle { stop: () => void }

/**
 * 单次 tick 的核心步骤,拆出来是为了可以在测试里直接调用、不依赖 setInterval/真实计时器。
 * 关键顺序:onStateUpdated 必须在 await generateOpener 之前调用,否则一次生成耗时超过
 * pollIntervalMs 时,下一 tick 会用"没考虑这次触发"的旧状态重新判定,绕开冷却重复触发。
 */
export async function runAppFocusTick(
  state: AppFocusWatcherState,
  rules: AppFocusRule[],
  cfg: AppFocusWatcherConfig,
  execFile: (script: string) => Promise<{ stdout: string; stderr: string }>,
  lastFiredText: string | undefined,
  generateOpener: ((ctx: { processName: string; windowTitle: string }) => Promise<string | null>) | undefined,
  onStateUpdated: (state: AppFocusWatcherState) => void
): Promise<Line | null> {
  const sample = await execFile(buildForegroundWindowScript())
    .then((r) => parseForegroundWindowOutput(r.stdout))
    .catch(() => null)

  const result = stepAppFocusWatcher(state, sample, rules, cfg)
  onStateUpdated(result.state)

  if (result.firedRuleIndex === null || !sample) return null

  const rule = rules[result.firedRuleIndex]
  let text: string | null = null
  if (generateOpener) text = await generateOpener({ processName: sample.processName, windowTitle: sample.windowTitle }).catch(() => null)
  return text ? { text } : pickFromPool(rule.lines, lastFiredText)
}

/**
 * 薄包装:读取宠物包 lines.json 的 app_focus 规则(没有规则/没有该文件 → 空数组);
 * 若规则为空,直接返回 no-op handle,不起轮询——不启动的检测就是零隐私/性能开销,
 * 而不是"启动了但恰好不触发"。
 */
export function startAppFocusWatcher(
  petDir: string,
  opts: {
    execFile: (script: string) => Promise<{ stdout: string; stderr: string }>
    onMatch: (line: Line) => void
    config?: Partial<AppFocusWatcherConfig>
    /** 命中规则时的可选生成分支:开启时优先用它的结果,失败/返回 null/未注入时回退预写台词池 */
    generateOpener?: (ctx: { processName: string; windowTitle: string }) => Promise<string | null>
  }
): AppFocusWatcherHandle {
  let rules: AppFocusRule[]
  try { rules = parseAppFocusRules(readFileSync(join(petDir, 'lines.json'), 'utf-8')) }
  catch { rules = [] }

  if (rules.length === 0) return { stop: (): void => {} }

  const cfg = { ...DEFAULT_APP_FOCUS_WATCHER_CONFIG, ...opts.config }
  let state = initAppFocusWatcher(rules.length, cfg)
  let lastFiredText: string | undefined

  const handle = setInterval(() => {
    void runAppFocusTick(state, rules, cfg, opts.execFile, lastFiredText, opts.generateOpener, (s) => { state = s })
      .then((line) => {
        if (!line) return
        lastFiredText = line.text
        opts.onMatch(line)
      })
  }, cfg.pollIntervalMs)

  return { stop: (): void => clearInterval(handle) }
}
