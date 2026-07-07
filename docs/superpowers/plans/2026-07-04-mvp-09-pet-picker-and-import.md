# MVP-09 UI 选宠物 + 导入宠物包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在设置窗里从下拉列表选宠物(内置 + 已导入)、导入外部宠物包文件夹,切换沿用现有「重启后生效」路径。

**Architecture:** 新增纯逻辑模块 `src/main/pets/petCatalog.ts`(枚举 + 导入校验),经三个新 IPC(`LIST_PETS`/`IMPORT_PET`/`RELAUNCH_APP`)暴露给设置窗。切换核心(`ensurePetHome` + `index.ts` 启动加载)零改动——导入只是把校验过的文件夹落到 `userData/pets/<id>`,重启后走既有路径生效。

**Tech Stack:** Electron + TypeScript,electron-vite(CJS 输出),Vitest;无新依赖(仅 Node `fs`)。

## Global Constraints

- **包管理器是 pnpm**,不是 npm/yarn。
- **不得给 package.json 加 `"type": "module"`**(会让 CJS main 崩)。
- 跨进程值走 `src/shared` 与 `@shared/*` 别名;**IPC channel 字符串一律用 `IPC` 常量**,不硬编码。
- 新增 IPC 能力须**四文件 lockstep**:`src/shared/ipc.ts`(常量 + 类型)、`src/main/shell/index.ts`(handler)、`src/preload/index.ts`(暴露)、renderer 调用方。
- 纯逻辑走 TDD(先写失败的 Vitest);GUI/Electron 接线靠真机跑验证。
- **合法宠物 id 正则**:`/^[A-Za-z0-9_-]+$/`(与 `src/main/config/settings.ts` 的 `normalizePetId` 同源,防路径穿越)。
- 提交信息用中文、conventional-commit 风格(`feat(pets): ...`);小步频繁提交。
- 单测命令:`pnpm vitest run <path>`;全量:`pnpm test`;`pnpm typecheck`;真机:`pnpm build && pnpm preview`(dev server 有 5173 竞态)。
- 冲突时**绝不覆盖**已有宠物目录(护住用户改过的 persona 与 memory)。

---

## File Structure

- **Create** `src/main/pets/petCatalog.ts` — 纯逻辑 + 薄 fs I/O:`isValidPetId`、`listPets`、`importPetFolder`。
- **Create** `src/main/pets/petCatalog.test.ts` — 上述的 Vitest。
- **Modify** `src/shared/ipc.ts` — 新增 3 个 IPC 常量、`PetSummary`/`ImportResult` 类型、`SettingsApi` 3 方法。
- **Modify** `src/main/shell/index.ts` — 注册 3 个 handler,委托 petCatalog。
- **Modify** `src/preload/index.ts` — `settingsApi` 暴露 3 方法。
- **Modify** `src/renderer/settings.html` — 新增「宠物」栏 DOM。
- **Modify** `src/renderer/settings.ts` — 下拉填充、导入按钮、保存并入 activePetId、重启按钮。
- **Modify** `PROGRESS.md` — 记 MVP-09 完成。

---

## Task 1: petCatalog 枚举(isValidPetId + listPets)

**Files:**
- Create: `src/main/pets/petCatalog.ts`
- Test: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Consumes: `parsePetManifest` from `@shared/petPackage`(校验并返回 `PetManifest`,含 `id`/`displayName`/`description`)。
- Produces:
  - `export interface PetSummary { id: string; displayName: string; description: string }`
  - `export function isValidPetId(v: unknown): boolean`
  - `export function listPets(dirs: { bundledPetsDir: string; userPetsDir: string }): PetSummary[]`

- [ ] **Step 1: Write the failing test**

