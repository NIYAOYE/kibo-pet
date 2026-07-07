# MVP-06 打包安装 + 可移植宠物包 + 安全加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MVP-05 的代码做成双击即装的 Windows 应用,宠物成为可拷走的自包含包(美术+人设+台词+该宠物记忆),活跃宠物 id 可配置,并补齐 §11.2 的 IPC payload 校验。

**Architecture:** 三块 —— (A) `electron-builder.yml` 产 NSIS 安装包,把 `pets/`/`skills/`/`resources/` 作 `extraResources` 分发;(B) 新增 `src/main/pets/petHome.ts` 在首启把内置宠物播种进 `userData/pets/<activePetId>/` 并把该宠物记忆收进同一目录(一次性迁移旧全局 memory);(C) 新增 `src/shared/ipcValidation.ts` 纯校验器,在 `shell` 各 IPC 入口拦截非法 payload。

**Tech Stack:** Electron 31(CJS,Node 20 → `fs.cpSync` 可用)· electron-vite · TypeScript(strict)· Vitest · electron-builder 24 · Python/Pillow(conda 虚拟环境,仅开发期生成图标)。

## Global Constraints

- **不要**给 `package.json` 加 `"type": "module"`(会让 Electron 主进程崩)。
- 跨进程值走 `@shared/*`;IPC 通道名只用 `IPC` 常量,不硬编码字符串。
- TDD:纯逻辑先写失败测试(Vitest);GUI/Electron 接线靠真机 `pnpm dev`/`preview`/安装包验证。
- 提交粒度小、勤提交;conventional-commit,**提交信息用中文**。
- 自动化检查过 ≠ 能跑:动 shell/打包后必须真机验证。
- `docs/*`、`pets/*`(luluka/youka/shiraishi-mio)被 `.gitignore` 有意忽略,仅在磁盘;`electron-builder` 从磁盘读,不受 git 影响。
- API key 经 `safeStorage` 机器绑定,**不可移植**,始终留在 `userData` 根,不进宠物包。
- 现有 `appRoot = app.isPackaged ? process.resourcesPath : repoRoot`、`petsDir(appRoot)=appRoot/pets` 逻辑不改。
- 目标 schema:`SETTINGS_SCHEMA_VERSION` 由 3 升到 **4**,新增字段 `activePetId`(默认 `"luluka"`)。

---

## Task 1: activePetId 设置项(schemaVersion 3→4)

**Files:**
- Modify: `src/shared/llm.ts`(`AppSettings` 加 `activePetId`;`DEFAULT_SETTINGS` 加默认;`SETTINGS_SCHEMA_VERSION` = 4)
- Modify: `src/main/config/settings.ts`(`normalize` 归一化 `activePetId` + 路径安全 slug 校验;导出为 `normalizeSettings` 供后续复用)
- Test: `src/main/config/settings.test.ts`(新增用例)

**Interfaces:**
- Produces:
  - `AppSettings` 新增只读字段 `activePetId: string`
  - `export function normalizeSettings(raw: unknown): AppSettings`(把原 `normalize` 重命名并导出;`loadSettings` 内部改调用它)

- [ ] **Step 1: 写失败测试**

在 `src/main/config/settings.test.ts` 追加(文件顶部若无这些 import 则补 `import { writeFileSync, mkdtempSync } from 'node:fs'`、`import { join } from 'node:path'`、`import { tmpdir } from 'node:os'`):

