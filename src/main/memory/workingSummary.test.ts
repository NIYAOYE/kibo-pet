import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  overflowRange, summarize, parseSummary, emptySummary,
  loadSummary, saveSummary, SUMMARY_TRIGGER
} from './workingSummary'
import { createFakeProvider } from '../providers/fakeProvider'

describe('overflowRange(窗口 12,触发 8)', () => {
  it('窗口外未覆盖不足 8 条 → null', () => {
    // 19 条:窗口外 7 条,coveredCount=0 → 7 < 8,不触发
    expect(overflowRange({ totalCount: 19, messagesLen: 19 }, 0, 12)).toBeNull()
  })
  it('窗口外未覆盖恰好 8 条 → 总结 [0,8),newCoveredCount=8', () => {
    expect(overflowRange({ totalCount: 20, messagesLen: 20 }, 0, 12))
      .toEqual({ start: 0, end: 8, newCoveredCount: 8 })
  })
  it('已覆盖部分从 coveredCount 接着算', () => {
    // totalCount=30:窗口外边界=18,已覆盖 8 → 未覆盖 10 条 ≥8,总结 [8,18)
    expect(overflowRange({ totalCount: 30, messagesLen: 30 }, 8, 12))
      .toEqual({ start: 8, end: 18, newCoveredCount: 18 })
  })
  it('transcript 被裁剪后用全局序号对齐本地下标', () => {
    // totalCount=250,只保留最近 200 条(全局序号 50 起),coveredCount=100
    // 窗口外边界=238 → 本地 start=100-50=50,end=238-50=188
    expect(overflowRange({ totalCount: 250, messagesLen: 200 }, 100, 12))
      .toEqual({ start: 50, end: 188, newCoveredCount: 238 })
  })
  it('coveredCount 落在已裁掉的区域 → 从可用起点开始', () => {
    // coveredCount=10 但 messages 从全局 50 开始 → start 提到 0
    expect(overflowRange({ totalCount: 250, messagesLen: 200 }, 10, 12))
      .toEqual({ start: 0, end: 188, newCoveredCount: 238 })
  })
})

describe('summarize', () => {
  it('拼接旧摘要与新增对话,返回 provider 文本', async () => {
    const provider = createFakeProvider({ reply: '用户在准备考研。' })
    const text = await summarize({
      provider, prevSummary: '旧摘要',
      messages: [{ role: 'user', text: '我在准备考研' }, { role: 'pet', text: '加油!' }],
      signal: new AbortController().signal
    })
    expect(text).toBe('用户在准备考研。')
  })
  it('provider 报错 → null(保留旧摘要)', async () => {
    const provider = createFakeProvider({ failWith: '网络错误' })
    const text = await summarize({
      provider, prevSummary: '', messages: [{ role: 'user', text: 'x' }],
      signal: new AbortController().signal
    })
    expect(text).toBeNull()
  })
})

describe('parseSummary / 读写', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sum-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('坏数据 → 空摘要;往返一致', () => {
    expect(parseSummary('x')).toEqual(emptySummary())
    const file = join(dir, 'summary.json')
    const s = { schemaVersion: 1 as const, text: '摘要', coveredCount: 8, updatedAt: 't' }
    saveSummary(file, s)
    expect(loadSummary(file)).toEqual(s)
  })
  it('触发常量为 8', () => { expect(SUMMARY_TRIGGER).toBe(8) })
})
