import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cosineSimilarity, topKFactIds, missingFactIds, upsertVectors,
  parseIndex, emptyIndex, loadIndexFor, saveIndex, type VectorIndexFile
} from './vectorIndex'

describe('cosineSimilarity', () => {
  it('同向=1,正交=0', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0)
  })
  it('维度不符或零向量返回 0(防御)', () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('topKFactIds', () => {
  const entries = [
    { factId: 'a', vector: [1, 0] },
    { factId: 'b', vector: [0.9, 0.1] },
    { factId: 'c', vector: [0, 1] }
  ]
  it('按相似度降序取 k 条', () => {
    expect(topKFactIds([1, 0], entries, 2, 0)).toEqual(['a', 'b'])
  })
  it('低于阈值的被过滤', () => {
    expect(topKFactIds([1, 0], entries, 5, 0.3)).toEqual(['a', 'b'])
  })
  it('空索引返回空', () => {
    expect(topKFactIds([1, 0], [], 5, 0)).toEqual([])
  })
})

describe('missingFactIds / upsertVectors', () => {
  it('找出索引里没有向量的事实;upsert 后不再缺失', () => {
    let index = emptyIndex('m1')
    expect(missingFactIds(['a', 'b'], index)).toEqual(['a', 'b'])
    index = upsertVectors(index, [{ factId: 'a', vector: [1, 0] }])
    expect(index.dims).toBe(2)
    expect(missingFactIds(['a', 'b'], index)).toEqual(['b'])
  })
  it('upsert 维度不符的向量被丢弃(防脏数据)', () => {
    let index = upsertVectors(emptyIndex('m1'), [{ factId: 'a', vector: [1, 0] }])
    index = upsertVectors(index, [{ factId: 'b', vector: [1, 2, 3] }])
    expect(index.entries.map((e) => e.factId)).toEqual(['a'])
  })
})

describe('parseIndex', () => {
  it('model 不匹配 → 空索引(换模型全量重建)', () => {
    const raw: VectorIndexFile = { schemaVersion: 1, model: 'old', dims: 2, entries: [{ factId: 'a', vector: [1, 0] }] }
    expect(parseIndex(raw, 'new').entries).toEqual([])
  })
  it('坏数据 → 空索引', () => {
    expect(parseIndex('garbage', 'm').entries).toEqual([])
    expect(parseIndex({ schemaVersion: 1, model: 'm', dims: 2, entries: [{ factId: 1, vector: 'x' }] }, 'm').entries).toEqual([])
  })
})

describe('loadIndexFor / saveIndex', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vec-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('保存后能读回;文件缺失/损坏返回空索引', () => {
    const file = join(dir, 'vector-index.json')
    expect(loadIndexFor(file, 'm').entries).toEqual([])
    const index = upsertVectors(emptyIndex('m'), [{ factId: 'a', vector: [1, 0] }])
    saveIndex(file, index)
    expect(loadIndexFor(file, 'm')).toEqual(index)
    writeFileSync(file, '{broken', 'utf-8')
    expect(loadIndexFor(file, 'm').entries).toEqual([])
  })
})
