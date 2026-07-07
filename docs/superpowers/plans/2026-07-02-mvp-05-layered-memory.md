# MVP-05 分层记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给桌宠装上分层记忆——save_memory 工具写入的事实库(权威源)+ 纯文件向量索引(可重建)+ 滚动工作摘要 + 对话历史持久化,并完成 §5.4 的 persona 组装收口。

**Architecture:** 自动注入管道:每次发送前 `memoryManager.recall()` 取 top-K 事实 + 摘要填进 `promptAssembler` 的记忆占位;写入走 `save_memory` 工具;回复完成后异步滚动摘要。四个记忆文件全部原子写在 `userData/memory/`,embedding 走独立 openai-compat 配置,未配置/失败时静默退化为最近-N 召回——**记忆链路任何故障都不得阻断对话主链路**。

**Tech Stack:** Electron(CJS main)+ TypeScript strict + Vitest;无新依赖(embedding 用主进程 fetch)。

**规格(必读):** `docs/superpowers/specs/2026-07-02-mvp-05-layered-memory.md`

## Global Constraints

- 包管理器是 **pnpm**;测试 `pnpm test` / 单文件 `pnpm vitest run <path>`;类型 `pnpm typecheck`。
- **绝不加 `"type": "module"`** 到 package.json(Electron 主进程会崩)。
- 跨进程值一律走 `src/shared` + `@shared/*` 别名;IPC 通道字符串只用 `IPC` 常量,不硬编码。
- 新增 IPC 能力四文件联动:`src/shared/ipc.ts` → `src/main/shell/index.ts` → `src/preload/index.ts` → 渲染层调用方。
- TDD:纯逻辑先写失败测试再实现;GUI/Electron 接线靠真机验收。
- 提交:每任务一提交,conventional-commit + **中文描述**(如 `feat(memory): ...`)。
- 记忆文件写盘全部原子(临时文件 + rename,同 `settings.ts` 模式);解析失败一律按空数据处理,不崩。
- 常量定死(来自规格):top-K=5、相似度阈值 0.3、退化最近 N=10、transcript 上限 200 条、摘要触发=窗口外未覆盖 ≥8 条、embed 超时 10s、摘要超时 30s、摘要 maxOutputTokens=256。
- `docs/*` 与 `pets/luluka` 被 gitignore(有意),不要试图提交它们。

---

### Task 1: 设置 schema v3(memory.embedding)

**Files:**
- Modify: `src/shared/llm.ts`
- Modify: `src/main/config/settings.ts`
- Modify: `src/renderer/settings.ts`(仅保值透传,UI 在 Task 10)
- Test: `src/main/config/settingsMigration.test.ts`

**Interfaces:**
- Consumes: 现有 `AppSettings/DEFAULT_SETTINGS/SETTINGS_SCHEMA_VERSION`。
- Produces: `EmbeddingSettings { baseURL: string; model: string }`、`MemorySettings { embedding: EmbeddingSettings | null }`、`AppSettings.memory: MemorySettings`、`SETTINGS_SCHEMA_VERSION = 3`。后续任务(6/8/10/11)都依赖 `settings.memory.embedding`。

- [ ] **Step 1: 写失败测试**(追加到 `src/main/config/settingsMigration.test.ts`,沿用该文件已有的临时目录/写文件模式):

```ts
describe('v2 -> v3 迁移(memory)', () => {
  it('v2 设置(无 memory)加载后补 memory.embedding = null,schemaVersion 升为 3', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      provider: { kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      search: { backend: 'tavily' }
    }), 'utf-8')
    const s = loadSettings(file)
    expect(s.schemaVersion).toBe(3)
    expect(s.memory).toEqual({ embedding: null })
    expect(s.provider.model).toBe('deepseek-chat') // 原字段不丢
    expect(s.search.backend).toBe('tavily')
  })

  it('合法 embedding 配置原样保留', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' } }
    }), 'utf-8')
    expect(loadSettings(file).memory.embedding).toEqual({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3'
    })
  })

  it('embedding 缺 model 或 baseURL 为空 → 归一化为 null', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
      search: { backend: 'duckduckgo' },
      memory: { embedding: { baseURL: 'https://x.example/v1' } }
    }), 'utf-8')
    expect(loadSettings(file).memory.embedding).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/settingsMigration.test.ts`
Expected: FAIL(`s.memory` undefined / 类型错误)。

- [ ] **Step 3: 实现**。`src/shared/llm.ts`:

```ts
export type SearchBackendKind = 'duckduckgo' | 'tavily'
export interface SearchSettings { backend: SearchBackendKind }

export interface EmbeddingSettings { baseURL: string; model: string }
export interface MemorySettings { embedding: EmbeddingSettings | null }

export const SETTINGS_SCHEMA_VERSION = 3

export interface AppSettings {
  schemaVersion: number
  provider: ProviderSettings
  search: SearchSettings
  memory: MemorySettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null }
}
```

`src/main/config/settings.ts` 的 `normalize()` 增加 memory 归一化(在 `return` 前):

```ts
  const m = (r.memory ?? {}) as Record<string, unknown>
  const e = (m.embedding ?? null) as Record<string, unknown> | null
  const embedding =
    e && typeof e.baseURL === 'string' && e.baseURL.length > 0 &&
    typeof e.model === 'string' && e.model.length > 0
      ? { baseURL: e.baseURL, model: e.model }
      : null
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding }
  }
```

`src/renderer/settings.ts` 保存时透传已加载的 memory(否则 `setSettings` 类型不过/会丢配置)。顶部加:

```ts
import { ..., type MemorySettings } from '@shared/llm'
let savedMemory: MemorySettings = { embedding: null }
```

初始化回填 IIFE 里加 `savedMemory = snap.settings.memory`;`save` 里 `setSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, provider, search: {...}, memory: savedMemory })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/settingsMigration.test.ts src/main/config/settings.test.ts src/shared/llm.test.ts`(后两个防回归;若它们构造 `AppSettings` 字面量,补上 `memory: { embedding: null }`)
Expected: PASS

Run: `pnpm typecheck`
Expected: 无错误(渲染层已透传 memory)。

- [ ] **Step 5: Commit**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settingsMigration.test.ts src/renderer/settings.ts src/main/config/settings.test.ts src/shared/llm.test.ts
git commit -m "feat(settings): 设置 schema v3,新增 memory.embedding 配置与迁移"
```

---

### Task 2: vectorIndex —— 余弦/topK/缺失检测 + 索引文件读写

**Files:**
- Create: `src/main/memory/vectorIndex.ts`
- Test: `src/main/memory/vectorIndex.test.ts`

**Interfaces:**
- Consumes: 无(纯模块)。
- Produces(Task 8 依赖):
  - `interface VectorEntry { factId: string; vector: number[] }`
  - `interface VectorIndexFile { schemaVersion: 1; model: string; dims: number; entries: VectorEntry[] }`
  - `emptyIndex(model: string): VectorIndexFile`
  - `cosineSimilarity(a: number[], b: number[]): number`(维度不符/零向量 → 0)
  - `topKFactIds(query: number[], entries: VectorEntry[], k: number, threshold: number): string[]`
  - `missingFactIds(factIds: string[], index: VectorIndexFile): string[]`
  - `upsertVectors(index: VectorIndexFile, pairs: VectorEntry[]): VectorIndexFile`
  - `parseIndex(raw: unknown, model: string): VectorIndexFile`(schema/model 不符 → 空索引 = 换模型即全量重建)
  - `loadIndexFor(file: string, model: string): VectorIndexFile` / `saveIndex(file: string, index: VectorIndexFile): void`(原子写)

- [ ] **Step 1: 写失败测试** `src/main/memory/vectorIndex.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/memory/vectorIndex.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/memory/vectorIndex.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface VectorEntry { factId: string; vector: number[] }
export interface VectorIndexFile { schemaVersion: 1; model: string; dims: number; entries: VectorEntry[] }