```ts
function tmpSettingsFile(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'petcfg-'))
  const f = join(dir, 'settings.json')
  writeFileSync(f, JSON.stringify(obj), 'utf-8')
  return f
}

describe('activePetId', () => {
  it('v3 文件缺 activePetId → 补默认 luluka', () => {
    const f = tmpSettingsFile({ schemaVersion: 3, provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('保留合法 activePetId', () => {
    const f = tmpSettingsFile({ activePetId: 'youka', provider: { kind: 'anthropic', model: 'x' } })
    expect(loadSettings(f).activePetId).toBe('youka')
  })
  it('非字符串 activePetId → 回退默认', () => {
    const f = tmpSettingsFile({ activePetId: 123 })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('含路径分隔/穿越的 activePetId → 回退默认(防路径穿越)', () => {
    const f = tmpSettingsFile({ activePetId: '../../evil' })
    expect(loadSettings(f).activePetId).toBe('luluka')
  })
  it('归一化后 schemaVersion 升为 4', () => {
    const f = tmpSettingsFile({ schemaVersion: 3 })
    expect(loadSettings(f).schemaVersion).toBe(4)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: FAIL(`activePetId` 未定义 / schemaVersion 仍为 3)

- [ ] **Step 3: 改 `src/shared/llm.ts`**

```ts
export const SETTINGS_SCHEMA_VERSION = 4

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null }
}
```

- [ ] **Step 4: 改 `src/main/config/settings.ts`**

把 `function normalize` 改名并导出为 `normalizeSettings`,在返回对象里加 `activePetId`,并让 `loadSettings` 调用它:

```ts
/** 合法宠物 id:仅字母数字下划线连字符,拒绝路径分隔/穿越(activePetId 会拼进文件路径)。 */
function normalizePetId(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) ? v : DEFAULT_SETTINGS.activePetId
}

export function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const p = (r.provider ?? {}) as Record<string, unknown>
  const kind = KINDS.includes(p.kind as ProviderKind) ? (p.kind as ProviderKind) : DEFAULT_SETTINGS.provider.kind
  const model = typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_SETTINGS.provider.model
  const baseURL = typeof p.baseURL === 'string' && p.baseURL.length > 0 ? p.baseURL : undefined
  const s = (r.search ?? {}) as Record<string, unknown>
  const backend = BACKENDS.includes(s.backend as SearchBackendKind)
    ? (s.backend as SearchBackendKind)
    : DEFAULT_SETTINGS.search.backend
  const m = (r.memory ?? {}) as Record<string, unknown>
  const e = (m.embedding ?? null) as Record<string, unknown> | null
  const embedding =
    e && typeof e.baseURL === 'string' && e.baseURL.length > 0 &&
    typeof e.model === 'string' && e.model.length > 0
      ? { baseURL: e.baseURL, model: e.model }
      : null
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activePetId: normalizePetId(r.activePetId),
    provider: { kind, model, baseURL },
    search: { backend },
    memory: { embedding }
  }
}

export function loadSettings(file: string): AppSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
```

(若文件里别处引用了旧名 `normalize`,一并改为 `normalizeSettings`。)

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/shared/llm.ts src/main/config/settings.ts src/main/config/settings.test.ts
git commit -m "feat(settings): 新增 activePetId 设置项(schemaVersion 4)+ 路径安全校验"
```

---

## Task 2: petHome 模块(首启播种 + 记忆迁移)

**Files:**
- Create: `src/main/pets/petHome.ts`
- Test: `src/main/pets/petHome.test.ts`

**Interfaces:**
- Consumes: `petsDir(appRoot)`(来自 `src/main/petLoader.ts`,返回 `appRoot/pets`)
- Produces:
  ```ts
  export interface PetHomeResult { petHome: string; memoryDir: string }
  export interface PetHomeOptions {
    userDataDir: string      // app.getPath('userData')
    bundledPetsDir: string   // petsDir(appRoot)
    activePetId: string
    legacyMemoryDir?: string // 旧全局 userData/memory,一次性迁移
  }
  export function ensurePetHome(opts: PetHomeOptions): PetHomeResult
  ```

- [ ] **Step 1: 写失败测试**