创建 `src/main/pets/petCatalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isValidPetId, listPets } from './petCatalog'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'petcatalog-'))
}

/** 写一个最小合法宠物包目录(pet.json + 占位 spritesheet)。 */
function makePet(root: string, id: string, displayName = id): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    displayName,
    description: `${id} 的描述`,
    spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'spritesheet.webp'), 'fake-bytes', 'utf-8')
  return dir
}

describe('isValidPetId', () => {
  it('接受纯字母数字下划线连字符', () => {
    expect(isValidPetId('luluka')).toBe(true)
    expect(isValidPetId('shiraishi-mio')).toBe(true)
    expect(isValidPetId('pet_2')).toBe(true)
  })
  it('拒绝路径分隔/穿越/空/非字符串', () => {
    expect(isValidPetId('../evil')).toBe(false)
    expect(isValidPetId('a/b')).toBe(false)
    expect(isValidPetId('')).toBe(false)
    expect(isValidPetId(123)).toBe(false)
  })
})

describe('listPets', () => {
  it('合并两来源、按 displayName 排序', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'youka', '幽香')
    makePet(user, 'aaa', 'AAA')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['aaa', 'youka'])
    expect(out.find((p) => p.id === 'youka')?.displayName).toBe('幽香')
  })

  it('同 id 去重,userData 优先', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'luluka', '内置露露卡')
    makePet(user, 'luluka', '用户露露卡')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out).toHaveLength(1)
    expect(out[0].displayName).toBe('用户露露卡')
  })

  it('坏包(pet.json 非法/缺失)跳过,不炸整表', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'good', '好包')
    // 坏包:pet.json 缺 displayName
    const bad = join(bundled, 'bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'pet.json'), JSON.stringify({ id: 'bad' }), 'utf-8')
    // 无 pet.json 的目录
    mkdirSync(join(bundled, 'empty'), { recursive: true })
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['good'])
  })

  it('来源目录不存在 → 返回空数组不抛', () => {
    const out = listPets({ bundledPetsDir: join(tmpdir(), 'no-such-x'), userPetsDir: join(tmpdir(), 'no-such-y') })
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: FAIL —「Cannot find module './petCatalog'」或 `isValidPetId is not a function`。

- [ ] **Step 3: Write minimal implementation**

创建 `src/main/pets/petCatalog.ts`:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePetManifest } from '@shared/petPackage'

export interface PetSummary { id: string; displayName: string; description: string }

/** 合法宠物 id:仅字母数字下划线连字符,拒绝路径分隔/穿越。与 config/settings.ts 的正则同源。 */
export function isValidPetId(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
}

/** 读单个宠物目录的 summary;坏包(缺 pet.json / 校验失败)返回 null。 */
function readSummary(petDir: string): PetSummary | null {
  try {
    const manifest = parsePetManifest(JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf-8')))
    return { id: manifest.id, displayName: manifest.displayName, description: manifest.description }
  } catch (e) {
    console.warn('[petCatalog] 跳过坏宠物包', petDir, e)
    return null
  }
}

/** 扫一个 pets 根目录下的所有子目录,产出合法宠物 summary(坏包跳过)。 */
function scanDir(petsRoot: string): PetSummary[] {
  if (!existsSync(petsRoot)) return []
  const out: PetSummary[] = []
  for (const name of readdirSync(petsRoot)) {
    const petDir = join(petsRoot, name)
    if (!statSync(petDir).isDirectory()) continue
    const s = readSummary(petDir)
    if (s) out.push(s)
  }
  return out
}

/**
 * 枚举全部可用宠物:合并内置只读包与 userData 包,按 id 去重(userData 优先,
 * 因为内置包首启会被播种到 userData,同 id 视为同一只),按 displayName 排序。
 */
export function listPets(dirs: { bundledPetsDir: string; userPetsDir: string }): PetSummary[] {
  const byId = new Map<string, PetSummary>()
  for (const s of scanDir(dirs.bundledPetsDir)) byId.set(s.id, s)
  for (const s of scanDir(dirs.userPetsDir)) byId.set(s.id, s) // userData 覆盖内置
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: PASS(全部 isValidPetId + listPets 用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(pets): petCatalog 枚举可用宠物(合并去重+坏包跳过)"
```

---

## Task 2: petCatalog 导入(importPetFolder)

**Files:**
- Modify: `src/main/pets/petCatalog.ts`
- Test: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isValidPetId`、`PetSummary`、`parsePetManifest`。
- Produces:
  - `export type ImportReason = 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists'`
  - `export type ImportResult = { ok: true; pet: PetSummary } | { ok: false; reason: ImportReason; message: string }`
  - `export function importPetFolder(srcDir: string, dirs: { bundledPetsDir: string; userPetsDir: string }): ImportResult`