export function emptyIndex(model: string): VectorIndexFile {
  return { schemaVersion: 1, model, dims: 0, entries: [] }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function topKFactIds(query: number[], entries: VectorEntry[], k: number, threshold: number): string[] {
  return entries
    .map((e) => ({ id: e.factId, score: cosineSimilarity(query, e.vector) }))
    .filter((s) => s.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((s) => s.id)
}

export function missingFactIds(factIds: string[], index: VectorIndexFile): string[] {
  const have = new Set(index.entries.map((e) => e.factId))
  return factIds.filter((id) => !have.has(id))
}

/** dims 以首批向量为准;维度不符的丢弃(防脏数据污染召回) */
export function upsertVectors(index: VectorIndexFile, pairs: VectorEntry[]): VectorIndexFile {
  const dims = index.dims || pairs.find((p) => p.vector.length > 0)?.vector.length || 0
  const byId = new Map(index.entries.map((e) => [e.factId, e]))
  for (const p of pairs) {
    if (p.vector.length === dims && dims > 0) byId.set(p.factId, p)
  }
  return { schemaVersion: 1, model: index.model, dims, entries: [...byId.values()] }
}

/** schema/model 不符或数据损坏 → 空索引(权威源在 facts.json,索引可随时重建) */
export function parseIndex(raw: unknown, model: string): VectorIndexFile {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.schemaVersion !== 1 || r.model !== model || !Array.isArray(r.entries)) return emptyIndex(model)
  const dims = typeof r.dims === 'number' && r.dims > 0 ? Math.trunc(r.dims) : 0
  const entries = (r.entries as VectorEntry[]).filter(
    (e) =>
      e && typeof e.factId === 'string' && Array.isArray(e.vector) &&
      e.vector.length === dims && e.vector.every((n) => typeof n === 'number')
  )
  return { schemaVersion: 1, model, dims, entries }
}

export function loadIndexFor(file: string, model: string): VectorIndexFile {
  try {
    return parseIndex(JSON.parse(readFileSync(file, 'utf-8')), model)
  } catch {
    return emptyIndex(model)
  }
}

export function saveIndex(file: string, index: VectorIndexFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(index), 'utf-8')
  renameSync(tmp, file)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/memory/vectorIndex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/vectorIndex.ts src/main/memory/vectorIndex.test.ts
git commit -m "feat(memory): 纯文件向量索引(余弦/topK/缺失检测/可重建解析+原子写)"
```

---

### Task 3: factStore —— 事实库(唯一权威源)

**Files:**
- Create: `src/main/memory/factStore.ts`
- Test: `src/main/memory/factStore.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(Task 7/8 依赖):
  - `interface Fact { id: string; text: string; createdAt: string; updatedAt: string }`
  - `interface FactsFile { schemaVersion: 1; facts: Fact[] }`
  - `normalizeFactText(text: string): string`(trim + 连续空白折成一个空格)
  - `parseFacts(raw: unknown): FactsFile`(坏数据 → 空)
  - `newFactId(rand?: () => number): string`
  - `upsertFact(file: FactsFile, text: string, now: string, id: string): { file: FactsFile; fact: Fact; deduped: boolean }`
  - `loadFacts(path: string): FactsFile` / `saveFacts(path: string, file: FactsFile): void`(原子写,`JSON.stringify(file, null, 2)` 保持人类可读)

- [ ] **Step 1: 写失败测试** `src/main/memory/factStore.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/memory/factStore.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/memory/factStore.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Fact { id: string; text: string; createdAt: string; updatedAt: string }
export interface FactsFile { schemaVersion: 1; facts: Fact[] }

export function normalizeFactText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function parseFacts(raw: unknown): FactsFile {
  const r = (raw ?? {}) as Record<string, unknown>
  const facts = Array.isArray(r.facts)
    ? (r.facts as Fact[]).filter(
        (f) =>
          f && typeof f.id === 'string' && typeof f.text === 'string' && f.text.length > 0 &&
          typeof f.createdAt === 'string' && typeof f.updatedAt === 'string'
      )
    : []
  return { schemaVersion: 1, facts: facts.map((f) => ({ id: f.id, text: f.text, createdAt: f.createdAt, updatedAt: f.updatedAt })) }
}

export function newFactId(rand: () => number = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')
  return `f_${Date.now().toString(36)}_${suffix}`
}

/** §7.4 MVP 判重:规范化文本完全相同 → 更新 updatedAt 而非新增 */
export function upsertFact(
  file: FactsFile, text: string, now: string, id: string
): { file: FactsFile; fact: Fact; deduped: boolean } {
  const norm = normalizeFactText(text)
  const existing = file.facts.find((f) => normalizeFactText(f.text) === norm)
  if (existing) {
    const fact: Fact = { ...existing, updatedAt: now }
    return { file: { schemaVersion: 1, facts: file.facts.map((f) => (f.id === existing.id ? fact : f)) }, fact, deduped: true }
  }
  const fact: Fact = { id, text: norm, createdAt: now, updatedAt: now }
  return { file: { schemaVersion: 1, facts: [...file.facts, fact] }, fact, deduped: false }
}

export function loadFacts(path: string): FactsFile {
  try {
    return parseFacts(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { schemaVersion: 1, facts: [] }
  }
}

export function saveFacts(path: string, file: FactsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
  renameSync(tmp, path)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/memory/factStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/factStore.ts src/main/memory/factStore.test.ts
git commit -m "feat(memory): 事实库 factStore(权威源,规范化判重+原子写+防御解析)"
```

---

### Task 4: transcriptStore —— 对话历史持久化(200 条裁剪 + totalCount)

**Files:**
- Create: `src/main/memory/transcriptStore.ts`
- Test: `src/main/memory/transcriptStore.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`(`@shared/ipc`)。
- Produces(Task 5/8 依赖):
  - `TRANSCRIPT_MAX = 200`
  - `interface TranscriptFile { schemaVersion: 1; totalCount: number; messages: ChatMessage[] }`
  - `emptyTranscript(): TranscriptFile`
  - `parseTranscript(raw: unknown): TranscriptFile`
  - `appendMessage(t: TranscriptFile, msg: ChatMessage, max?: number): TranscriptFile`(totalCount 单调递增,messages 头部裁剪)
  - `loadTranscript(path: string): TranscriptFile` / `saveTranscript(path: string, t: TranscriptFile): void`(原子写)

- [ ] **Step 1: 写失败测试** `src/main/memory/transcriptStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyTranscript, parseTranscript, appendMessage,
  loadTranscript, saveTranscript, TRANSCRIPT_MAX
} from './transcriptStore'

describe('appendMessage', () => {
  it('追加并递增 totalCount', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi' })
    t = appendMessage(t, { role: 'pet', text: 'yo' })
    expect(t.totalCount).toBe(2)
    expect(t.messages.map((m) => m.text)).toEqual(['hi', 'yo'])
  })
  it('超过上限从头裁剪,totalCount 不回退', () => {
    let t = emptyTranscript()
    for (let i = 0; i < 5; i++) t = appendMessage(t, { role: 'user', text: `m${i}` }, 3)
    expect(t.totalCount).toBe(5)
    expect(t.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4'])
  })
  it('默认上限是 200', () => {
    expect(TRANSCRIPT_MAX).toBe(200)
  })
})

describe('parseTranscript', () => {
  it('坏数据 → 空;非法消息被过滤;totalCount 至少等于 messages 长度', () => {
    expect(parseTranscript('x')).toEqual(emptyTranscript())
    const t = parseTranscript({ totalCount: 1, messages: [{ role: 'user', text: 'a' }, { role: 'ghost', text: 'b' }, null] })
    expect(t.messages).toEqual([{ role: 'user', text: 'a' }])
    expect(t.totalCount).toBe(1)
  })
  it('totalCount 缺失时回退为 messages 长度', () => {
    const t = parseTranscript({ messages: [{ role: 'user', text: 'a' }] })
    expect(t.totalCount).toBe(1)
  })
})

describe('loadTranscript / saveTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tr-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('往返一致;缺失/损坏 → 空', () => {
    const file = join(dir, 'transcript.json')
    expect(loadTranscript(file)).toEqual(emptyTranscript())
    const t = appendMessage(emptyTranscript(), { role: 'user', text: '你好' })
    saveTranscript(file, t)
    expect(loadTranscript(file)).toEqual(t)
    writeFileSync(file, '{broken', 'utf-8')
    expect(loadTranscript(file)).toEqual(emptyTranscript())
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/memory/transcriptStore.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/memory/transcriptStore.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatMessage } from '@shared/ipc'

export const TRANSCRIPT_MAX = 200

export interface TranscriptFile { schemaVersion: 1; totalCount: number; messages: ChatMessage[] }

export function emptyTranscript(): TranscriptFile {
  return { schemaVersion: 1, totalCount: 0, messages: [] }
}

export function parseTranscript(raw: unknown): TranscriptFile {
  const r = (raw ?? {}) as Record<string, unknown>
  const messages = Array.isArray(r.messages)
    ? (r.messages as ChatMessage[]).filter(
        (m) => m && (m.role === 'user' || m.role === 'pet') && typeof m.text === 'string'
      ).map((m) => ({ role: m.role, text: m.text }))
    : []
  const totalCount =
    typeof r.totalCount === 'number' && r.totalCount >= messages.length
      ? Math.trunc(r.totalCount)
      : messages.length
  return { schemaVersion: 1, totalCount, messages }
}

/** totalCount 是累计序号(单调递增),裁剪不回退——摘要的 coveredCount 依赖它对齐 */
export function appendMessage(t: TranscriptFile, msg: ChatMessage, max = TRANSCRIPT_MAX): TranscriptFile {
  const messages = [...t.messages, { role: msg.role, text: msg.text }]
  return {
    schemaVersion: 1,
    totalCount: t.totalCount + 1,
    messages: messages.length > max ? messages.slice(messages.length - max) : messages
  }
}

export function loadTranscript(path: string): TranscriptFile {
  try {
    return parseTranscript(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return emptyTranscript()
  }
}

export function saveTranscript(path: string, t: TranscriptFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(t, null, 2), 'utf-8')
  renameSync(tmp, path)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/memory/transcriptStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/transcriptStore.ts src/main/memory/transcriptStore.test.ts
git commit -m "feat(memory): 对话历史持久化 transcriptStore(200 条裁剪+累计序号)"
```

---

### Task 5: workingSummary —— 溢出判定 + 滚动摘要

**Files:**
- Create: `src/main/memory/workingSummary.ts`
- Test: `src/main/memory/workingSummary.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`(`../providers/llmProvider`)、`ChatMessage`、`createFakeProvider`(测试)。
- Produces(Task 8 依赖):
  - `SUMMARY_TRIGGER = 8`、`SUMMARY_MAX_TOKENS = 256`、`SUMMARY_TIMEOUT_MS = 30000`
  - `interface SummaryFile { schemaVersion: 1; text: string; coveredCount: number; updatedAt: string }`
  - `emptySummary(): SummaryFile` / `parseSummary(raw: unknown): SummaryFile`
  - `overflowRange(t: { totalCount: number; messagesLen: number }, coveredCount: number, windowTurns: number, trigger?: number): { start: number; end: number; newCoveredCount: number } | null`(start/end 为 messages 本地下标,end 不含)
  - `summarize(opts: { provider: LlmProvider; prevSummary: string; messages: ChatMessage[]; signal: AbortSignal }): Promise<string | null>`(失败/空 → null)
  - `loadSummary(path: string): SummaryFile` / `saveSummary(path: string, s: SummaryFile): void`(原子写)

- [ ] **Step 1: 写失败测试** `src/main/memory/workingSummary.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/memory/workingSummary.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/memory/workingSummary.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatMessage } from '@shared/ipc'
import type { LlmProvider } from '../providers/llmProvider'

export const SUMMARY_TRIGGER = 8
export const SUMMARY_MAX_TOKENS = 256
export const SUMMARY_TIMEOUT_MS = 30000

const SUMMARY_SYSTEM =
  '你是对话摘要器。把「已有摘要」与「新增对话」合并成一段简洁的中文工作记忆摘要:' +
  '只保留稳定事实、话题走向与未完成事项;不虚构、不评论;150 字以内;直接输出摘要正文。'

export interface SummaryFile { schemaVersion: 1; text: string; coveredCount: number; updatedAt: string }

export function emptySummary(): SummaryFile {
  return { schemaVersion: 1, text: '', coveredCount: 0, updatedAt: '' }
}

export function parseSummary(raw: unknown): SummaryFile {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    schemaVersion: 1,
    text: typeof r.text === 'string' ? r.text : '',
    coveredCount: typeof r.coveredCount === 'number' && r.coveredCount >= 0 ? Math.trunc(r.coveredCount) : 0,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ''
  }
}

/**
 * 溢出判定:窗口(windowTurns)之外、尚未被摘要覆盖(coveredCount,全局累计序号)的消息
 * ≥ trigger 条时,返回需总结的 messages 本地下标范围 [start, end) 与新的覆盖序号。
 * transcript 裁剪后 messages[0] 的全局序号 = totalCount - messagesLen,据此换算。
 */
export function overflowRange(
  t: { totalCount: number; messagesLen: number },
  coveredCount: number,
  windowTurns: number,
  trigger = SUMMARY_TRIGGER
): { start: number; end: number; newCoveredCount: number } | null {
  const base = t.totalCount - t.messagesLen
  const endGlobal = t.totalCount - windowTurns
  if (endGlobal - coveredCount < trigger) return null
  const startGlobal = Math.max(coveredCount, base)
  if (endGlobal <= startGlobal) return null
  return { start: startGlobal - base, end: endGlobal - base, newCoveredCount: endGlobal }
}

/** 失败/空回复返回 null,调用方保留旧摘要(§5.6:失败即状态,不重试) */
export async function summarize(opts: {
  provider: LlmProvider
  prevSummary: string
  messages: ChatMessage[]
  signal: AbortSignal
}): Promise<string | null> {
  const lines = opts.messages.map((m) => `${m.role === 'user' ? '用户' : '宠物'}:${m.text}`)
  const user =
    (opts.prevSummary ? `已有摘要:\n${opts.prevSummary}\n\n` : '') + `新增对话:\n${lines.join('\n')}`
  let text = ''
  try {
    for await (const chunk of opts.provider.streamChat({
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxOutputTokens: SUMMARY_MAX_TOKENS,
      signal: opts.signal
    })) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'error') return null
      else if (chunk.type === 'done') break
    }
  } catch {
    return null
  }
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function loadSummary(path: string): SummaryFile {
  try {
    return parseSummary(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return emptySummary()
  }
}

export function saveSummary(path: string, s: SummaryFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
  renameSync(tmp, path)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/memory/workingSummary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/workingSummary.ts src/main/memory/workingSummary.test.ts
git commit -m "feat(memory): 滚动工作摘要(溢出判定纯函数+provider 总结+原子写)"
```

---

### Task 6: embedder —— openai-compat /embeddings + fake + key 复用解析

**Files:**
- Create: `src/main/providers/embedder.ts`
- Test: `src/main/providers/embedder.test.ts`

**Interfaces:**
- Consumes: `AppSettings`(`@shared/llm`,Task 1 的 memory 字段)。
- Produces(Task 8/11 依赖):
  - `interface Embedder { readonly model: string; embed(texts: string[], signal: AbortSignal): Promise<number[][]> }`
  - `createOpenAiCompatEmbedder(cfg: { baseURL: string; model: string; getKey: () => string | null }, fetchFn?: typeof fetch): Embedder`
  - `createFakeEmbedder(dims?: number): Embedder`(决定性:同文本同向量)
  - `resolveEmbeddingKey(settings: AppSettings, embeddingKey: string | null, chatKey: string | null): string | null`

- [ ] **Step 1: 写失败测试** `src/main/providers/embedder.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createOpenAiCompatEmbedder, createFakeEmbedder, resolveEmbeddingKey } from './embedder'
import type { AppSettings } from '@shared/llm'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('createOpenAiCompatEmbedder', () => {
  const cfg = { baseURL: 'https://api.example.com/v1/', model: 'emb-1', getKey: () => 'sk-x' }

  it('POST {baseURL}/embeddings,带 Bearer key,按 index 排序返回向量', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] })
    )
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    const vectors = await emb.embed(['a', 'b'], new AbortController().signal)
    expect(vectors).toEqual([[1, 2], [3, 4]])
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/embeddings') // 尾斜杠被归一
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'emb-1', input: ['a', 'b'] })
  })

  it('无 key → 抛错', async () => {
    const emb = createOpenAiCompatEmbedder({ ...cfg, getKey: () => null })
    await expect(emb.embed(['a'], new AbortController().signal)).rejects.toThrow('key')
  })

  it('HTTP 非 2xx → 抛错(含状态码)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 401))
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    await expect(emb.embed(['a'], new AbortController().signal)).rejects.toThrow('401')
  })

  it('返回条数与请求不符 → 抛错', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1] }] }))
    const emb = createOpenAiCompatEmbedder(cfg, fetchFn as unknown as typeof fetch)
    await expect(emb.embed(['a', 'b'], new AbortController().signal)).rejects.toThrow()
  })
})

describe('createFakeEmbedder', () => {
  it('决定性:同文本同向量,不同文本不同向量', async () => {
    const emb = createFakeEmbedder(4)
    const [a1] = await emb.embed(['你好'], new AbortController().signal)
    const [a2, b] = await emb.embed(['你好', '再见'], new AbortController().signal)
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
    expect(a1).toHaveLength(4)
  })
})

describe('resolveEmbeddingKey', () => {
  const base = (embBaseURL: string | null, chatBaseURL?: string): AppSettings => ({
    schemaVersion: 3,
    provider: { kind: 'openai-compat', baseURL: chatBaseURL, model: 'm' },
    search: { backend: 'duckduckgo' },
    memory: { embedding: embBaseURL ? { baseURL: embBaseURL, model: 'e' } : null }
  })
  it('有独立 key 优先用', () => {
    expect(resolveEmbeddingKey(base('https://a/v1', 'https://a/v1'), 'ek', 'ck')).toBe('ek')
  })
  it('无独立 key 且与聊天同 baseURL → 复用聊天 key', () => {
    expect(resolveEmbeddingKey(base('https://a/v1', 'https://a/v1'), null, 'ck')).toBe('ck')
  })
  it('无独立 key 且 baseURL 不同(或聊天无 baseURL,如 anthropic)→ null', () => {
    expect(resolveEmbeddingKey(base('https://b/v1', 'https://a/v1'), null, 'ck')).toBeNull()
    expect(resolveEmbeddingKey(base('https://b/v1', undefined), null, 'ck')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/providers/embedder.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/providers/embedder.ts`:

```ts
import type { AppSettings } from '@shared/llm'

export interface Embedder {
  readonly model: string
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>
}

/** openai-compat 标准 POST /embeddings;key 由外部注入,本模块不落盘不打日志 */
export function createOpenAiCompatEmbedder(
  cfg: { baseURL: string; model: string; getKey: () => string | null },
  fetchFn: typeof fetch = fetch
): Embedder {
  return {
    model: cfg.model,
    async embed(texts, signal) {
      const key = cfg.getKey()
      if (!key) throw new Error('未配置 embedding API key')
      const url = `${cfg.baseURL.replace(/\/+$/, '')}/embeddings`
      const res = await fetchFn(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model, input: texts })
      })
      if (!res.ok) throw new Error(`embedding 请求失败(HTTP ${res.status})`)
      const data = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
      const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (items.length !== texts.length) throw new Error('embedding 返回条数与请求不符')
      return items.map((d) => {
        if (!Array.isArray(d.embedding)) throw new Error('embedding 返回格式不符')
        return d.embedding
      })
    }
  }
}

/** 决定性伪 embedding(字符码散列到固定维度),仅测试用 */
export function createFakeEmbedder(dims = 8): Embedder {
  return {
    model: 'fake-embedding',
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dims).fill(0)
        for (let i = 0; i < t.length; i++) v[i % dims] += t.charCodeAt(i) / 1000
        return v
      })
    }
  }
}

/** embedding key 解析:独立 key 优先;留空且与聊天 provider 同 baseURL 时复用聊天 key */
export function resolveEmbeddingKey(
  settings: AppSettings,
  embeddingKey: string | null,
  chatKey: string | null
): string | null {
  if (embeddingKey) return embeddingKey
  const emb = settings.memory.embedding
  if (emb && settings.provider.baseURL && settings.provider.baseURL === emb.baseURL) return chatKey
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/providers/embedder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/embedder.ts src/main/providers/embedder.test.ts
git commit -m "feat(providers): Embedder 接口(openai-compat /embeddings + fake + key 复用解析)"
```

---

### Task 7: save_memory 工具

**Files:**
- Create: `src/main/tools/saveMemory.ts`
- Test: `src/main/tools/saveMemory.test.ts`

**Interfaces:**
- Consumes: `ToolSpec/ToolContext`(`./toolSpec`)。
- Produces(Task 11 依赖): `createSaveMemoryTool(saveFact: (text: string) => { text: string; deduped: boolean }): ToolSpec`,工具名 `save_memory`,入参 `{ text: string }`。

- [ ] **Step 1: 写失败测试** `src/main/tools/saveMemory.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createSaveMemoryTool } from './saveMemory'
import { createToolRegistry } from './toolRegistry'

const ctx = (onStatus?: (t: string) => void) => ({ signal: new AbortController().signal, onStatus })

describe('save_memory 工具', () => {
  it('调用 saveFact 并播报「记住了」', async () => {
    const saveFact = vi.fn(() => ({ text: '用户叫小星', deduped: false }))
    const statuses: string[] = []
    const tool = createSaveMemoryTool(saveFact)
    const out = await tool.run({ text: ' 用户叫小星 ' }, ctx((t) => statuses.push(t)))
    expect(saveFact).toHaveBeenCalledWith('用户叫小星') // 已 trim
    expect(out).toContain('已记住')
    expect(statuses[0]).toContain('记住了')
  })

  it('判重时返回「已经记过」', async () => {
    const tool = createSaveMemoryTool(() => ({ text: '用户叫小星', deduped: true }))
    const out = await tool.run({ text: '用户叫小星' }, ctx())
    expect(out).toContain('已经记过')
  })

  it('空 text 经 registry 转为 isError 回灌,不抛', async () => {
    const registry = createToolRegistry([createSaveMemoryTool(() => ({ text: '', deduped: false }))])
    const r = await registry.run('save_memory', { text: '   ' }, ctx())
    expect(r.isError).toBe(true)
  })

  it('缺 text 被 registry 校验拦下', async () => {
    const registry = createToolRegistry([createSaveMemoryTool(() => ({ text: '', deduped: false }))])
    const r = await registry.run('save_memory', {}, ctx())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('text')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/tools/saveMemory.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/tools/saveMemory.ts`:

```ts
import type { ToolSpec } from './toolSpec'

/**
 * 长期记忆写入工具:saveFact 由外部注入(memoryManager.saveFact),
 * 本模块不碰文件系统;抛错交给 registry 转 isError 回灌。
 */
export function createSaveMemoryTool(
  saveFact: (text: string) => { text: string; deduped: boolean }
): ToolSpec {
  return {
    name: 'save_memory',
    description:
      '把关于用户的一条稳定事实、偏好或重要事件记进长期记忆(如「用户叫小星」「用户爱吃冰淇淋」)。' +
      'text 要简洁、自包含;临时话题或一次性问题不要记。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要记住的一条事实,简洁自包含' } },
      required: ['text']
    },
    async run(input, ctx) {
      const { text } = input as { text: string }
      const trimmed = text.trim()
      if (!trimmed) throw new Error('text 不能为空')
      const r = saveFact(trimmed)
      ctx.onStatus?.(`记住了:${r.text}`)
      return r.deduped ? `这条已经记过了,已更新时间:${r.text}` : `已记住:${r.text}`
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/tools/saveMemory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/saveMemory.ts src/main/tools/saveMemory.test.ts
git commit -m "feat(tools): save_memory 工具(写事实库+状态播报,registry 契约内不抛)"
```

---

### Task 8: memoryManager —— 记忆门面(召回/懒补建/写入/摘要编排)

**Files:**
- Create: `src/main/memory/memoryManager.ts`
- Test: `src/main/memory/memoryManager.test.ts`

**Interfaces:**
- Consumes: Task 2-6 的全部导出;`WINDOW_TURNS`(`../agent/promptAssembler`);`LlmProvider`。
- Produces(Task 10/11 依赖):
  - `RECALL_TOP_K = 5`、`RECALL_THRESHOLD = 0.3`、`DEGRADED_RECENT = 10`、`EMBED_TIMEOUT_MS = 10000`
  - `interface RecallResult { facts: string[]; summary?: string }`
  - `interface MemoryManager { messages(): ChatMessage[]; appendMessage(msg: ChatMessage): void; saveFact(text: string): { text: string; deduped: boolean }; recall(query: string, signal: AbortSignal): Promise<RecallResult>; maybeSummarize(makeProvider: () => LlmProvider | null): void }`
  - `createMemoryManager(opts: { dir: string; getEmbedder: () => Embedder | null; now?: () => Date }): MemoryManager`

- [ ] **Step 1: 写失败测试** `src/main/memory/memoryManager.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/memory/memoryManager.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/memory/memoryManager.ts`:

```ts
import { join } from 'node:path'
import type { ChatMessage } from '@shared/ipc'
import type { LlmProvider } from '../providers/llmProvider'
import type { Embedder } from '../providers/embedder'
import { WINDOW_TURNS } from '../agent/promptAssembler'
import { loadFacts, saveFacts, upsertFact, newFactId, type FactsFile } from './factStore'
import { loadIndexFor, saveIndex, missingFactIds, topKFactIds, upsertVectors } from './vectorIndex'
import { loadTranscript, saveTranscript, appendMessage as appendToTranscript, type TranscriptFile } from './transcriptStore'
import {
  loadSummary, saveSummary, overflowRange, summarize,
  SUMMARY_TIMEOUT_MS, type SummaryFile
} from './workingSummary'

export const RECALL_TOP_K = 5
export const RECALL_THRESHOLD = 0.3
export const DEGRADED_RECENT = 10
export const EMBED_TIMEOUT_MS = 10000

export interface RecallResult { facts: string[]; summary?: string }

export interface MemoryManager {
  messages(): ChatMessage[]
  appendMessage(msg: ChatMessage): void
  saveFact(text: string): { text: string; deduped: boolean }
  recall(query: string, signal: AbortSignal): Promise<RecallResult>
  maybeSummarize(makeProvider: () => LlmProvider | null): void
}

/**
 * 记忆门面:facts/vector-index/summary/transcript 四文件的唯一编排者。
 * 原则(§5.6):记忆链路任何故障都不阻断对话主链路——recall 永不抛,退化返回。
 */
export function createMemoryManager(opts: {
  dir: string
  getEmbedder: () => Embedder | null
  now?: () => Date
}): MemoryManager {
  const factsFile = join(opts.dir, 'facts.json')
  const indexFile = join(opts.dir, 'vector-index.json')
  const summaryFile = join(opts.dir, 'summary.json')
  const transcriptFile = join(opts.dir, 'transcript.json')
  const now = opts.now ?? (() => new Date())

  let facts: FactsFile = loadFacts(factsFile)
  let transcript: TranscriptFile = loadTranscript(transcriptFile)
  let summary: SummaryFile = loadSummary(summaryFile)
  let summarizing = false

  function degradedFacts(): string[] {
    return [...facts.facts]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, DEGRADED_RECENT)
      .map((f) => f.text)
  }

  function withSummary(list: string[]): RecallResult {
    return summary.text ? { facts: list, summary: summary.text } : { facts: list }
  }

  return {
    messages: () => transcript.messages,

    appendMessage(msg) {
      transcript = appendToTranscript(transcript, msg)
      try { saveTranscript(transcriptFile, transcript) } catch (e) { console.warn('[memory] transcript 写盘失败', e) }
    },

    saveFact(text) {
      const r = upsertFact(facts, text, now().toISOString(), newFactId())
      facts = r.file
      saveFacts(factsFile, facts) // 抛错交给工具 registry 转 isError
      return { text: r.fact.text, deduped: r.deduped }
    },

    async recall(query, signal) {
      const embedder = opts.getEmbedder()
      if (!embedder || facts.facts.length === 0) return withSummary(degradedFacts())
      // 独立超时 + 外部取消桥接(同 agentLoop 模式)
      const internal = new AbortController()
      const onAbort = (): void => internal.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => internal.abort(), EMBED_TIMEOUT_MS)
      try {
        let index = loadIndexFor(indexFile, embedder.model)
        const byId = new Map(facts.facts.map((f) => [f.id, f.text]))
        const missing = missingFactIds([...byId.keys()], index)
        if (missing.length > 0) {
          const vectors = await embedder.embed(missing.map((id) => byId.get(id) ?? ''), internal.signal)
          index = upsertVectors(index, missing.map((factId, i) => ({ factId, vector: vectors[i] })))
          saveIndex(indexFile, index)
        }
        const [qv] = await embedder.embed([query], internal.signal)
        const ids = topKFactIds(qv, index.entries, RECALL_TOP_K, RECALL_THRESHOLD)
        return withSummary(ids.map((id) => byId.get(id)).filter((t): t is string => !!t))
      } catch {
        return withSummary(degradedFacts()) // 静默退化,绝不阻断对话
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },

    maybeSummarize(makeProvider) {
      if (summarizing) return
      const range = overflowRange(
        { totalCount: transcript.totalCount, messagesLen: transcript.messages.length },
        summary.coveredCount,
        WINDOW_TURNS
      )
      if (!range) return
      const provider = makeProvider()
      if (!provider) return
      summarizing = true
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS)
      const slice = transcript.messages.slice(range.start, range.end)
      void summarize({ provider, prevSummary: summary.text, messages: slice, signal: ctrl.signal })
        .then((text) => {
          if (text) {
            summary = { schemaVersion: 1, text, coveredCount: range.newCoveredCount, updatedAt: now().toISOString() }
            saveSummary(summaryFile, summary)
          }
        })
        .catch(() => { /* 保留旧摘要,下次再试 */ })
        .finally(() => { clearTimeout(timer); summarizing = false })
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/memory/memoryManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/memoryManager.ts src/main/memory/memoryManager.test.ts
git commit -m "feat(memory): memoryManager 门面(top-K 召回+懒补建+退化+异步滚动摘要)"
```

---

### Task 9: promptAssembler 记忆注入(§5.4 收口)

**Files:**
- Modify: `src/main/agent/promptAssembler.ts`
- Modify: `src/main/agent/promptAssembler.test.ts`(替换占位符断言)
- Test: 同上(新增用例)

**Interfaces:**
- Consumes: 无新依赖。
- Produces(Task 11 依赖): `interface MemoryContext { facts: string[]; summary?: string }`;`assemblePrompt(persona, transcript, skills?: SkillMeta[], memory?: MemoryContext)`。`MEMORY_PLACEHOLDER` 删除。`RecallResult`(Task 8)结构兼容 `MemoryContext`,可直接传入。

- [ ] **Step 1: 改/写测试**。`promptAssembler.test.ts` 中:
  - 第一个用例改名为 `joins persona blocks in order into system`,删除 `expect(system).toContain('MVP-05')` 断言,改为 `expect(system).toBe('P\n\nV\n\nB\n\nT')`(无技能无记忆时干干净净)。
  - `skips empty persona blocks` 用例改为 `expect(system).toBe('P')`。
  - 追加:

```ts
describe('memory 注入', () => {
  it('facts 渲染为「关于用户的记忆」小节', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: ['用户叫小星', '用户爱吃冰淇淋'] })
    expect(system).toContain('# 关于用户的记忆')
    expect(system).toContain('- 用户叫小星')
    expect(system).toContain('- 用户爱吃冰淇淋')
    expect(system).not.toContain('# 上次对话摘要')
  })
  it('summary 渲染为「上次对话摘要」小节', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: [], summary: '上次聊到考研。' })
    expect(system).toContain('# 上次对话摘要\n上次聊到考研。')
    expect(system).not.toContain('# 关于用户的记忆')
  })
  it('无记忆时不出现记忆小节与占位注释', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: [] })
    expect(system).not.toContain('记忆')
    expect(system).not.toContain('<!--')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: FAIL(签名不符/占位仍在)。

- [ ] **Step 3: 实现**。`promptAssembler.ts` 全文替换为:

```ts
import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'
import type { SkillMeta } from '../skills/skillLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

/** 召回的记忆上下文;memoryManager.RecallResult 结构兼容 */
export interface MemoryContext { facts: string[]; summary?: string }

export const WINDOW_TURNS = 12

function skillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  return (
    '\n\n# 可用技能\n' +
    '你有以下技能;当用户的请求匹配某个技能的用途时,先用 read_skill 工具读取它的完整说明再照做:\n' +
    skills.map((s) => `- ${s.name}:${s.description}`).join('\n')
  )
}