`src/main/pets/petHome.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensurePetHome } from './petHome'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pethome-'))
}
function makeBundledPet(root: string, id: string): string {
  const dir = join(root, 'pets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id }), 'utf-8')
  writeFileSync(join(dir, 'persona.md'), '# Persona\n原始人设', 'utf-8')
  return join(root, 'pets')
}

describe('ensurePetHome', () => {
  it('petHome 不存在 → 从内置包整包复制', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const { petHome, memoryDir } = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka' })
    expect(existsSync(join(petHome, 'pet.json'))).toBe(true)
    expect(existsSync(join(petHome, 'persona.md'))).toBe(true)
    expect(memoryDir).toBe(join(petHome, 'memory'))
  })

  it('petHome 已存在 → 不覆盖用户改动(幂等)', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const petHome = join(userDataDir, 'pets', 'luluka')
    mkdirSync(petHome, { recursive: true })
    writeFileSync(join(petHome, 'persona.md'), '# Persona\n用户改过的人设', 'utf-8')
    ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka' })
    expect(readFileSync(join(petHome, 'persona.md'), 'utf-8')).toContain('用户改过的人设')
  })

  it('旧全局 memory 存在且新位置无 → 迁移进宠物家目录', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '[]', 'utf-8')
    const { memoryDir } = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka', legacyMemoryDir })
    expect(existsSync(join(memoryDir, 'facts.json'))).toBe(true)
    expect(existsSync(legacyMemoryDir)).toBe(false)
  })

  it('新位置已有 memory → 不迁移旧全局', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const petHome = join(userDataDir, 'pets', 'luluka')
    mkdirSync(join(petHome, 'memory'), { recursive: true })
    writeFileSync(join(petHome, 'memory', 'facts.json'), '["new"]', 'utf-8')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '["old"]', 'utf-8')
    ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka', legacyMemoryDir })
    expect(readFileSync(join(petHome, 'memory', 'facts.json'), 'utf-8')).toBe('["new"]')
    expect(existsSync(legacyMemoryDir)).toBe(true)
  })

  it('内置包缺失该宠物 → 抛明确错误', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    mkdirSync(join(bundledRoot, 'pets'), { recursive: true })
    expect(() => ensurePetHome({ userDataDir, bundledPetsDir: join(bundledRoot, 'pets'), activePetId: 'ghost' }))
      .toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/pets/petHome.test.ts`
Expected: FAIL(`ensurePetHome` 模块不存在)

- [ ] **Step 3: 写实现 `src/main/pets/petHome.ts`**

```ts
import { existsSync, cpSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface PetHomeResult {
  /** 活跃宠物的可写家目录:userData/pets/<id>/(自包含、可拷走的宠物包) */
  petHome: string
  /** 该宠物的长期记忆目录:petHome/memory */
  memoryDir: string
}

export interface PetHomeOptions {
  userDataDir: string
  bundledPetsDir: string
  activePetId: string
  /** 旧全局 userData/memory;若给出且新位置尚无 memory,则一次性迁入宠物家目录 */
  legacyMemoryDir?: string
}

/**
 * 保证活跃宠物在 userData 下有一份可写的自包含包:
 *  - 首启:从内置只读包整包复制到 userData/pets/<id>/(用户可编辑 persona.md 等)。
 *  - 记忆随宠物:memory 收进 petHome/memory,整个目录可拷走迁移。
 *  - 迁移:MVP-05 旧的全局 userData/memory 一次性搬进当前宠物家目录,不丢历史记忆。
 */
export function ensurePetHome(opts: PetHomeOptions): PetHomeResult {
  const petsRoot = join(opts.userDataDir, 'pets')
  const petHome = join(petsRoot, opts.activePetId)
  const memoryDir = join(petHome, 'memory')

  if (!existsSync(petHome)) {
    const src = join(opts.bundledPetsDir, opts.activePetId)
    if (!existsSync(src)) {
      throw new Error(`Bundled pet package not found: ${src} (activePetId="${opts.activePetId}")`)
    }
    mkdirSync(petsRoot, { recursive: true })
    cpSync(src, petHome, { recursive: true })
  }

  if (opts.legacyMemoryDir && existsSync(opts.legacyMemoryDir) && !existsSync(memoryDir)) {
    mkdirSync(petHome, { recursive: true })
    renameSync(opts.legacyMemoryDir, memoryDir)
  }

  return { petHome, memoryDir }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/main/pets/petHome.test.ts`
Expected: PASS(5 项全过)

- [ ] **Step 5: 提交**

```bash
git add src/main/pets/petHome.ts src/main/pets/petHome.test.ts
git commit -m "feat(pets): 新增 petHome 首启播种 + 记忆随宠物迁移"
```

---

## Task 3: ipcValidation 纯校验器(§11.2)

**Files:**
- Create: `src/shared/ipcValidation.ts`
- Test: `src/shared/ipcValidation.test.ts`

