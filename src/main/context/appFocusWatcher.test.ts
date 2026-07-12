import { describe, it, expect } from 'vitest'
import { parseAppFocusRules, matchAppFocusRule, initAppFocusWatcher, stepAppFocusWatcher, type AppFocusWatcherConfig } from './appFocusWatcher'

describe('parseAppFocusRules', () => {
  it('解析合法规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
        { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
      ]
    })
    const rules = parseAppFocusRules(raw)
    expect(rules).toEqual([
      { match: ['code.exe', 'visual studio'], lines: [{ text: '又在写代码啦' }] },
      { match: ['chrome.exe'], lines: [{ text: '在看什么', audio: 'voice/x.wav' }] }
    ])
  })

  it('坏 JSON → 空数组', () => {
    expect(parseAppFocusRules('{ not json')).toEqual([])
  })

  it('没有 app_focus 键 → 空数组', () => {
    expect(parseAppFocusRules(JSON.stringify({ idle: [{ text: 'a' }] }))).toEqual([])
  })

  it('跳过缺 match 或 match 为空数组的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { lines: [{ text: 'a' }] },
        { match: [], lines: [{ text: 'b' }] },
        { match: ['ok.exe'], lines: [{ text: 'c' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['ok.exe'], lines: [{ text: 'c' }] }])
  })

  it('跳过缺 lines 或 lines 全部无效的规则', () => {
    const raw = JSON.stringify({
      app_focus: [
        { match: ['a.exe'] },
        { match: ['b.exe'], lines: [{ nope: 1 }] },
        { match: ['c.exe'], lines: [{ text: 'ok' }] }
      ]
    })
    expect(parseAppFocusRules(raw)).toEqual([{ match: ['c.exe'], lines: [{ text: 'ok' }] }])
  })
})

describe('matchAppFocusRule', () => {
  const rules = [
    { match: ['code.exe', 'visual studio'], lines: [{ text: 'a' }] },
    { match: ['chrome.exe'], lines: [{ text: 'b' }] }
  ]

  it('按进程名命中(大小写不敏感)', () => {
    expect(matchAppFocusRule(rules, { processName: 'Code.EXE', windowTitle: 'x' })).toEqual(rules[0])
  })

  it('按窗口标题命中', () => {
    expect(matchAppFocusRule(rules, { processName: 'unknown', windowTitle: 'Visual Studio Code - main.ts' })).toEqual(rules[0])
  })

  it('都不命中 → null', () => {
    expect(matchAppFocusRule(rules, { processName: 'notepad.exe', windowTitle: 'Untitled' })).toBeNull()
  })

  it('多规则按顺序取第一个命中', () => {
    const overlapping = [
      { match: ['exe'], lines: [{ text: 'first' }] },
      { match: ['chrome.exe'], lines: [{ text: 'second' }] }
    ]
    expect(matchAppFocusRule(overlapping, { processName: 'chrome.exe', windowTitle: '' })).toEqual(overlapping[0])
  })
})

describe('stepAppFocusWatcher', () => {
  const cfg: AppFocusWatcherConfig = { pollIntervalMs: 1000, minGapMs: 3000, ruleCooldownMs: 5000 }
  const rules = [
    { match: ['code.exe'], lines: [{ text: 'code' }] },
    { match: ['chrome.exe'], lines: [{ text: 'chrome' }] }
  ]

  it('同一前台窗口停留期间不重复判定', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    const sample = { processName: 'code.exe', windowTitle: 'a.ts' }
    let r = stepAppFocusWatcher(state, sample, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, sample, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
  })

  it('minGapMs 压住紧接着切到另一条规则', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, { processName: 'chrome.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
  })

  it('过了 minGapMs 后切到不同规则可以触发', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: '' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'other' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'other2' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'chrome.exe', windowTitle: '' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(1)
  })

  it('ruleCooldownMs 压住同规则短期重复触发,过了冷却期后可再次触发', () => {
    let state = initAppFocusWatcher(rules.length, cfg)
    let r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'a' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'b' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBeNull()
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '2' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: '3' }, rules, cfg); state = r.state
    r = stepAppFocusWatcher(state, { processName: 'code.exe', windowTitle: 'c' }, rules, cfg); state = r.state
    expect(r.firedRuleIndex).toBe(0)
  })

  it('采样为 null(取窗口失败) → 不报错,只推进计时器', () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const r = stepAppFocusWatcher(state, null, rules, cfg)
    expect(r.firedRuleIndex).toBeNull()
    expect(r.state.msSinceLastFire).toBe(cfg.minGapMs + cfg.pollIntervalMs)
  })

  it('都不命中规则 → 不触发', () => {
    const state = initAppFocusWatcher(rules.length, cfg)
    const r = stepAppFocusWatcher(state, { processName: 'notepad.exe', windowTitle: 'Untitled' }, rules, cfg)
    expect(r.firedRuleIndex).toBeNull()
  })
})