/** §5.4:[人设分块]+[召回的长期记忆]+[工作记忆摘要],记忆为空时对应小节整体省略 */
function memorySection(memory?: MemoryContext): string {
  if (!memory) return ''
  let out = ''
  if (memory.facts.length > 0) {
    out +=
      '\n\n# 关于用户的记忆\n以下是你之前记住的关于用户的事实,回答时自然地用上,不要生硬复述:\n' +
      memory.facts.map((f) => `- ${f}`).join('\n')
  }
  if (memory.summary) out += `\n\n# 上次对话摘要\n${memory.summary}`
  return out
}

export function assemblePrompt(
  persona: PersonaBlocks,
  transcript: ChatMessage[],
  skills: SkillMeta[] = [],
  memory?: MemoryContext
): AssembledPrompt {
  const system =
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    skillsSection(skills) +
    memorySection(memory)

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts src/main/agent/promptAssemblerSkills.test.ts`
Expected: PASS(skills 测试若引用占位符也一并修正)。

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/promptAssembler.ts src/main/agent/promptAssembler.test.ts src/main/agent/promptAssemblerSkills.test.ts
git commit -m "feat(agent): promptAssembler 注入记忆小节,替换 MVP-05 占位符(§5.4 收口)"
```

---

### Task 10: 设置面——IPC + preload + 设置窗「记忆」小节

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/shell/index.ts`
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: Task 1 的 `MemorySettings`。
- Produces(Task 11 依赖 shell 中的 `embeddingSecrets` 与 `memoryDir`):
  - `IPC.SET_EMBEDDING_KEY = 'settings:set-embedding-key'`、`IPC.OPEN_MEMORY_DIR = 'settings:open-memory-dir'`
  - `SettingsSnapshot` 增 `hasEmbeddingKey: boolean`
  - `SettingsApi` 增 `setEmbeddingKey(key: string): Promise<boolean>`、`openMemoryDir(): void`

- [ ] **Step 1: `src/shared/ipc.ts`**——`IPC` 常量追加两条通道;`SettingsSnapshot` 增 `hasEmbeddingKey: boolean`;`SettingsApi` 增两个方法:

```ts
  SET_EMBEDDING_KEY: 'settings:set-embedding-key',
  OPEN_MEMORY_DIR: 'settings:open-memory-dir'
```

```ts
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean }
```

```ts
export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
}
```

- [ ] **Step 2: `src/preload/index.ts`**——`settingsApi` 增:

```ts
  setEmbeddingKey: (key: string) => ipcRenderer.invoke(IPC.SET_EMBEDDING_KEY, key),
  openMemoryDir: (): void => ipcRenderer.send(IPC.OPEN_MEMORY_DIR),
