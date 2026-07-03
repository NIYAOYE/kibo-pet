import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryManager, DEGRADED_RECENT } from './memoryManager'
import type { Embedder } from '../providers/embedder'
import { createFakeProvider } from '../providers/fakeProvider'
import { WINDOW_TURNS } from '../agent/promptAssembler'
import { SUMMARY_TRIGGER } from './workingSummary'

/** 查表式决定性 embedder:未知文本给出与所有已知向量正交的向量 */
function tableEmbedder(table: Record<string, number[]>): Embedder {
  return {
    model: 'table-1',
    async embed(texts) { return texts.map((t) => table[t] ?? [0, 0, 1]) }
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mem-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('saveFact / messages / appendMessage 持久化', () => {
  it('saveFact 落盘 facts.json;appendMessage 落盘 transcript.json;重建 manager 后仍在', () => {
    const m1 = createMemoryManager({ dir, getEmbedder: () => null })
    m1.saveFact('用户叫小星')
    m1.appendMessage({ role: 'user', text: '你好' })
    expect(existsSync(join(dir, 'facts.json'))).toBe(true)
    const m2 = createMemoryManager({ dir, getEmbedder: () => null })
    expect(m2.messages()).toEqual([{ role: 'user', text: '你好' }])
    const facts = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf-8'))
    expect(facts.facts[0].text).toBe('用户叫小星')
  })
})

describe('recall:向量路径', () => {
  const table = {
    '用户叫小星': [1, 0, 0],
    '用户爱吃冰淇淋': [0, 1, 0],
    '我叫什么?': [0.9, 0.1, 0]
  }
  it('embed 缺失向量后按余弦 topK 返回相关事实,并落盘索引', async () => {
    const m = createMemoryManager({ dir, getEmbedder: () => tableEmbedder(table) })
    m.saveFact('用户叫小星')
    m.saveFact('用户爱吃冰淇淋')
    const r = await m.recall('我叫什么?', new AbortController().signal)
    expect(r.facts[0]).toBe('用户叫小星') // 最相关排最前
    expect(existsSync(join(dir, 'vector-index.json'))).toBe(true)
  })
  it('索引文件被删后 recall 自动重建(可重建性)', async () => {
    const m = createMemoryManager({ dir, getEmbedder: () => tableEmbedder(table) })
    m.saveFact('用户叫小星')
    await m.recall('我叫什么?', new AbortController().signal)
    unlinkSync(join(dir, 'vector-index.json'))
    const r = await m.recall('我叫什么?', new AbortController().signal)
    expect(r.facts).toContain('用户叫小星')
    expect(existsSync(join(dir, 'vector-index.json'))).toBe(true)
  })
})

describe('recall:退化路径(§5.6 记忆故障不阻断)', () => {
  it('无 embedder → 按 updatedAt 最近 N 条', async () => {
    const t = { n: 0 }
    const m = createMemoryManager({
      dir, getEmbedder: () => null,
      now: () => new Date(2026, 0, 1, 0, 0, ++t.n)
    })
    for (let i = 0; i < DEGRADED_RECENT + 3; i++) m.saveFact(`事实${i}`)
    const r = await m.recall('随便', new AbortController().signal)
    expect(r.facts).toHaveLength(DEGRADED_RECENT)
    expect(r.facts[0]).toBe(`事实${DEGRADED_RECENT + 2}`) // 最新在前
  })
  it('embedder 抛错 → 静默退化,不抛', async () => {
    const bad: Embedder = { model: 'bad', embed: async () => { throw new Error('网络挂了') } }
    const m = createMemoryManager({ dir, getEmbedder: () => bad })
    m.saveFact('用户叫小星')
    const r = await m.recall('我叫什么?', new AbortController().signal)
    expect(r.facts).toEqual(['用户叫小星'])
  })
  it('无任何记忆 → facts 空、无 summary 字段', async () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null })
    const r = await m.recall('嗨', new AbortController().signal)
    expect(r).toEqual({ facts: [] })
  })
})

describe('maybeSummarize', () => {
  it('窗口外未覆盖达到阈值 → 异步总结并落盘 summary.json,之后 recall 带 summary', async () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null })
    const total = WINDOW_TURNS + SUMMARY_TRIGGER // 恰好触发
    for (let i = 0; i < total; i++) m.appendMessage({ role: i % 2 ? 'pet' : 'user', text: `m${i}` })
    m.maybeSummarize(() => createFakeProvider({ reply: '聊了 m0 到 m7。' }))
    await vi.waitFor(() => { expect(existsSync(join(dir, 'summary.json'))).toBe(true) })
    const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf-8'))
    expect(s.text).toBe('聊了 m0 到 m7。')
    expect(s.coveredCount).toBe(SUMMARY_TRIGGER)
    const r = await m.recall('嗨', new AbortController().signal)
    expect(r.summary).toBe('聊了 m0 到 m7。')
  })
  it('不足阈值 → 不调 provider', () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null })
    m.appendMessage({ role: 'user', text: 'hi' })
    const makeProvider = vi.fn(() => createFakeProvider({}))
    m.maybeSummarize(makeProvider)
    expect(makeProvider).not.toHaveBeenCalled()
  })
  it('provider 失败 → 保留旧摘要(不写文件)', async () => {
    const m = createMemoryManager({ dir, getEmbedder: () => null })
    const total = WINDOW_TURNS + SUMMARY_TRIGGER
    for (let i = 0; i < total; i++) m.appendMessage({ role: 'user', text: `m${i}` })
    m.maybeSummarize(() => createFakeProvider({ failWith: '挂了' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(dir, 'summary.json'))).toBe(false)
  })
})