**Interfaces:**
- Consumes: `MoveDelta`、`ChatSendPayload`(`@shared/ipc`);`ProviderSettings`、`ProviderKind`(`@shared/llm`)
- Produces:
  ```ts
  export function validateMoveDelta(v: unknown): MoveDelta | null
  export function validateBool(v: unknown): boolean | null
  export function validateChatSend(v: unknown): ChatSendPayload | null
  export function validateKey(v: unknown): string | null
  export function validateProviderSettings(v: unknown): ProviderSettings | null
  export function validateTestConnectionArg(v: unknown): { provider: ProviderSettings; key: string } | null
  ```

- [ ] **Step 1: 写失败测试**

`src/shared/ipcValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateProviderSettings, validateTestConnectionArg
} from './ipcValidation'

describe('validateMoveDelta', () => {
  it('接受有限数 + 可选 clamp', () => {
    expect(validateMoveDelta({ dx: 3, dy: -4 })).toEqual({ dx: 3, dy: -4, clamp: undefined })
    expect(validateMoveDelta({ dx: 1, dy: 2, clamp: true })).toEqual({ dx: 1, dy: 2, clamp: true })
  })
  it('拒绝 NaN/Infinity/非对象/非布尔 clamp', () => {
    expect(validateMoveDelta({ dx: NaN, dy: 0 })).toBeNull()
    expect(validateMoveDelta({ dx: 0, dy: Infinity })).toBeNull()
    expect(validateMoveDelta({ dx: 1, dy: 2, clamp: 'yes' })).toBeNull()
    expect(validateMoveDelta(null)).toBeNull()
    expect(validateMoveDelta('x')).toBeNull()
  })
})

describe('validateBool', () => {
  it('严格布尔', () => {
    expect(validateBool(true)).toBe(true)
    expect(validateBool(false)).toBe(false)
    expect(validateBool(1)).toBeNull()
    expect(validateBool('true')).toBeNull()
  })
})

describe('validateChatSend', () => {
  it('接受 text 字符串', () => {
    expect(validateChatSend({ text: 'hi' })).toEqual({ text: 'hi' })
  })
  it('拒绝非字符串 / 超长 / 非数组 attachments', () => {
    expect(validateChatSend({ text: 123 })).toBeNull()
    expect(validateChatSend({ text: 'a'.repeat(8001) })).toBeNull()
    expect(validateChatSend({ text: 'ok', attachments: 'x' })).toBeNull()
    expect(validateChatSend(null)).toBeNull()
  })
})

describe('validateKey', () => {
  it('接受合规字符串,拒绝非字符串/超长', () => {
    expect(validateKey('sk-abc')).toBe('sk-abc')
    expect(validateKey('')).toBe('')
    expect(validateKey(123)).toBeNull()
    expect(validateKey('k'.repeat(4001))).toBeNull()
  })
})

describe('validateProviderSettings', () => {
  it('接受合法 provider', () => {
    expect(validateProviderSettings({ kind: 'anthropic', model: 'claude-haiku-4-5' }))
      .toEqual({ kind: 'anthropic', model: 'claude-haiku-4-5', baseURL: undefined })
  })
  it('拒绝错 kind / 空 model / 非字符串 baseURL', () => {
    expect(validateProviderSettings({ kind: 'bogus', model: 'x' })).toBeNull()
    expect(validateProviderSettings({ kind: 'anthropic', model: '' })).toBeNull()
    expect(validateProviderSettings({ kind: 'anthropic', model: 'x', baseURL: 9 })).toBeNull()
  })
})

describe('validateTestConnectionArg', () => {
  it('接受 provider + key', () => {
    expect(validateTestConnectionArg({ provider: { kind: 'anthropic', model: 'm' }, key: 'k' }))
      .toEqual({ provider: { kind: 'anthropic', model: 'm', baseURL: undefined }, key: 'k' })
  })
  it('provider 或 key 非法 → null', () => {
    expect(validateTestConnectionArg({ provider: { kind: 'x', model: 'm' }, key: 'k' })).toBeNull()
    expect(validateTestConnectionArg({ provider: { kind: 'anthropic', model: 'm' }, key: 5 })).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写实现 `src/shared/ipcValidation.ts`**

```ts
import type { MoveDelta, ChatSendPayload } from './ipc'
import type { ProviderSettings, ProviderKind } from './llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']
const MAX_TEXT = 8000
const MAX_KEY = 4000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function validateMoveDelta(v: unknown): MoveDelta | null {
  if (!isObject(v)) return null
  if (!Number.isFinite(v.dx) || !Number.isFinite(v.dy)) return null
  if (v.clamp !== undefined && typeof v.clamp !== 'boolean') return null
  return { dx: v.dx as number, dy: v.dy as number, clamp: v.clamp as boolean | undefined }
}