- [ ] **Step 1: Write the failing test**

在 `src/main/pets/petCatalog.test.ts` 末尾追加(复用文件顶部已有的 `scratch` / `makePet`,并新增 import):

```ts
import { importPetFolder } from './petCatalog'
import { existsSync as fsExists } from 'node:fs'

describe('importPetFolder', () => {
  it('合法包 → 复制到 userPetsDir/<id> 并返回 summary', () => {
    const src = scratch()
    const user = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toEqual({ id: 'newpet', displayName: '新宠物', description: 'newpet 的描述' })
    expect(fsExists(join(user, 'newpet', 'pet.json'))).toBe(true)
    expect(fsExists(join(user, 'newpet', 'spritesheet.webp'))).toBe(true)
  })

  it('缺 pet.json → no-manifest,不复制', () => {
    const src = scratch()
    const user = scratch()
    mkdirSync(join(src, 'x'), { recursive: true })
    const r = importPetFolder(join(src, 'x'), { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'no-manifest' })
  })

  it('pet.json 字段不合法 → invalid-manifest', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id: 'x' }), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'invalid-manifest' })
  })

  it('spritesheet 缺失 → missing-spritesheet', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: 'x', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'missing-spritesheet' })
  })

  it('id 含路径穿越 → bad-id', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: '../evil', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    writeFileSync(join(dir, 'spritesheet.webp'), 'x', 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  it('id 与 userData 已有宠物冲突 → id-exists,不覆盖', () => {
    const src = scratch()
    const user = scratch()
    const petSrc = makePet(src, 'dup', '导入版')
    makePet(user, 'dup', '原有版') // userData 已存在
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
    // 原有目录未被覆盖
    const kept = JSON.parse(readFileSync(join(user, 'dup', 'pet.json'), 'utf-8'))
    expect(kept.displayName).toBe('原有版')
  })

  it('id 与内置宠物冲突 → id-exists', () => {
    const src = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'youka', '导入幽香')
    makePet(bundled, 'youka', '内置幽香')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
  })
})
```

> 注:测试顶部需补 `readFileSync` 到 node:fs 的 import(Task 1 里只 import 了 `mkdtempSync, mkdirSync, writeFileSync`)。改为:
> `import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: FAIL —「`importPetFolder` is not a function」。

- [ ] **Step 3: Write minimal implementation**

在 `src/main/pets/petCatalog.ts` 顶部 import 补 `cpSync`,并追加:

```ts
// 顶部 import 改为:
// import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

export type ImportReason = 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists'
export type ImportResult =
  | { ok: true; pet: PetSummary }
  | { ok: false; reason: ImportReason; message: string }

/**
 * 校验外部宠物文件夹并导入到 userData/pets/<id>。校验链任一失败即返回,不复制。
 * 冲突(id 已存在于内置或 userData)一律拒绝,绝不覆盖(护住 persona/memory)。
 */