```

- [ ] **Step 3: `src/main/shell/index.ts`**——electron 导入加 `shell`(命名为 `electronShell` 防混淆:`import { app, ipcMain, safeStorage, screen, shell as electronShell, type Tray } from 'electron'`);`mkdirSync` 从 `node:fs` 导入。在 `searchSecrets` 之后加:

```ts
  const embeddingSecrets = createSecretStore(join(app.getPath('userData'), 'secrets-embedding.bin'), safeStorage)
  const memoryDir = join(app.getPath('userData'), 'memory')
```

`GET_SETTINGS` 返回值加 `hasEmbeddingKey: embeddingSecrets.hasKey()`;`SET_SEARCH_KEY` handler 后追加:

```ts
  ipcMain.handle(IPC.SET_EMBEDDING_KEY, async (_e, key: string): Promise<boolean> => embeddingSecrets.setKey(String(key ?? '')))
  ipcMain.on(IPC.OPEN_MEMORY_DIR, () => {
    mkdirSync(memoryDir, { recursive: true })
    void electronShell.openPath(memoryDir)
  })
```

- [ ] **Step 4: `src/renderer/settings.html`**——在搜索小节(`searchKeyRow` 的 label)之后、按钮行之前插入:

```html
      <h1 style="margin-top:8px">记忆(可选)</h1>
      <div style="opacity:.8;line-height:1.5">配置 embedding 后,宠物记住的事实会发送到该端点做向量化,以便按话题召回;三项留空则记忆完全本地(按最近记忆召回)。</div>
      <label>Embedding Base URL
        <input id="embBaseURL" type="text" placeholder="https://...(OpenAI 兼容,如 DashScope)" />
      </label>
      <label>Embedding 模型
        <input id="embModel" type="text" placeholder="如 text-embedding-v3" />
      </label>
      <label>Embedding API Key
        <input id="embKey" type="password" placeholder="留空且与聊天同 Base URL 时自动复用聊天 Key" />
      </label>
      <div class="row">
        <button id="openMemoryDir" class="secondary">打开记忆文件夹</button>
      </div>