export function validateBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export function validateChatSend(v: unknown): ChatSendPayload | null {
  if (!isObject(v)) return null
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT) return null
  if (v.attachments !== undefined && !Array.isArray(v.attachments)) return null
  const payload: ChatSendPayload = { text: v.text }
  if (Array.isArray(v.attachments)) payload.attachments = v.attachments as ChatSendPayload['attachments']
  return payload
}

export function validateKey(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_KEY ? v : null
}

export function validateProviderSettings(v: unknown): ProviderSettings | null {
  if (!isObject(v)) return null
  if (!KINDS.includes(v.kind as ProviderKind)) return null
  if (typeof v.model !== 'string' || v.model.length === 0) return null
  if (v.baseURL !== undefined && typeof v.baseURL !== 'string') return null
  return { kind: v.kind as ProviderKind, model: v.model, baseURL: v.baseURL as string | undefined }
}

export function validateTestConnectionArg(v: unknown): { provider: ProviderSettings; key: string } | null {
  if (!isObject(v)) return null
  const provider = validateProviderSettings(v.provider)
  const key = validateKey(v.key)
  if (!provider || key === null) return null
  return { provider, key }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/shared/ipcValidation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipcValidation.ts src/shared/ipcValidation.test.ts
git commit -m "feat(shared): 新增 IPC payload 纯校验器(§11.2)"
```

---

## Task 4: shell 接线 — petHome + IPC 校验

**Files:**
- Modify: `src/main/shell/index.ts`(用 petHome 派生 petDir/memoryDir;各 IPC 入口先过校验;SET_SETTINGS 落盘前 normalizeSettings)

**Interfaces:**
- Consumes: `ensurePetHome`(Task 2)、`validate*`(Task 3)、`normalizeSettings`(Task 1)、`petsDir`(已有)

- [ ] **Step 1: 加 import**

在 `src/main/shell/index.ts` 顶部 import 区加入:

```ts
import { ensurePetHome } from '../pets/petHome'
import { normalizeSettings } from '../config/settings'
import {
  validateMoveDelta, validateBool, validateChatSend,
  validateKey, validateTestConnectionArg
} from '@shared/ipcValidation'
```

(`loadSettings`/`saveSettings` 已在原 import;`petsDir` 已在 `../petLoader` import。)

- [ ] **Step 2: 用 petHome 派生 petDir / memoryDir**

把原来的:
```ts
const petDir = join(petsDir(appRoot), 'luluka')
```
(约 `:40`)删除;把 settings/secrets/memory 区(约 `:59-63`)改为**先算 userData 与 settingsFile,读 activePetId,再 ensurePetHome**:

```ts
const userData = app.getPath('userData')
const settingsFile = join(userData, 'settings.json')
const { petHome, memoryDir } = ensurePetHome({
  userDataDir: userData,
  bundledPetsDir: petsDir(appRoot),
  activePetId: loadSettings(settingsFile).activePetId,
  legacyMemoryDir: join(userData, 'memory')
})
const petDir = petHome
const secrets = createSecretStore(join(userData, 'secrets.bin'), safeStorage)
const searchSecrets = createSecretStore(join(userData, 'secrets-tavily.bin'), safeStorage)
const embeddingSecrets = createSecretStore(join(userData, 'secrets-embedding.bin'), safeStorage)
```

(删除原 `const memoryDir = join(app.getPath('userData'), 'memory')`。注意 `petDir` 现在在窗口创建后才可用 —— 确保 `ensurePetHome` 调用在 `loadPet(petDir)` 之前;`createPetWindow` 不依赖 petDir,`GET_PET` handler 在 `startShell` 末尾注册,顺序安全。若原代码在 `:42` 前用到 petDir,把这段 petHome 计算整体上移到 `createPetWindow` 之前。)

- [ ] **Step 3: 各 IPC 入口加校验**

改写以下 handler(其余无 payload 的通道不动):

```ts
ipcMain.on(IPC.MOVE_WINDOW, (_e, raw) => {
  const delta = validateMoveDelta(raw)
  if (!delta) return
  const [x, y] = petWin.getPosition()
  const nx = Math.round(x + delta.dx)
  const ny = Math.round(y + delta.dy)
  if (delta.clamp) {
    const [width, height] = petWin.getSize()
    const { workArea } = screen.getDisplayMatching({ x, y, width, height })
    petWin.setPosition(
      Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width - width)),
      Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - height))
    )
  } else {
    petWin.setPosition(nx, ny)
  }
})
ipcMain.on(IPC.SET_IGNORE_MOUSE, (_e, raw) => {
  const ignore = validateBool(raw)
  if (ignore === null) return
  petWin.setIgnoreMouseEvents(ignore, { forward: true })
})
ipcMain.on(IPC.CHAT_SEND, (_e, raw) => {
  const payload = validateChatSend(raw)
  if (!payload) return
  chat.handleSend(payload)
})
ipcMain.handle(IPC.SET_SETTINGS, async (_e, raw) => { saveSettings(settingsFile, normalizeSettings(raw)) })
ipcMain.handle(IPC.SET_API_KEY, async (_e, raw): Promise<boolean> => {
  const key = validateKey(raw); return key === null ? false : secrets.setKey(key)
})
ipcMain.handle(IPC.SET_SEARCH_KEY, async (_e, raw): Promise<boolean> => {
  const key = validateKey(raw); return key === null ? false : searchSecrets.setKey(key)
})
ipcMain.handle(IPC.SET_EMBEDDING_KEY, async (_e, raw): Promise<boolean> => {
  const key = validateKey(raw); return key === null ? false : embeddingSecrets.setKey(key)
})
ipcMain.handle(IPC.TEST_CONNECTION, async (_e, raw): Promise<TestResult> => {
  const arg = validateTestConnectionArg(raw)
  if (!arg) return { ok: false, error: 'invalid request' }
  return testConnection(arg.provider, arg.key)
})
ipcMain.on(IPC.DIALOG_SET_SIZE, (_e, raw) => {
  const collapsed = validateBool(raw)
  if (collapsed === null) return
  dialog.setSize(collapsed)
})
```

(若 `MoveDelta`/`ChatSendPayload`/`AppSettings`/`ProviderSettings` 等类型 import 因不再直接使用而报 unused,删对应 import 名即可;保留仍被引用的。)

- [ ] **Step 4: 类型检查 + 全量单测**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 0 error;全部测试 PASS(含 Task 1-3 新增)。

- [ ] **Step 5: 真机跑 dev 验证接线**

Run: `pnpm dev`(若沙箱报 5173 拒连,改用 `pnpm build && pnpm preview`)
确认(肉眼):① 宠物 luluka 渲染、可拖拽、托盘退出;② 打开对话发一句能回(或未配 key 时弹设置窗);③ 关掉应用后检查 `%APPDATA%\pet-agent\pets\luluka\`(Windows userData)已生成,含 `pet.json`/`persona.md`,且聊过后 `pets\luluka\memory\` 出现 `transcript.json` 等;④ 若此前有旧 `%APPDATA%\pet-agent\memory\`,已被搬进 `pets\luluka\memory\`。

> 说明:Electron `userData` 在 Windows 为 `%APPDATA%\<productName 或 package name>`。开发期未打包时通常是 `%APPDATA%\pet-agent`。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/index.ts
git commit -m "feat(shell): 接入 petHome(记忆随宠物)+ 全 IPC 入口 payload 校验"
```