export function importPetFolder(
  srcDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): ImportResult {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: 'no-manifest', message: '所选文件夹里没有 pet.json' }
  }
  let manifest
  try {
    manifest = parsePetManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `pet.json 不合法:${(e as Error).message}` }
  }
  if (!existsSync(join(srcDir, manifest.spritesheetPath))) {
    return { ok: false, reason: 'missing-spritesheet', message: `找不到精灵图:${manifest.spritesheetPath}` }
  }
  if (!isValidPetId(manifest.id)) {
    return { ok: false, reason: 'bad-id', message: `pet.json 的 id 非法:${manifest.id}(只允许字母数字下划线连字符)` }
  }
  if (existsSync(join(dirs.bundledPetsDir, manifest.id)) || existsSync(join(dirs.userPetsDir, manifest.id))) {
    return { ok: false, reason: 'id-exists', message: `id「${manifest.id}」已存在,请修改宠物包 pet.json 的 id 后重试` }
  }
  cpSync(srcDir, join(dirs.userPetsDir, manifest.id), { recursive: true })
  return { ok: true, pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: PASS(全部导入用例 + Task 1 用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(pets): importPetFolder 校验+复制外部宠物包(冲突拒绝不覆盖)"
```

---

## Task 3: IPC 契约 + preload 暴露

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `PetSummary`、`ImportResult`(从 `../main/pets/petCatalog` **不可**跨进程 import——类型改为在 `@shared/ipc` 里重新声明,见下)。
- Produces(供 Task 4/5):
  - IPC 常量 `LIST_PETS='pets:list'`、`IMPORT_PET='pets:import'`、`RELAUNCH_APP='app:relaunch'`
  - `SettingsApi` 追加 `listPets(): Promise<PetSummary[]>`、`importPet(): Promise<ImportResult>`、`relaunch(): void`

> **为什么类型在 shared 重声明**:`src/shared` 是跨进程契约,renderer/preload 不能 import `src/main/*`。petCatalog 的 `PetSummary`/`ImportResult` 结构原样搬进 `@shared/ipc`;petCatalog 改为从 `@shared/ipc` import 这两个类型(单一真源在 shared)。

- [ ] **Step 1: 在 `src/shared/ipc.ts` 的 `IPC` 常量对象里追加三个 channel**

在 `OVERLAY_CANCEL: 'overlay:cancel'` 后加(注意上一行补逗号):

```ts
  OVERLAY_CANCEL: 'overlay:cancel',
  LIST_PETS: 'pets:list',
  IMPORT_PET: 'pets:import',
  RELAUNCH_APP: 'app:relaunch'
```

- [ ] **Step 2: 在 `src/shared/ipc.ts` 增加类型并扩展 `SettingsApi`**

在 `SettingsSnapshot`/`TestResult` 附近加:

```ts
export interface PetSummary { id: string; displayName: string; description: string }
export type ImportReason = 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists'
export type ImportResult =
  | { ok: true; pet: PetSummary }
  | { ok: false; reason: ImportReason; message: string }
```

在 `SettingsApi` 接口内追加三方法:

```ts
export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
  listPets(): Promise<PetSummary[]>
  importPet(): Promise<ImportResult>
  relaunch(): void
}
```

- [ ] **Step 3: 让 petCatalog 复用 shared 类型(去重真源)**

编辑 `src/main/pets/petCatalog.ts`:删除本地的 `PetSummary`/`ImportReason`/`ImportResult` 声明,改为从 shared import。顶部改为:

```ts
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePetManifest } from '@shared/petPackage'
import type { PetSummary, ImportResult } from '@shared/ipc'
```

并删掉文件里原 `export interface PetSummary...`、`export type ImportReason...`、`export type ImportResult...` 三行(其余函数签名不变,仍 `export`)。测试文件 `petCatalog.test.ts` 不用改(它按结构断言,不 import 这些类型名)。

- [ ] **Step 4: 在 `src/preload/index.ts` 暴露三方法**

在 `settingsApi` 对象里 `testConnection` 后追加(补前一行逗号):

```ts
  testConnection: (provider: ProviderSettings, key: string) => ipcRenderer.invoke(IPC.TEST_CONNECTION, { provider, key }),
  listPets: () => ipcRenderer.invoke(IPC.LIST_PETS),
  importPet: () => ipcRenderer.invoke(IPC.IMPORT_PET),
  relaunch: (): void => ipcRenderer.send(IPC.RELAUNCH_APP)
```

- [ ] **Step 5: Typecheck + 单测回归**

Run: `pnpm typecheck && pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: typecheck 通过(0 error),单测仍全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/pets/petCatalog.ts
git commit -m "feat(pets): IPC 契约新增 listPets/importPet/relaunch + preload 暴露"
```

---

## Task 4: 主进程 handler 接线

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `listPets`/`importPetFolder`;Task 3 的 IPC 常量;已有 `petsDir(appRoot)`、`userData`、`electronDialog`、`app`。
- Produces: 三个已注册的 handler(无导出)。

- [ ] **Step 1: import petCatalog 函数**

在 `src/main/shell/index.ts` 顶部 import 区(`ensurePetHome` 那行附近)加:

```ts
import { listPets, importPetFolder } from '../pets/petCatalog'
```

并确保 `IPC` 已从 `@shared/ipc` import(已在)。

- [ ] **Step 2: 在设置相关 handler 区注册三个 handler**

在 `ipcMain.handle(IPC.TEST_CONNECTION, ...)` 之后、`ipcMain.on(IPC.DIALOG_SET_SIZE, ...)` 之前插入。这里 `userPetsDir` 用 `join(userData, 'pets')`,`bundledPetsDir` 用 `petsDir(appRoot)`(与启动时 `petHomeOpts` 同源):

```ts
  const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }
  ipcMain.handle(IPC.LIST_PETS, async () => listPets(petCatalogDirs))
  ipcMain.handle(IPC.IMPORT_PET, async () => {
    const r = await electronDialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return importPetFolder(r.filePaths[0], petCatalogDirs)
  })
  ipcMain.on(IPC.RELAUNCH_APP, () => { app.relaunch(); app.quit() })
```

> `IMPORT_PET` 取消时返回 `null`(preload 类型是 `Promise<ImportResult>`;渲染层把 `null` 当「用户取消,静默」处理——见 Task 5,调用处判 `if (!res) return`)。

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck`
Expected: 0 error。

- [ ] **Step 4: 确认 handler 不炸(全量测试回归)**

Run: `pnpm test`
Expected: 现有全部单测 + petCatalog 单测 PASS(无回归)。

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(pets): 主进程注册 listPets/importPet/relaunch handler"
```

---

## Task 5: 设置窗宠物栏 UI

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: `window.settingsApi.listPets()/importPet()/relaunch()`(Task 3);已有 `currentActivePetId`、`status`、`setSettings`、`$` helper。
- Produces: 无(纯 UI)。

- [ ] **Step 1: 在 `settings.html` 加宠物栏 DOM**

在 `<h1>宠物大脑设置</h1>` 之后、`<label>Provider 预设` 之前插入:

```html
      <label>当前宠物(重启后生效)
        <select id="petSelect"></select>
      </label>
      <div class="row">
        <button id="importPet" class="secondary">导入宠物包…</button>
        <button id="relaunch" class="secondary" style="display:none">立即重启</button>
      </div>
```

- [ ] **Step 2: 在 `settings.ts` 顶部取元素句柄**

在现有 `const autoCopyResult = ...` 之后加:

```ts
const petSelect = $<HTMLSelectElement>('petSelect')
const importPetBtn = $<HTMLButtonElement>('importPet')
const relaunchBtn = $<HTMLButtonElement>('relaunch')
let savedActivePetId = 'luluka' // 保存前的值,用于判断是否需要重启
```

- [ ] **Step 3: 加填充下拉的函数与导入/重启监听**

在 `settings.ts` 里(`preset.addEventListener` 那组监听附近)加:

```ts
async function refreshPets(selectId: string): Promise<void> {
  const pets = await window.settingsApi.listPets()
  petSelect.innerHTML = ''
  for (const p of pets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.displayName
    petSelect.appendChild(opt)
  }
  // 选中项:优先目标 id;若不在列表(如坏包)则回落列表首项
  petSelect.value = selectId
  if (petSelect.value !== selectId && pets.length > 0) petSelect.value = pets[0].id
}

importPetBtn.addEventListener('click', async () => {
  const res = await window.settingsApi.importPet()
  if (!res) return // 用户取消,静默
  if (res.ok) {
    await refreshPets(res.pet.id)
    status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
  } else {
    status.textContent = `✗ ${res.message}`
  }
})

relaunchBtn.addEventListener('click', () => window.settingsApi.relaunch())
```

- [ ] **Step 4: 保存时并入 activePetId,并按变更显示重启按钮**

改 `setSettings` 调用:把 `activePetId: currentActivePetId` 换成 `activePetId: petSelect.value`。当前该调用(`src/renderer/settings.ts` 保存按钮内)为:

```ts
    await window.settingsApi.setSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activePetId: currentActivePetId,
      provider,
      search: { backend: searchBackend.value as SearchBackendKind },
      memory: { embedding },
      textTools: { autoCopyResult: autoCopyResult.checked }
    })
    status.textContent = '✓ 已保存'
```

改为:

```ts
    await window.settingsApi.setSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activePetId: petSelect.value,
      provider,
      search: { backend: searchBackend.value as SearchBackendKind },
      memory: { embedding },
      textTools: { autoCopyResult: autoCopyResult.checked }
    })
    if (petSelect.value !== savedActivePetId) {
      savedActivePetId = petSelect.value
      relaunchBtn.style.display = ''
      status.textContent = '✓ 已保存 · 宠物切换将在重启后生效'
    } else {
      status.textContent = '✓ 已保存'
    }
```

> `currentActivePetId` 变量若在改动后不再被引用,一并删掉其声明与赋值以过 lint/typecheck;若仍被别处用则保留。

- [ ] **Step 5: 初始化时填充下拉**

在 `settings.ts` 底部的 `void (async () => { const snap = ... })()` 初始化块里,`currentActivePetId = snap.settings.activePetId` 一行处改为记录 saved 值并填充下拉:

```ts
  savedActivePetId = snap.settings.activePetId
  await refreshPets(snap.settings.activePetId)
```

(若删了 `currentActivePetId`,原 `currentActivePetId = snap.settings.activePetId` 整行替换为上面两行;否则在其后追加这两行。)

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 error,三 bundle 构建成功。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/settings.html src/renderer/settings.ts
git commit -m "feat(pets): 设置窗新增宠物下拉+导入+重启 UI"
```

---

## Task 6: 真机验收 + PROGRESS

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:** 无。

- [ ] **Step 1: 真机跑(自动化证明不了窗口渲染)**

Run: `pnpm build && pnpm preview`
逐项确认:
1. 打开设置窗 → 宠物下拉列出内置宠物(luluka/youka/shiraishi-mio),当前项预选。
2. 点「导入宠物包…」→ 选一个新 id 的合法宠物文件夹 → 该宠物出现在下拉、状态提示已导入。
3. 再次导入一个 id 与内置冲突的包 → 明确中文报错「id 已存在…」,且原目录未被覆盖。
4. 选另一只宠物 → 保存 → 出现「立即重启」→ 点击 → 应用重启后确认已换皮(精灵变了)。
5. 导入一个缺 pet.json / spritesheet 的文件夹 → 对应中文报错。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全 PASS。

- [ ] **Step 3: 更新 PROGRESS.md**

在 `PROGRESS.md` 顶部状态行与 MVP 列表补一条 MVP-09(UI 选宠物 + 导入宠物包,重启生效,零新依赖),标注真机验收结论。

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md
git commit -m "docs(pets): MVP-09 UI 选宠物+导入宠物包 进度与真机验收"
```

---

## Self-Review

**1. Spec coverage:**
- §1 目标(下拉选 + 导入 + 重启生效)→ Task 4/5/6。✅
- §4.1 petCatalog(listPets 去重/坏包跳过;importPetFolder 校验链 + 冲突拒绝)→ Task 1/2。✅
- §4.2 IPC 三常量 + 类型 + SettingsApi + handler + preload → Task 3/4。✅
- §4.3 设置窗宠物栏(下拉/导入/保存并入/重启按钮)→ Task 5。✅
- §5 数据流(重启后走既有 index.ts 路径)→ 不改切换核心,Task 4 注释说明。✅
- §6 安全(normalizePetId 同源正则、不覆盖、坏包容错)→ Task 1 `isValidPetId`、Task 2 冲突拒绝、Task 1 坏包跳过。✅
- §7 测试(单测项 + 真机 4 步)→ Task 1/2 单测、Task 6 真机。✅
- §8 YAGNI(无热切换/缩略图/zip/删除)→ 计划未含。✅

**2. Placeholder scan:** 无 TBD/TODO;每个 code step 给了完整代码;冲突/校验/UI 提示文案均具体。✅

**3. Type consistency:** `PetSummary { id, displayName, description }` 全程一致;`ImportResult` 判别式 `ok:true{pet} | ok:false{reason,message}` 在 petCatalog(Task 2)、shared(Task 3)、renderer(Task 5 `res.ok`/`res.message`/`res.pet`)一致;`listPets(dirs)`/`importPetFolder(srcDir, dirs)` 签名在定义(Task1/2)与调用(Task4)一致;IPC 常量名 `LIST_PETS/IMPORT_PET/RELAUNCH_APP` 全程一致。✅