```

- [ ] **Step 5: `src/renderer/settings.ts`**——移除 Task 1 的 `savedMemory` 透传,改为真实 UI。元素引用区加:

```ts
const embBaseURL = $<HTMLInputElement>('embBaseURL')
const embModel = $<HTMLInputElement>('embModel')
const embKey = $<HTMLInputElement>('embKey')
```

事件区加:

```ts
$<HTMLButtonElement>('openMemoryDir').addEventListener('click', () => window.settingsApi.openMemoryDir())
```

`save` 处理器中,`setSettings` 前保存 embedding key、组装 memory:

```ts
    if (embKey.value) {
      const ok = await window.settingsApi.setEmbeddingKey(embKey.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Embedding Key'; return }
    }
    const embedding =
      embBaseURL.value.trim() && embModel.value.trim()
        ? { baseURL: embBaseURL.value.trim(), model: embModel.value.trim() }
        : null
```

`setSettings` 调用改为 `{ schemaVersion: SETTINGS_SCHEMA_VERSION, provider, search: { backend: searchBackend.value as SearchBackendKind }, memory: { embedding } }`。初始化 IIFE 中回填:

```ts
  if (snap.settings.memory.embedding) {
    embBaseURL.value = snap.settings.memory.embedding.baseURL
    embModel.value = snap.settings.memory.embedding.model
  }
  if (snap.hasEmbeddingKey) embKey.placeholder = '(已配置,如需更换请重新填写)'
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿(此任务是 GUI/接线,无新单测;类型与既有测试防回归)。

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/shell/index.ts src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(settings): 设置窗「记忆」小节(embedding 配置+隐私文案+打开记忆文件夹)"
```

---

### Task 11: chat 管道接入记忆 + shell 装配

**Files:**
- Modify: `src/main/shell/chat.ts`
- Modify: `src/main/shell/index.ts`
- Test: `src/main/shell/chat.test.ts`(新建)

**Interfaces:**
- Consumes: `MemoryManager`(Task 8)、`createSaveMemoryTool`(Task 7)、`MemoryContext` 注入(Task 9)、`createOpenAiCompatEmbedder/resolveEmbeddingKey`(Task 6)、`embeddingSecrets/memoryDir`(Task 10)。
- Produces: `createChatStore` 新增必填 `memory: MemoryManager` 与可选 `makeProvider?: (provider: ProviderSettings, key: string) => LlmProvider`(测试注入缝,默认 `createProvider`);内部 transcript 数组删除,统一走 `memory`。

- [ ] **Step 1: 写失败测试** `src/main/shell/chat.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatStore } from './chat'
import { createMemoryManager } from '../memory/memoryManager'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { AppSettings } from '@shared/llm'