---

## Task 5: 应用图标(从 luluka idle 首帧生成 build/icon.ico)

**Files:**
- Create: `tools/hatch-desktop-pet/scripts/make_app_icon.py`
- Create: `build/icon.ico`(生成物,需入库)
- Modify: `.gitignore`(放行 `build/icon.ico`)

- [ ] **Step 1: 放行 build/icon.ico**

把 `.gitignore` 第 5 行 `build/` 改为两行:

```gitignore
build/*
!build/icon.ico
```

- [ ] **Step 2: 写图标生成脚本 `tools/hatch-desktop-pet/scripts/make_app_icon.py`**

```python
"""从活跃宠物 luluka 的 idle 首帧生成应用图标 build/icon.ico(开发期一次性)。"""
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PET = os.path.join(ROOT, "pets", "luluka")

meta = json.load(open(os.path.join(PET, "pet.json"), encoding="utf-8"))
sheet = Image.open(os.path.join(PET, meta["spritesheetPath"])).convert("RGBA")
cw = meta["sheet"]["cellWidth"]
ch = meta["sheet"]["cellHeight"]
idle_row = meta["animations"]["idle"]["row"]

frame = sheet.crop((0, idle_row * ch, cw, idle_row * ch + ch))
bbox = frame.getbbox()          # 裁到不透明包围盒,居中更好看
if bbox:
    frame = frame.crop(bbox)

side = max(frame.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(frame, ((side - frame.width) // 2, (side - frame.height) // 2))
canvas = canvas.resize((256, 256), Image.LANCZOS)

out = os.path.join(ROOT, "build", "icon.ico")
os.makedirs(os.path.dirname(out), exist_ok=True)
canvas.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
```

