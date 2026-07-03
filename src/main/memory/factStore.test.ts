import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeFactText, parseFacts, upsertFact, newFactId,
  loadFacts, saveFacts, type FactsFile
} from './factStore'

const empty: FactsFile = { schemaVersion: 1, facts: [] }

describe('normalizeFactText', () => {
  it('trim 并把连续空白折成一个空格', () => {
    expect(normalizeFactText('  用户叫  小星\n ')).toBe('用户叫 小星')
  })
})

describe('upsertFact', () => {
  it('新事实追加,带时间戳与 id', () => {
    const r = upsertFact(empty, '用户叫小星', '2026-07-02T10:00:00Z', 'f_1')
    expect(r.deduped).toBe(false)
    expect(r.file.facts).toEqual([
      { id: 'f_1', text: '用户叫小星', createdAt: '2026-07-02T10:00:00Z', updatedAt: '2026-07-02T10:00:00Z' }
    ])
  })
  it('规范化后相同文本 → 判重,只更新 updatedAt,不新增', () => {
    const first = upsertFact(empty, '用户叫小星', 't1', 'f_1').file
    const r = upsertFact(first, ' 用户叫小星 ', 't2', 'f_2')
    expect(r.deduped).toBe(true)
    expect(r.file.facts).toHaveLength(1)
    expect(r.file.facts[0]).toMatchObject({ id: 'f_1', createdAt: 't1', updatedAt: 't2' })
  })
})

describe('parseFacts', () => {
  it('坏数据 → 空;非法条目被过滤', () => {
    expect(parseFacts('x').facts).toEqual([])
    expect(parseFacts({ facts: [{ id: 'a', text: '好', createdAt: 't', updatedAt: 't' }, { id: 1 }, { text: '' }] }).facts)
      .toEqual([{ id: 'a', text: '好', createdAt: 't', updatedAt: 't' }])
  })
})

describe('newFactId', () => {
  it('唯一且带 f_ 前缀', () => {
    const a = newFactId()
    const b = newFactId()
    expect(a.startsWith('f_')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('loadFacts / saveFacts', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'facts-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('往返一致;缺失/损坏 → 空;落盘为缩进 JSON(人类可读)', () => {
    const file = join(dir, 'facts.json')
    expect(loadFacts(file).facts).toEqual([])
    const data = upsertFact(empty, '用户爱吃冰淇淋', 't1', 'f_1').file
    saveFacts(file, data)
    expect(loadFacts(file)).toEqual(data)
    expect(readFileSync(file, 'utf-8')).toContain('\n  ')
    writeFileSync(file, '{broken', 'utf-8')
    expect(loadFacts(file).facts).toEqual([])
  })
})