const settings: AppSettings = {
  schemaVersion: 3,
  provider: { kind: 'fake', model: 'fake' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null }
}

function recording(inner: LlmProvider, seen: StreamChatRequest[]): LlmProvider {
  return { streamChat: (req) => { seen.push(req); return inner.streamChat(req) } }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeStore(provider: LlmProvider, seen: StreamChatRequest[]) {
  const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
  let done: () => void = () => {}
  const finished = new Promise<void>((r) => { done = r })
  const store = createChatStore({
    petDir: join(dir, 'no-pet'), // persona 缺失退化为空,无碍
    skills: { list: () => [], body: () => null },
    memory,
    loadSettings: () => settings,
    getKey: () => 'k',
    getSearchKey: () => null,
    makeProvider: () => recording(provider, seen),
    emitPetEvent: () => {},
    pushUpdate: () => {},
    pushStream: () => {},
    pushStatus: () => {},
    pushDone: () => done(),
    pushError: () => done(),
    openSettings: () => {}
  })
  return { store, memory, finished }
}

describe('chat 记忆管道(集成:fake provider + 退化召回)', () => {
  it('召回的事实注入 system;user/pet 消息都持久化', async () => {
    const seen: StreamChatRequest[] = []
    const { store, memory, finished } = makeStore(createFakeProvider({ reply: '你好小星!' }), seen)
    memory.saveFact('用户叫小星')
    store.handleSend({ text: '你好' })
    await finished
    expect(seen[0].system).toContain('# 关于用户的记忆')
    expect(seen[0].system).toContain('用户叫小星')
    const t = JSON.parse(readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8'))
    expect(t.messages.map((m: { text: string }) => m.text)).toEqual(['你好', '你好小星!'])
  })

  it('模型调 save_memory → 事实落盘 facts.json', async () => {
    const seen: StreamChatRequest[] = []
    const provider = createFakeProvider({
      script: [
        [{ type: 'tool_use', toolUse: { id: 't1', name: 'save_memory', input: { text: '用户爱吃冰淇淋' } } }],
        [{ type: 'text', text: '记好啦!' }, { type: 'done' }]
      ]
    })
    const { store, finished } = makeStore(provider, seen)
    store.handleSend({ text: '我爱吃冰淇淋,记住哦' })
    await finished
    const facts = JSON.parse(readFileSync(join(dir, 'memory', 'facts.json'), 'utf-8'))
    expect(facts.facts.map((f: { text: string }) => f.text)).toEqual(['用户爱吃冰淇淋'])
  })

  it('save_memory 工具在 registry 中注册(defs 传给 provider)', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name)).toContain('save_memory')
  })

  it('重启(重建 store)后 messages 恢复', async () => {
    const seen: StreamChatRequest[] = []
    const first = makeStore(createFakeProvider({ reply: '好' }), seen)
    first.store.handleSend({ text: '第一句' })
    await first.finished
    const second = makeStore(createFakeProvider({ reply: '好' }), [])
    expect(second.store.messages().map((m) => m.text)).toEqual(['第一句', '好'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: FAIL(`createChatStore` 无 `memory`/`makeProvider` 选项)。

- [ ] **Step 3: 实现**。`src/main/shell/chat.ts` 全文替换为:

```ts
import type { ChatMessage, ChatSendPayload } from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { loadPersona } from '../persona/personaLoader'
import { assemblePrompt } from '../agent/promptAssembler'
import { runAgent } from '../agent/agentLoop'
import { createProvider } from '../providers/createProvider'
import type { LlmProvider } from '../providers/llmProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import { createWebSearchTool } from '../tools/webSearch'
import { createReadSkillTool } from '../tools/readSkill'
import { createSaveMemoryTool } from '../tools/saveMemory'
import { createDuckDuckGoBackend } from '../tools/searchBackends/duckduckgo'
import { createTavilyBackend } from '../tools/searchBackends/tavily'
import type { SkillIndex } from '../skills/skillLoader'
import type { MemoryManager } from '../memory/memoryManager'

const TIMEOUT_MS = 60000
const MAX_OUTPUT_TOKENS = 1024
const UNCONFIGURED_REPLY = '(还没接上大脑)先在托盘「设置」里选好 Provider 并填 API Key 吧~我已帮你打开设置。'

export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
  cancel(): void
}

export function createChatStore(opts: {
  petDir: string
  skills: SkillIndex
  memory: MemoryManager
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  /** 测试注入缝;生产默认 createProvider */
  makeProvider?: (provider: ProviderSettings, key: string) => LlmProvider
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushStatus: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
}): ChatStore {
  const make = opts.makeProvider ?? createProvider
  let inFlight: AbortController | null = null

  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
  }

  return {
    messages: () => opts.memory.messages(),
    cancel,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      if (!text) return
      cancel() // 新消息取消在途
      opts.memory.appendMessage({ role: 'user', text })
      opts.pushUpdate(opts.memory.messages())
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        opts.memory.appendMessage({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(opts.memory.messages())
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const provider = make(settings.provider, key)
      // 每次发送按当前设置构建后端与工具(设置可能在两次发送之间变更)
      const backend = settings.search.backend === 'tavily'
        ? createTavilyBackend(() => opts.getSearchKey())
        : createDuckDuckGoBackend()
      const registry = createToolRegistry([
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t))
      ])

      const ctrl = new AbortController()
      inFlight = ctrl
      let acc = ''
      void (async () => {
        // 召回在 runAgent 之前;recall 永不抛(内部退化),取消则直接放弃
        const recalled = await opts.memory.recall(text, ctrl.signal)
        if (ctrl.signal.aborted) return
        const { system, messages } = assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled)
        const res = await runAgent({
          provider,
          system,
          messages,
          registry,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          signal: ctrl.signal,
          onText: (t) => { acc += t; opts.pushStream(t) },
          onStatus: (t) => opts.pushStatus(t)
        })
        if (inFlight === ctrl) inFlight = null
        if (res.canceled) return // 静默丢弃
        if (res.error) {
          // 有部分文本(如轮数上限)时先落 transcript,再报错
          if (acc) opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
        } else {
          opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushDone()
          opts.emitPetEvent('replyDone')
        }
        // 回复收尾后检查滚动摘要(异步后台,不阻塞下一条)
        opts.memory.maybeSummarize(() => {
          const k = opts.getKey()
          return k ? make(settings.provider, k) : null
        })
      })()
    }
  }
}
```

- [ ] **Step 4: shell 装配**。`src/main/shell/index.ts`:导入区加:

```ts
import { createMemoryManager } from '../memory/memoryManager'
import { createOpenAiCompatEmbedder, resolveEmbeddingKey, type Embedder } from '../providers/embedder'
```

在 `const chat = createChatStore({...})` 之前(Task 10 已有 `embeddingSecrets`/`memoryDir`)加:

```ts
  // embedding 按当前设置即时构建(设置可变);未配置返回 null → 召回退化
  function getEmbedder(): Embedder | null {
    const s = loadSettings(settingsFile)
    const emb = s.memory.embedding
    if (!emb) return null
    return createOpenAiCompatEmbedder({
      baseURL: emb.baseURL,
      model: emb.model,
      getKey: () => resolveEmbeddingKey(s, embeddingSecrets.getKey(), secrets.getKey())
    })
  }
  const memory = createMemoryManager({ dir: memoryDir, getEmbedder })
```

`createChatStore` 调用加一行 `memory,`。启动推送:对话框打开时 `dialog.pushUpdate(chat.messages())` 已存在(`onOpened`),持久化的历史自动可见,无需新代码。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: PASS

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/main/shell/chat.ts src/main/shell/index.ts src/main/shell/chat.test.ts
git commit -m "feat(shell): chat 管道接入分层记忆(召回注入+save_memory+历史持久化+异步摘要)"
```

---

### Task 12: 文档、persona 引导与真机验收

**Files:**
- Create: `README.md`(仓库根,目前不存在)
- Modify: `src/main/memory/README.md`(把占位 stub 换成真实说明)
- Modify: `PROGRESS.md`
- Modify(磁盘副本,gitignore 内,不提交): `pets/luluka/persona.md`

**Interfaces:** 无代码接口;交付物是文档与真机验收结论。

- [ ] **Step 1: 创建根 `README.md`**(§7.3 硬性要求的隐私告知):

```markdown
# Pet-Agent · 桌面宠物 Agent

Shimeji 风格的桌面宠物(Electron + TypeScript),内置自研 agent 内核:可插拔 LLM Provider、Markdown 技能、分层记忆。

## 快速开始

​```bash
pnpm install
pnpm dev          # 开发模式
pnpm build && pnpm preview   # 构建后预览
​```

首次启动会弹出设置窗:选择 Provider(Claude / OpenAI 兼容端点)、填入 API Key 即可对话。

## 记忆与隐私(重要)

宠物拥有分层记忆,数据存在用户目录的 `memory/` 文件夹(设置窗有「打开记忆文件夹」按钮):

- `facts.json` —— 宠物记住的关于你的事实(唯一权威源,人类可读,可手动编辑/删除)
- `vector-index.json` —— 由事实生成的向量索引,可随时删除,会自动重建
- `summary.json` / `transcript.json` —— 对话摘要与最近对话历史

**Embedding 隐私告知**:如果你在设置的「记忆」小节配置了 embedding 端点,被记住的事实文本会发送到该端点做向量化(用于按话题召回)。**留空即完全本地**(按最近记忆召回),功能照常可用。对话本身始终会发送给你配置的聊天 Provider。

备份/迁移:整个 `memory/` 目录直接拷走即可;卸载应用不会删除它。
​```
```

(注意:上面代码块内的 ``` 转义仅为计划文档展示,写入真实 README 时用正常围栏。)

- [ ] **Step 2: 更新 `src/main/memory/README.md`** 为模块说明(职责一段话 + 四文件清单 + "权威源 facts.json,索引可重建"原则 + 模块清单 factStore/vectorIndex/transcriptStore/workingSummary/memoryManager 各一行)。

- [ ] **Step 3: persona 引导(磁盘副本,不提交)**。编辑 `pets/luluka/persona.md` 的 `# Tools` 块,追加:

```markdown
- 当用户透露稳定的个人信息、偏好或重要事件(名字、生日、爱好、在做的事),用 save_memory 把它记成一条简洁、自包含的事实(如「用户叫小星」)。临时话题、一次性问题不要记。
- 系统提示里「关于用户的记忆」「上次对话摘要」是你自己的记忆,回答时自然地用上,不要向用户复述清单。
```

- [ ] **Step 4: 全量回归**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 测试全绿、类型无错、三 bundle 构建成功。

- [ ] **Step 5: 真机验收**(规格 §11;**必须真开应用肉眼确认**):

Run: `pnpm preview`(某些沙箱 shell 需先 `unset ELECTRON_RUN_AS_NODE`)

1. 对宠物说「我叫小星,我爱吃冰淇淋,记住哦」→ 状态行出现「记住了:…」;`memory/facts.json` 出现对应条目。
2. 退出应用重启 → 问「我叫什么?」→ 答出「小星」(未配 embedding 即退化召回路径)。
3. 设置窗「记忆」小节填入 embedding(如 DashScope text-embedding-v3)→ 再问一次 → 正常召回;`memory/vector-index.json` 生成。
4. 删除 `vector-index.json` → 再对话 → 索引自动重建,facts 无损。
5. 连续聊超过 20 条消息 → `memory/summary.json` 出现且内容合理;重启后对话框能看到历史消息,宠物延续语境。
6. 点「打开记忆文件夹」→ 资源管理器打开 memory 目录。

- [ ] **Step 6: 更新 `PROGRESS.md`**:§1 一句话现状改为 MVP-05 完成;§4 代码地图加 `memory/` 模块与 embedder/saveMemory;§6 路线图勾掉 MVP-05;§7 记录遗留 Minor(实测发现的);§5 关键文档补本规格/计划路径;注明 persona.md 磁盘副本已加 save_memory 引导(合并到 main 后需在 main 的磁盘副本重新应用,沿用 MVP-04 先例)。

- [ ] **Step 7: Commit**

```bash
git add README.md src/main/memory/README.md PROGRESS.md
git commit -m "docs: MVP-05 分层记忆完成(README 隐私告知+进度文档),真机验收通过"
```

---

## Self-Review 记录

- **规格覆盖**:§4 四文件(Task 2/3/4/5)、§5 模块地图(Task 2-9)、§6 数据流(Task 11)、§7 prompt 组装(Task 9)、§8 save_memory(Task 7)、§9 设置/IPC/key 复用/隐私文案/打开文件夹(Task 1/6/10)、§10 边界(Task 5/8/11 内嵌)、§11 单测清单(各任务)与真机验收(Task 12)、§12 persona 引导(Task 12)。README 隐私告知(§7.3)在 Task 12。无缺口。
- **类型一致性**:`RecallResult { facts, summary? }`(Task 8)结构兼容 `MemoryContext`(Task 9);`saveFact` 返回 `{ text, deduped }` 与 Task 7 注入签名一致;`overflowRange` 返回 `{ start, end, newCoveredCount }` 与 Task 8 使用一致;`WINDOW_TURNS` 单一来源(promptAssembler)。
- **占位符扫描**:无 TBD/TODO;所有代码步骤给出完整代码。