- [ ] **Step 3: 建 conda 环境、装 Pillow、运行脚本**

Run(PowerShell 或 Bash;conda 需在 PATH):

```bash
conda create -y -n peticon python=3.11
conda run -n peticon pip install pillow
conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon.py
```

Expected: 打印 `wrote .../build/icon.ico`。

- [ ] **Step 4: 校验产物是合法多尺寸 ico**

Run: `conda run -n peticon python -c "from PIL import Image; im=Image.open('build/icon.ico'); print(im.size, sorted(im.info.get('sizes', [])))"`
Expected: 打印尺寸信息且不报错(含 256,256)。

- [ ] **Step 5: 提交**

```bash
git add tools/hatch-desktop-pet/scripts/make_app_icon.py build/icon.ico .gitignore
git commit -m "feat(build): 从 luluka idle 首帧生成应用图标 icon.ico"
```

> 兜底:若该机器无法运行 conda/Pillow,先放一张任意 256×256 的占位 `build/icon.ico`(不阻塞 Task 6),并在提交信息注明占位、后补。

---

## Task 6: electron-builder 打包 + README + 真机安装验证

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`(新增 `dist` 脚本)
- Modify: `README.md`(安装 / SmartScreen / 可移植宠物包 / 记忆位置)
- Modify: `PROGRESS.md`(收尾状态)

**Interfaces:**
- Consumes: Task 5 的 `build/icon.ico`;打包后运行时依赖 Task 4 的 `appRoot` 资源解析

- [ ] **Step 1: 写 `electron-builder.yml`**

```yaml
appId: com.petagent.app
productName: Pet-Agent
directories:
  buildResources: build
  output: dist
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!docs/*'
  - '!tools/*'
  - '!.superpowers/*'
  - '!electron.vite.config.{js,ts,mjs,cjs}'
  - '!{tsconfig.json,tsconfig.node.json}'
  - '!{README.md,PROGRESS.md,CLAUDE.md,pnpm-lock.yaml}'
  - '!**/*.test.*'
extraResources:
  - from: pets
    to: pets
  - from: skills
    to: skills
  - from: resources
    to: resources
win:
  target: nsis
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
```

> 关键点:① `files` 用「排除法」保留 electron-builder 默认 `**/*` 与生产依赖自动裁剪(`@anthropic-ai/sdk`/`openai` 会被打进,dev 依赖被剔除);不要改成只列 `out/**` 的白名单(会漏 node_modules)。② `extraResources` 必须含 `resources`(托盘图标 `resources/tray.png` 运行时从 `process.resourcesPath/resources/tray.png` 读),否则打包版托盘图标丢失。③ `from: pets` 会把磁盘上全部宠物(luluka/youka/shiraishi-mio)一并打入,`activePetId` 可选任意一只。

- [ ] **Step 2: package.json 加 dist 脚本**

在 `scripts` 里加:

```json
"dist": "pnpm build && electron-builder --win"
```

- [ ] **Step 3: 打包**

Run: `pnpm dist`
Expected: 无错误;`dist/` 下产出 `Pet-Agent Setup 0.0.1.exe`(及 `dist/win-unpacked/`)。

> 若报缺 `author`/`description`:`package.json` 已有 `description`;electron-builder 可能要求 `author`,如报错则给 `package.json` 加 `"author": "niyaoye"` 后重跑(算入本步)。

- [ ] **Step 4: 真机安装 + 验收清单**

手动执行(打包版不能只靠自动化 —— 项目铁律):

1. 双击 `dist/Pet-Agent Setup 0.0.1.exe` → 走 NSIS 向导(可选安装目录)→ 装完启动。
2. **躯壳**:宠物 luluka 渲染、播 idle、可拖拽、**系统托盘图标存在**且右键可退出、任务栏不显图标、透明区点击穿透。
3. **对话/记忆**:首启若无 key 弹设置窗 → 填 Provider+key → 发一句能回;记忆落到 userData(安装版为 `%APPDATA%\Pet-Agent\pets\luluka\memory\`)。
4. **可移植宠物包**:编辑 `%APPDATA%\Pet-Agent\pets\luluka\persona.md` → 重启应用 → 人设变化生效;把整个 `pets\luluka\` 文件夹拷到别处 = 完整宠物包(含美术+persona+lines+memory)。
5. **宠物名称可改**:改 `pets\luluka\pet.json` 的 `displayName`,或改 `%APPDATA%\Pet-Agent\settings.json` 的 `activePetId` 为 `youka` → 重启 → 换成该宠物(首启会从内置包播种 youka)。
6. **卸载不丢数据**:从「应用和功能」卸载 → 确认 `%APPDATA%\Pet-Agent\`(settings/secrets/pets/记忆)仍在。

记录结果;如有问题回到对应 Task 修复。

- [ ] **Step 5: 更新 README 与 PROGRESS**

`README.md` 增补(安装章节):
- 从 `dist/Pet-Agent Setup <ver>.exe` 双击安装,免 Node/命令行;每用户安装、免管理员。
- **未签名说明**:首次运行 Windows SmartScreen 可能拦截 →「更多信息」→「仍要运行」。
- **可移植宠物包**:宠物的美术/人设(`persona.md`)/台词/记忆都在 `%APPDATA%\Pet-Agent\pets\<id>\`,整个文件夹可拷贝备份/迁移;`persona.md` 可直接编辑调教;换宠物改 `settings.json` 的 `activePetId` 后重启。
- **隐私**:API key 经 Windows 凭据存储(safeStorage)加密、机器绑定、不可随宠物包迁移;在线 embedding 会外发被向量化的记忆文本(可留空关闭)。

`PROGRESS.md`:把 MVP-06 标 ✅,更新「一句话现状」「路线图」「测试计数」,并把本轮遗留 Minor(若有,如设置窗未加 activePetId 输入框、未做代码签名/自动更新)记入第 7 节。

- [ ] **Step 6: 提交**

```bash
git add electron-builder.yml package.json README.md PROGRESS.md
git commit -m "feat(build): electron-builder NSIS 打包 + 可移植宠物包/安装说明(MVP-06)"
```

---

## 完成标准(Definition of Done)

- `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿(Task 1-4 新增测试并入)。
- `pnpm dist` 产出可安装的 `dist/*.exe`。
- 真机安装后:躯壳/对话/记忆/托盘正常;宠物包可编辑、可拷走迁移;activePetId 可切换宠物;卸载不丢 userData。
- §11.2 IPC payload 校验落地;§11 其余条目复核通过(CSP/密钥不落日志)。
- README/PROGRESS 更新;设计与计划文档在 `docs/superpowers/`(磁盘,gitignored,与既有兄弟文档一致)。
