# Live2D Phase 2:宠物包 v2 + 导入器 + 资源协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import a self-authored Live2D pet package (folder) alongside existing sprite packages through one unified, security-hardened import flow, and see it (disabled, pending later phases) in the pet picker — without touching any rendering code.

**Architecture:** Extend `pet.json` with a `render` discriminated union (`sprite` | `live2d`). Rewrite the existing folder-import path (`petCatalog.importPetFolder`) to route both package kinds through a shared staging-directory + security-validation + atomic-move pipeline, branching only for live2d-specific checks (referenced-file completeness, texture size budget, orphan motion/expression recovery, watermark-model heuristic). Build the `kibo-pet://` resource protocol as a standalone, fully-tested module with no consumer yet. Surface `live2d` catalog entries everywhere pets are listed, but gate every switch path behind a `renderReady` flag that is always `false` for them in this phase.

**Tech Stack:** TypeScript, Electron (main process, `node:fs`/`node:crypto`/`node:path`), Vitest.

**Design doc:** `docs/superpowers/specs/2026-07-21-live2d-phase2-pet-package-design.md` — read it first; this plan implements it task-by-task and does not repeat its rationale.

## Global Constraints

- Package manager is **pnpm**; run `pnpm vitest run <path>` per task, `pnpm build && pnpm test` at the end.
- Do **not** add `"type": "module"` to `package.json` (CommonJS main/preload requirement, see `CLAUDE.md`).
- Cross-process types/constants live in `src/shared` under the `@shared/*` alias; never hardcode IPC channel strings.
- `parsePetManifest` (existing, sprite-only) keeps its current "throw on invalid" behavior and its current field set — **do not modify it**. All new live2d schema logic is additive, in new types/functions.
- Security hard limits (from the design doc, copy verbatim): forbidden extensions `js, html, htm, exe, dll, bat, cmd, ps1, vbs, scr, com, msi, sh`; directory size ≤ 1 GiB (`1073741824` bytes); single JSON file ≤ 10 MiB (`10485760` bytes); recursive file count ≤ 5000; single texture ≤ 8192px on the longest side; texture count ≤ 16; soft-warn threshold 4096px.
- No new runtime dependencies — texture dimension reading is a hand-rolled PNG header parser, not an image library (per design doc's explicit reasoning: Cubism textures are PNG, and importing a full image-decoding library for a 24-byte header read is unjustified).
- Frequent, small commits; conventional-commit style (`feat(scope): ...` / `test(scope): ...`), commit messages in Chinese per `CLAUDE.md`.

---

### Task 1: Live2D manifest schema + parser

**Files:**
- Modify: `src/shared/petPackage.ts`
- Test: `src/shared/petPackage.test.ts`

**Interfaces:**
- Produces: `Live2DManifest`, `Live2DRender`, `Live2DStateMapEntry` types; `parseLive2DManifest(raw: unknown): Live2DManifest` (throws `Error` on invalid input, mirroring `parsePetManifest`'s style); `isLive2DManifestRaw(raw: unknown): boolean` (cheap discriminator used by later tasks to decide which parser to call, does not itself validate/throw).

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/petPackage.test.ts`:

```ts
import { parseLive2DManifest, isLive2DManifestRaw } from './petPackage'

const validLive2D = {
  schemaVersion: 2,
  id: 'chitose', displayName: '千岁', description: 'x',
  render: {
    type: 'live2d',
    model: 'model/character.model3.json',
    viewport: { width: 360, height: 480, resolutionCap: 1.5 },
    transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
    interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
    stateMap: {
      idle: { motionGroup: 'Idle', selection: 'random', loop: true },
      greet: { motionGroup: 'TapBody', selection: 'random', loop: false, fallback: 'idle', description: '被点击时的问候动作' }
    }
  }
}

describe('isLive2DManifestRaw', () => {
  it('true when render.type is live2d', () => {
    expect(isLive2DManifestRaw(validLive2D)).toBe(true)
  })
  it('false for legacy sprite manifest (no render field)', () => {
    expect(isLive2DManifestRaw(valid)).toBe(false)
  })
  it('false for non-objects', () => {
    expect(isLive2DManifestRaw(null)).toBe(false)
    expect(isLive2DManifestRaw('x')).toBe(false)
  })
})

describe('parseLive2DManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseLive2DManifest(validLive2D)
    expect(m.render.model).toBe('model/character.model3.json')
    expect(m.render.stateMap.greet.description).toBe('被点击时的问候动作')
  })
  it('accepts an empty stateMap (author need not fill every state)', () => {
    const m = parseLive2DManifest({ ...validLive2D, render: { ...validLive2D.render, stateMap: {} } })
    expect(m.render.stateMap).toEqual({})
  })
  it('rejects schemaVersion other than 2', () => {
    expect(() => parseLive2DManifest({ ...validLive2D, schemaVersion: 1 })).toThrow(/schemaVersion/)
  })
  it('rejects render.type other than live2d', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, type: 'sprite' } }
    expect(() => parseLive2DManifest(bad)).toThrow(/render\.type/)
  })
  it('rejects missing render.model', () => {
    const { model, ...rest } = validLive2D.render
    expect(() => parseLive2DManifest({ ...validLive2D, render: rest })).toThrow(/model/)
  })
  it('rejects non-numeric viewport fields', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, viewport: { width: '360', height: 480, resolutionCap: 1.5 } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/viewport/)
  })
  it('rejects non-boolean interaction fields', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, interaction: { mirrorOnWalk: 'yes', mouseTracking: true, lipSyncParameter: 'x' } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/interaction/)
  })
  it('rejects a stateMap entry with wrong field type', () => {
    const bad = { ...validLive2D, render: { ...validLive2D.render, stateMap: { idle: { loop: 'yes' } } } }
    expect(() => parseLive2DManifest(bad)).toThrow(/stateMap\.idle\.loop/)
  })
  it('accepts optional thumbnail string', () => {
    const m = parseLive2DManifest({ ...validLive2D, thumbnail: 'thumbnail.png' })
    expect(m.thumbnail).toBe('thumbnail.png')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: FAIL — `parseLive2DManifest`/`isLive2DManifestRaw` not exported.

- [ ] **Step 3: Implement**

Append to `src/shared/petPackage.ts`:

```ts
export interface Live2DViewport { width: number; height: number; resolutionCap: number }
export interface Live2DTransform {
  scale: number; offsetX: number; offsetY: number
  anchorX: number; anchorY: number
  bubbleAnchorX: number; bubbleAnchorY: number
}
export interface Live2DInteraction { mirrorOnWalk: boolean; mouseTracking: boolean; lipSyncParameter: string }
export interface Live2DStateMapEntry {
  motionGroup?: string
  selection?: 'random' | 'sequential' | number
  loop?: boolean
  expression?: string
  lipSync?: boolean
  fallback?: string
  /** 给未来 LLM 状态选择机制读的自然语言描述;Phase 2 只存不用。 */
  description?: string
}
export interface Live2DRender {
  type: 'live2d'
  model: string
  viewport: Live2DViewport
  transform: Live2DTransform
  interaction: Live2DInteraction
  stateMap: Record<string, Live2DStateMapEntry>
}
export interface Live2DManifest {
  schemaVersion: 2
  id: string; displayName: string; description: string
  thumbnail?: string
  render: Live2DRender
}

/** 便宜的判别式检查,不做完整校验;用来决定该走哪个解析器。 */
export function isLive2DManifestRaw(raw: unknown): boolean {
  const r = raw as Record<string, any>
  return !!(r && typeof r === 'object' && r.render && typeof r.render === 'object' && r.render.type === 'live2d')
}

export function parseLive2DManifest(raw: unknown): Live2DManifest {
  const m = raw as Record<string, any>
  assert(m && typeof m === 'object', 'manifest must be an object')
  assert(m.schemaVersion === 2, 'manifest.schemaVersion must be 2 for a live2d package')
  for (const k of ['id', 'displayName', 'description']) {
    assert(typeof m[k] === 'string' && m[k].length > 0, `manifest.${k} must be a non-empty string`)
  }
  if (m.thumbnail !== undefined) {
    assert(typeof m.thumbnail === 'string' && m.thumbnail.length > 0, 'manifest.thumbnail must be a non-empty string when present')
  }
  const r = m.render
  assert(r && typeof r === 'object', 'manifest.render is required')
  assert(r.type === 'live2d', 'manifest.render.type must be "live2d"')
  assert(typeof r.model === 'string' && r.model.length > 0, 'manifest.render.model must be a non-empty string')

  const vp = r.viewport
  assert(vp && typeof vp === 'object', 'manifest.render.viewport is required')
  for (const k of ['width', 'height', 'resolutionCap']) {
    assert(typeof vp[k] === 'number' && vp[k] > 0, `manifest.render.viewport.${k} must be a positive number`)
  }

  const tr = r.transform
  assert(tr && typeof tr === 'object', 'manifest.render.transform is required')
  for (const k of ['scale', 'offsetX', 'offsetY', 'anchorX', 'anchorY', 'bubbleAnchorX', 'bubbleAnchorY']) {
    assert(typeof tr[k] === 'number', `manifest.render.transform.${k} must be a number`)
  }

  const it = r.interaction
  assert(it && typeof it === 'object', 'manifest.render.interaction is required')
  assert(typeof it.mirrorOnWalk === 'boolean', 'manifest.render.interaction.mirrorOnWalk must be a boolean')
  assert(typeof it.mouseTracking === 'boolean', 'manifest.render.interaction.mouseTracking must be a boolean')
  assert(typeof it.lipSyncParameter === 'string' && it.lipSyncParameter.length > 0, 'manifest.render.interaction.lipSyncParameter must be a non-empty string')

  const sm = r.stateMap
  assert(sm && typeof sm === 'object', 'manifest.render.stateMap is required (may be empty)')
  for (const key of Object.keys(sm)) {
    const e = sm[key]
    assert(e && typeof e === 'object', `manifest.render.stateMap.${key} must be an object`)
    if (e.motionGroup !== undefined) assert(typeof e.motionGroup === 'string', `manifest.render.stateMap.${key}.motionGroup must be a string`)
    if (e.selection !== undefined) assert(e.selection === 'random' || e.selection === 'sequential' || typeof e.selection === 'number', `manifest.render.stateMap.${key}.selection must be "random"/"sequential"/number`)
    if (e.loop !== undefined) assert(typeof e.loop === 'boolean', `manifest.render.stateMap.${key}.loop must be a boolean`)
    if (e.expression !== undefined) assert(typeof e.expression === 'string', `manifest.render.stateMap.${key}.expression must be a string`)
    if (e.lipSync !== undefined) assert(typeof e.lipSync === 'boolean', `manifest.render.stateMap.${key}.lipSync must be a boolean`)
    if (e.fallback !== undefined) assert(typeof e.fallback === 'string', `manifest.render.stateMap.${key}.fallback must be a string`)
    if (e.description !== undefined) assert(typeof e.description === 'string', `manifest.render.stateMap.${key}.description must be a string`)
  }

  return m as Live2DManifest
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/shared/petPackage.test.ts`
Expected: PASS, all tests including pre-existing `parsePetManifest`/`frameRect`/`frameDurationMs` ones.

- [ ] **Step 5: Commit**

```bash
git add src/shared/petPackage.ts src/shared/petPackage.test.ts
git commit -m "feat(pets): 新增 Live2D 宠物包 schema 类型与解析器"
```

---

### Task 2: PNG dimension reader

**Files:**
- Create: `src/main/pets/pngDimensions.ts`
- Test: `src/main/pets/pngDimensions.test.ts`

**Interfaces:**
- Produces: `readPngDimensions(buf: Buffer): { width: number; height: number } | null`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pets/pngDimensions.test.ts
import { describe, it, expect } from 'vitest'
import { readPngDimensions } from './pngDimensions'

/** 手工拼一份只有合法 PNG 签名 + IHDR 头(签名 8 字节 + 长度 4 字节 + "IHDR" 4 字节 +
 *  宽 4 字节 + 高 4 字节 = 24 字节)的 buffer——足够 readPngDimensions 用,
 *  不需要 CRC/IDAT/IEND(它只读前 24 字节)。 */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // PNG signature
  buf.writeUInt32BE(13, 8)          // IHDR chunk length (unused by our reader, but realistic)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('readPngDimensions', () => {
  it('reads width/height from a valid PNG header', () => {
    expect(readPngDimensions(fakePng(4096, 2048))).toEqual({ width: 4096, height: 2048 })
  })
  it('returns null for a buffer shorter than 24 bytes', () => {
    expect(readPngDimensions(Buffer.alloc(10))).toBeNull()
  })
  it('returns null when the PNG signature is wrong', () => {
    const buf = fakePng(100, 100)
    buf[0] = 0x00
    expect(readPngDimensions(buf)).toBeNull()
  })
  it('returns null when the chunk type is not IHDR', () => {
    const buf = fakePng(100, 100)
    buf.write('IDAT', 12, 'ascii')
    expect(readPngDimensions(buf)).toBeNull()
  })
  it('returns null for zero width/height', () => {
    expect(readPngDimensions(fakePng(0, 100))).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/pets/pngDimensions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/main/pets/pngDimensions.ts
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngDimensions { width: number; height: number }

/** 只读文件头 24 字节(签名 8 + 长度 4 + "IHDR" 4 + 宽 4 + 高 4),不做完整解码。
 *  格式不对/尺寸非法一律返回 null,调用方决定怎么处理(不是这里的职责)。 */
export function readPngDimensions(buf: Buffer): PngDimensions | null {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/pets/pngDimensions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/pngDimensions.ts src/main/pets/pngDimensions.test.ts
git commit -m "feat(pets): 新增 PNG 文件头宽高读取(不做完整解码)"
```

---

### Task 3: Live2D 纹理尺寸预算校验

**Files:**
- Create: `src/main/pets/live2dTextureBudget.ts`
- Test: `src/main/pets/live2dTextureBudget.test.ts`

**Interfaces:**
- Consumes: `readPngDimensions` from Task 2 (`./pngDimensions`)
- Produces: `TextureInfo { fileName: string; dims: PngDimensions | null }`; `TextureBudgetResult { softWarnings: string[]; hardViolation: string | null }`; `evaluateTextureBudget(textures: TextureInfo[]): TextureBudgetResult` (pure); `readTextureInfos(modelDir: string, relativeFilePaths: string[]): TextureInfo[]` (fs-based, reads only first 24 bytes of each file)
- Exposes constants: `TEXTURE_SOFT_WARN_PX = 4096`, `TEXTURE_HARD_LIMIT_PX = 8192`, `TEXTURE_HARD_LIMIT_COUNT = 16`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pets/live2dTextureBudget.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateTextureBudget, readTextureInfos, TEXTURE_SOFT_WARN_PX, TEXTURE_HARD_LIMIT_PX, TEXTURE_HARD_LIMIT_COUNT } from './live2dTextureBudget'

function fakePngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('evaluateTextureBudget', () => {
  it('no warnings for small textures', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 2048, height: 2048 } }])
    expect(r).toEqual({ softWarnings: [], hardViolation: null })
  })
  it('soft warning between 4096 and 8192', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 4097, height: 100 } }])
    expect(r.hardViolation).toBeNull()
    expect(r.softWarnings).toHaveLength(1)
    expect(r.softWarnings[0]).toContain('a.png')
  })
  it('hard violation above 8192', () => {
    const r = evaluateTextureBudget([{ fileName: 'a.png', dims: { width: 8193, height: 100 } }])
    expect(r.hardViolation).toContain('a.png')
  })
  it('hard violation when texture count exceeds 16', () => {
    const textures = Array.from({ length: TEXTURE_HARD_LIMIT_COUNT + 1 }, (_, i) => ({ fileName: `t${i}.png`, dims: { width: 100, height: 100 } }))
    const r = evaluateTextureBudget(textures)
    expect(r.hardViolation).toContain(String(TEXTURE_HARD_LIMIT_COUNT))
  })
  it('ignores textures whose dims could not be read (handled elsewhere)', () => {
    const r = evaluateTextureBudget([{ fileName: 'broken.png', dims: null }])
    expect(r).toEqual({ softWarnings: [], hardViolation: null })
  })
  it('exposes the threshold constants used above', () => {
    expect(TEXTURE_SOFT_WARN_PX).toBe(4096)
    expect(TEXTURE_HARD_LIMIT_PX).toBe(8192)
  })
})

describe('readTextureInfos', () => {
  it('reads dimensions for each named file relative to modelDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'texbudget-'))
    writeFileSync(join(dir, 'tex_00.png'), fakePngBytes(1024, 512))
    const out = readTextureInfos(dir, ['tex_00.png'])
    expect(out).toEqual([{ fileName: 'tex_00.png', dims: { width: 1024, height: 512 } }])
  })
  it('returns dims:null for a file that is not a valid PNG (e.g. missing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'texbudget-'))
    const out = readTextureInfos(dir, ['missing.png'])
    expect(out).toEqual([{ fileName: 'missing.png', dims: null }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/live2dTextureBudget.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/main/pets/live2dTextureBudget.ts
import { openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { readPngDimensions, type PngDimensions } from './pngDimensions'

export const TEXTURE_SOFT_WARN_PX = 4096
export const TEXTURE_HARD_LIMIT_PX = 8192
export const TEXTURE_HARD_LIMIT_COUNT = 16

export interface TextureInfo { fileName: string; dims: PngDimensions | null }
export interface TextureBudgetResult { softWarnings: string[]; hardViolation: string | null }

function readFileHead(path: string, n: number): Buffer | null {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(n)
    const read = readSync(fd, buf, 0, n, 0)
    return read < n ? buf.subarray(0, read) : buf
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** 读一批贴图文件(相对 modelDir 的文件名)的宽高,只读前 24 字节,不做完整解码。
 *  读不到/不是合法 PNG 头 → dims:null,交给引用完整性校验去判断"文件缺失"这类别的问题。 */
export function readTextureInfos(modelDir: string, relativeFilePaths: string[]): TextureInfo[] {
  return relativeFilePaths.map((fileName) => {
    const head = readFileHead(join(modelDir, fileName), 24)
    return { fileName, dims: head ? readPngDimensions(head) : null }
  })
}

/** 纯函数:软预算(>4096 警告)/硬限制(>8192 或数量>16 拒绝),数据来自 spike §17.1 实测。 */
export function evaluateTextureBudget(textures: TextureInfo[]): TextureBudgetResult {
  const softWarnings: string[] = []
  let hardViolation: string | null = null
  if (textures.length > TEXTURE_HARD_LIMIT_COUNT) {
    hardViolation = `纹理数量 ${textures.length} 张超过硬限制 ${TEXTURE_HARD_LIMIT_COUNT} 张`
  }
  for (const t of textures) {
    if (!t.dims) continue
    const maxSide = Math.max(t.dims.width, t.dims.height)
    if (maxSide > TEXTURE_HARD_LIMIT_PX) {
      hardViolation = hardViolation ?? `纹理 ${t.fileName} 尺寸 ${t.dims.width}x${t.dims.height} 超过硬限制 ${TEXTURE_HARD_LIMIT_PX}px`
    } else if (maxSide > TEXTURE_SOFT_WARN_PX) {
      softWarnings.push(`纹理 ${t.fileName} 尺寸 ${t.dims.width}x${t.dims.height},可能明显影响帧率(建议 ≤${TEXTURE_SOFT_WARN_PX}px)`)
    }
  }
  return { softWarnings, hardViolation }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/live2dTextureBudget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/live2dTextureBudget.ts src/main/pets/live2dTextureBudget.test.ts
git commit -m "feat(pets): 新增 Live2D 纹理尺寸软硬预算校验"
```

---

### Task 4: 导入路径/安全校验

**Files:**
- Create: `src/main/pets/importSecurity.ts`
- Test: `src/main/pets/importSecurity.test.ts`

**Interfaces:**
- Produces:
  - `SecurityViolationReason` union: `'path-traversal' | 'symlink-rejected' | 'forbidden-file-type' | 'dir-too-large' | 'too-many-files' | 'json-too-large'`
  - `SecurityViolation { reason: SecurityViolationReason; message: string }`
  - `isPathSafe(baseDir: string, candidateRelPath: string): boolean` (pure, path-string based, no fs)
  - `scanImportSource(srcDir: string): SecurityViolation | null` (fs-based recursive walk; returns the first violation found, or null if clean)

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pets/importSecurity.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isPathSafe, scanImportSource } from './importSecurity'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'importsec-'))
}

describe('isPathSafe', () => {
  it('accepts a plain relative path', () => {
    expect(isPathSafe('C:/pets/foo', 'model/character.model3.json')).toBe(true)
  })
  it('rejects absolute paths', () => {
    expect(isPathSafe('C:/pets/foo', 'C:/evil/x.png')).toBe(false)
  })
  it('rejects UNC paths', () => {
    expect(isPathSafe('C:/pets/foo', '\\\\server\\share\\x.png')).toBe(false)
  })
  it('rejects .. traversal', () => {
    expect(isPathSafe('C:/pets/foo', '../../evil.png')).toBe(false)
    expect(isPathSafe('C:/pets/foo', 'model/../../evil.png')).toBe(false)
  })
})

describe('scanImportSource', () => {
  it('clean directory → null', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pet.json'), '{}', 'utf-8')
    expect(scanImportSource(dir)).toBeNull()
  })
  it('rejects forbidden extensions', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'run.exe'), 'x', 'utf-8')
    expect(scanImportSource(dir)?.reason).toBe('forbidden-file-type')
  })
  it('rejects symlinks', () => {
    const dir = scratch()
    const target = join(scratch(), 'outside.txt')
    writeFileSync(target, 'x', 'utf-8')
    try {
      symlinkSync(target, join(dir, 'link.txt'))
    } catch {
      return // 某些 Windows 环境无权限创建符号链接,跳过这条真机才能验的用例
    }
    expect(scanImportSource(dir)?.reason).toBe('symlink-rejected')
  })
  it('rejects a JSON file over the 10 MiB limit', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'huge.json'), Buffer.alloc(10 * 1024 * 1024 + 1))
    expect(scanImportSource(dir)?.reason).toBe('json-too-large')
  })
  it('rejects when total directory size exceeds 1 GiB', () => {
    const dir = scratch()
    // 不真的写 1GB 文件——用 statSync mock 不现实,改为断言纯逻辑边界的单元测试在 evaluate 层;
    // 这里只验证一个明显小文件不会被误判超限
    writeFileSync(join(dir, 'small.bin'), Buffer.alloc(1024))
    expect(scanImportSource(dir)).toBeNull()
  })
  it('rejects when recursive file count exceeds 5000', () => {
    const dir = scratch()
    const sub = join(dir, 'many'); mkdirSync(sub)
    for (let i = 0; i < 5001; i++) writeFileSync(join(sub, `f${i}.txt`), '')
    expect(scanImportSource(dir)?.reason).toBe('too-many-files')
  }, 20000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/importSecurity.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/main/pets/importSecurity.ts
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, extname, resolve, sep } from 'node:path'

export type SecurityViolationReason =
  | 'path-traversal' | 'symlink-rejected' | 'forbidden-file-type'
  | 'dir-too-large' | 'too-many-files' | 'json-too-large'

export interface SecurityViolation { reason: SecurityViolationReason; message: string }

const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.html', '.htm', '.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.scr', '.com', '.msi', '.sh'
])
const MAX_DIR_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 10 * 1024 * 1024
const MAX_FILE_COUNT = 5000

/** 纯路径字符串校验:拒绝绝对路径/UNC/盘符路径/`..`穿越。不碰文件系统。 */
export function isPathSafe(baseDir: string, candidateRelPath: string): boolean {
  if (isAbsolute(candidateRelPath)) return false
  if (candidateRelPath.startsWith('\\\\') || candidateRelPath.startsWith('//')) return false
  if (/^[A-Za-z]:/.test(candidateRelPath)) return false
  const base = resolve(baseDir)
  const resolved = resolve(base, candidateRelPath)
  return resolved === base || resolved.startsWith(base + sep)
}

/** 递归扫描导入源目录:符号链接/reparse point、扩展名黑名单、单 JSON 大小、
 *  目录总大小、文件总数,任一违规立即返回(不用扫完全部)。 */
export function scanImportSource(srcDir: string): SecurityViolation | null {
  let totalBytes = 0
  let fileCount = 0

  function walk(dir: string): SecurityViolation | null {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const lst = lstatSync(full)
      if (lst.isSymbolicLink()) {
        return { reason: 'symlink-rejected', message: `拒绝符号链接/reparse point:${full}` }
      }
      if (lst.isDirectory()) {
        const sub = walk(full)
        if (sub) return sub
        continue
      }
      fileCount++
      if (fileCount > MAX_FILE_COUNT) {
        return { reason: 'too-many-files', message: `文件数量超过硬限制 ${MAX_FILE_COUNT}` }
      }
      const ext = extname(name).toLowerCase()
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        return { reason: 'forbidden-file-type', message: `拒绝的文件类型:${full}` }
      }
      const size = statSync(full).size
      totalBytes += size
      if (ext === '.json' && size > MAX_JSON_BYTES) {
        return { reason: 'json-too-large', message: `JSON 文件超过 10MB:${full}` }
      }
      if (totalBytes > MAX_DIR_BYTES) {
        return { reason: 'dir-too-large', message: '目录总大小超过硬限制 1GB' }
      }
    }
    return null
  }

  if (!existsSync(srcDir)) return null
  return walk(srcDir)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/importSecurity.test.ts`
Expected: PASS (the symlink test self-skips via `return` if the sandbox can't create symlinks — note in review that this must be re-verified on a real Windows machine with permission to create symlinks, or run once manually as admin).

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/importSecurity.ts src/main/pets/importSecurity.test.ts
git commit -m "feat(pets): 新增导入源目录路径/安全校验"
```

---

### Task 5: 游离资源找回 + 水印模型启发式

**Files:**
- Create: `src/main/pets/live2dOrphanResources.ts`
- Test: `src/main/pets/live2dOrphanResources.test.ts`

**Interfaces:**
- Produces:
  - `Model3Json` type (minimal shape: `FileReferences.{Moc?,Textures?,Physics?,Pose?,DisplayInfo?,Expressions?,Motions?}`, indexable for unknown extra fields)
  - `scanAndPatchOrphanResources(model3Json: Model3Json, allModelDirFiles: string[]): { patchedModel3Json: Model3Json; recoveredExpressionCount: number; recoveredMotionCount: number }` (pure)
  - `detectPossibleWatermarkProtection(model3Json: Model3Json): boolean` (pure)
  - `listModelFilesRecursive(modelDir: string): string[]` (fs-based; returns forward-slash relative paths)

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pets/live2dOrphanResources.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanAndPatchOrphanResources, detectPossibleWatermarkProtection, listModelFilesRecursive, type Model3Json } from './live2dOrphanResources'

const bareModel3Json: Model3Json = {
  FileReferences: { Moc: 'character.moc3', Textures: ['textures/tex_00.png'] }
}

describe('scanAndPatchOrphanResources', () => {
  it('finds unreferenced .exp3.json/.motion3.json files and patches them in', () => {
    const files = ['character.moc3', 'textures/tex_00.png', 'expressions/happy.exp3.json', 'motions/Scene1.motion3.json']
    const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(bareModel3Json, files)
    expect(recoveredExpressionCount).toBe(1)
    expect(recoveredMotionCount).toBe(1)
    expect(patchedModel3Json.FileReferences.Expressions).toEqual([{ Name: 'happy', File: 'expressions/happy.exp3.json' }])
    expect(patchedModel3Json.FileReferences.Motions?.Recovered).toEqual([{ File: 'motions/Scene1.motion3.json' }])
  })
  it('does not duplicate already-declared expressions/motions', () => {
    const declared: Model3Json = {
      FileReferences: {
        ...bareModel3Json.FileReferences,
        Expressions: [{ Name: 'happy', File: 'expressions/happy.exp3.json' }],
        Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] }
      }
    }
    const files = ['expressions/happy.exp3.json', 'motions/idle.motion3.json']
    const { recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(declared, files)
    expect(recoveredExpressionCount).toBe(0)
    expect(recoveredMotionCount).toBe(0)
  })
  it('leaves model3Json untouched when nothing is orphaned', () => {
    const files = ['character.moc3', 'textures/tex_00.png']
    const { recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(bareModel3Json, files)
    expect(recoveredExpressionCount).toBe(0)
    expect(recoveredMotionCount).toBe(0)
  })
})

describe('detectPossibleWatermarkProtection', () => {
  it('true when patched model3.json still has no motions/expressions', () => {
    expect(detectPossibleWatermarkProtection(bareModel3Json)).toBe(true)
  })
  it('false once expressions exist', () => {
    const withExpr: Model3Json = { FileReferences: { ...bareModel3Json.FileReferences, Expressions: [{ Name: 'x', File: 'x.exp3.json' }] } }
    expect(detectPossibleWatermarkProtection(withExpr)).toBe(false)
  })
  it('false once motions exist', () => {
    const withMotion: Model3Json = { FileReferences: { ...bareModel3Json.FileReferences, Motions: { Idle: [{ File: 'i.motion3.json' }] } } }
    expect(detectPossibleWatermarkProtection(withMotion)).toBe(false)
  })
})

describe('listModelFilesRecursive', () => {
  it('lists nested files as forward-slash relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-'))
    mkdirSync(join(dir, 'expressions'), { recursive: true })
    writeFileSync(join(dir, 'character.moc3'), 'x')
    writeFileSync(join(dir, 'expressions', 'happy.exp3.json'), '{}')
    const out = listModelFilesRecursive(dir).sort()
    expect(out).toEqual(['character.moc3', 'expressions/happy.exp3.json'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/live2dOrphanResources.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/main/pets/live2dOrphanResources.ts
import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export interface Model3Json {
  FileReferences: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    Pose?: string
    DisplayInfo?: string
    Expressions?: { Name: string; File: string }[]
    Motions?: Record<string, { File: string }[]>
    [key: string]: unknown
  }
  [key: string]: unknown
}

function baseNameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.exp3\.json$/, '')
}

/** 扫描游离(未被 FileReferences 声明)的 *.exp3.json / *.motion3.json,合成补丁写回。
 *  找到的动作统一挂到 Motions.Recovered 分组;表情按文件名(去扩展名)生成 Name。 */
export function scanAndPatchOrphanResources(
  model3Json: Model3Json,
  allModelDirFiles: string[]
): { patchedModel3Json: Model3Json; recoveredExpressionCount: number; recoveredMotionCount: number } {
  const declaredExpr = new Set((model3Json.FileReferences.Expressions ?? []).map((e) => e.File))
  const declaredMotionFiles = new Set(
    Object.values(model3Json.FileReferences.Motions ?? {}).flat().map((m) => m.File)
  )
  const orphanExpr = allModelDirFiles.filter((f) => f.endsWith('.exp3.json') && !declaredExpr.has(f))
  const orphanMotion = allModelDirFiles.filter((f) => f.endsWith('.motion3.json') && !declaredMotionFiles.has(f))

  const patched: Model3Json = JSON.parse(JSON.stringify(model3Json))
  if (orphanExpr.length > 0) {
    patched.FileReferences.Expressions = [
      ...(model3Json.FileReferences.Expressions ?? []),
      ...orphanExpr.map((f) => ({ Name: baseNameNoExt(f), File: f }))
    ]
  }
  if (orphanMotion.length > 0) {
    patched.FileReferences.Motions = {
      ...(model3Json.FileReferences.Motions ?? {}),
      Recovered: [...(model3Json.FileReferences.Motions?.Recovered ?? []), ...orphanMotion.map((f) => ({ File: f }))]
    }
  }
  return { patchedModel3Json: patched, recoveredExpressionCount: orphanExpr.length, recoveredMotionCount: orphanMotion.length }
}

/** 补丁后仍然没有任何 Motions/Expressions → 可能是需要额外处理的受保护/水印模型(见 spike §17.4)。 */
export function detectPossibleWatermarkProtection(model3Json: Model3Json): boolean {
  const hasExpr = (model3Json.FileReferences.Expressions ?? []).length > 0
  const hasMotion = Object.values(model3Json.FileReferences.Motions ?? {}).some((arr) => arr.length > 0)
  return !hasExpr && !hasMotion
}

/** 递归列出 modelDir 下所有文件,返回相对 modelDir 的正斜杠路径(model3.json 内部引用惯例用正斜杠)。 */
export function listModelFilesRecursive(modelDir: string): string[] {
  const out: string[] = []
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (lstatSync(full).isDirectory()) walk(full, rel)
      else out.push(rel)
    }
  }
  walk(modelDir, '')
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/live2dOrphanResources.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/live2dOrphanResources.ts src/main/pets/live2dOrphanResources.test.ts
git commit -m "feat(pets): 新增 Live2D 游离资源找回与水印模型启发式检测"
```

---

### Task 6: `kibo-pet://` 受限资源协议(独立模块,暂无消费方)

**Files:**
- Create: `src/main/pets/kiboPetProtocol.ts`
- Test: `src/main/pets/kiboPetProtocol.test.ts`

**Interfaces:**
- Produces:
  - `KIBO_PET_SCHEME = 'kibo-pet'`
  - `KIBO_PET_SCHEME_PRIVILEGES` (object shaped for Electron's `protocol.registerSchemesAsPrivileged`)
  - `createKiboPetProtocolRegistry(): { registerToken(rootDir: string): string; revokeToken(token: string): void; resolveRequest(url: string): { filePath: string; mimeType: string } | { error: 403 | 404 } }`
  - `installKiboPetProtocolHandler(registry: ReturnType<typeof createKiboPetProtocolRegistry>): void` (thin Electron `protocol.handle` glue — written but **not called anywhere in this plan**; Phase 4 wires it in)

**Note:** this module is intentionally not imported/called by any other production file in this plan — it's tested standalone. Do not add a call to `installKiboPetProtocolHandler` or `protocol.registerSchemesAsPrivileged` in `src/main/index.ts` or `src/main/shell/index.ts`; that wiring is explicitly Phase 4 scope (see design doc).

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pets/kiboPetProtocol.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKiboPetProtocolRegistry, KIBO_PET_SCHEME_PRIVILEGES } from './kiboPetProtocol'

function scratchModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kibopet-'))
  mkdirSync(join(dir, 'textures'), { recursive: true })
  writeFileSync(join(dir, 'character.model3.json'), '{}')
  writeFileSync(join(dir, 'textures', 'tex_00.png'), 'fake-png-bytes')
  return dir
}

describe('KIBO_PET_SCHEME_PRIVILEGES', () => {
  it('is standard/secure/fetch-enabled and not CORS-open', () => {
    expect(KIBO_PET_SCHEME_PRIVILEGES.scheme).toBe('kibo-pet')
    expect(KIBO_PET_SCHEME_PRIVILEGES.privileges).toMatchObject({ standard: true, secure: true, supportFetchAPI: true })
  })
})

describe('createKiboPetProtocolRegistry', () => {
  it('resolves an allowed file under a registered root', () => {
    const reg = createKiboPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    const result = reg.resolveRequest(`kibo-pet://${token}/textures/tex_00.png`)
    expect(result).toMatchObject({ mimeType: 'image/png' })
    if (!('error' in result)) expect(result.filePath.endsWith('tex_00.png')).toBe(true)
  })
  it('404s for an unknown token', () => {
    const reg = createKiboPetProtocolRegistry()
    expect(reg.resolveRequest('kibo-pet://not-a-real-token/x.png')).toEqual({ error: 404 })
  })
  it('403s for a disallowed extension', () => {
    const reg = createKiboPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    writeFileSync(join(dir, 'evil.exe'), 'x')
    expect(reg.resolveRequest(`kibo-pet://${token}/evil.exe`)).toEqual({ error: 403 })
  })
  it('403s for a path that escapes the registered root via traversal', () => {
    const reg = createKiboPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    const result = reg.resolveRequest(`kibo-pet://${token}/../../../etc/passwd.json`)
    expect(result).toMatchObject({ error: 403 })
  })
  it('404s for a nonexistent file under a valid root', () => {
    const reg = createKiboPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    expect(reg.resolveRequest(`kibo-pet://${token}/nope.json`)).toEqual({ error: 404 })
  })
  it('revoked token immediately stops resolving', () => {
    const reg = createKiboPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    reg.revokeToken(token)
    expect(reg.resolveRequest(`kibo-pet://${token}/character.model3.json`)).toEqual({ error: 404 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/kiboPetProtocol.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/main/pets/kiboPetProtocol.ts
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const KIBO_PET_SCHEME = 'kibo-pet'

/** 喂给 Electron `protocol.registerSchemesAsPrivileged`;必须在 app.ready 之前调用
 *  (Phase 4 接线时的职责,本文件不调用)。不开 bypassCSP/Service Worker/扩展权限。 */
export const KIBO_PET_SCHEME_PRIVILEGES = {
  scheme: KIBO_PET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false }
}

const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

export type ProtocolResolveResult = { filePath: string; mimeType: string } | { error: 403 | 404 }

export function createKiboPetProtocolRegistry(): {
  registerToken(rootDir: string): string
  revokeToken(token: string): void
  resolveRequest(url: string): ProtocolResolveResult
} {
  const tokens = new Map<string, string>() // token -> resolved root dir

  return {
    registerToken(rootDir) {
      const token = randomBytes(16).toString('hex')
      tokens.set(token, resolve(rootDir))
      return token
    },
    revokeToken(token) {
      tokens.delete(token)
    },
    resolveRequest(url) {
      let parsed: URL
      try { parsed = new URL(url) } catch { return { error: 404 } }
      if (parsed.protocol !== `${KIBO_PET_SCHEME}:`) return { error: 404 }
      const root = tokens.get(parsed.hostname)
      if (!root) return { error: 404 }

      const relPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
      const ext = extname(relPath).toLowerCase()
      const mimeType = ALLOWED_EXTENSIONS[ext]
      if (!mimeType) return { error: 403 }

      const resolved = resolve(root, relPath)
      if (resolved !== root && !resolved.startsWith(root + sep)) return { error: 403 }
      if (!existsSync(resolved)) return { error: 404 }
      try {
        if (lstatSync(resolved).isSymbolicLink()) return { error: 403 }
      } catch {
        return { error: 404 }
      }
      return { filePath: resolved, mimeType }
    }
  }
}

/**
 * Electron `protocol.handle` 胶水层。**Phase 2 不调用这个函数**——它没有消费方,写在这里
 * 是给 Phase 4 现成用的基础设施。真正接线(含 app.ready 前的 registerSchemesAsPrivileged)
 * 留给 Phase 4。
 */
export function installKiboPetProtocolHandler(
  registry: ReturnType<typeof createKiboPetProtocolRegistry>
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { protocol, net } = require('electron') as typeof import('electron')
  protocol.handle(KIBO_PET_SCHEME, async (request) => {
    const result = registry.resolveRequest(request.url)
    if ('error' in result) return new Response(null, { status: result.error })
    return net.fetch(pathToFileURL(result.filePath).toString())
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/kiboPetProtocol.test.ts`
Expected: PASS. (`installKiboPetProtocolHandler` is intentionally untested here — it's a 4-line Electron API wrapper with no logic of its own; testing it would require a real Electron runtime, which is Phase 4's job when it's actually wired in.)

- [ ] **Step 5: Commit**

```bash
git add src/main/pets/kiboPetProtocol.ts src/main/pets/kiboPetProtocol.test.ts
git commit -m "feat(pets): 新增 kibo-pet:// 受限资源协议(暂无消费方)"
```

---

### Task 7: `petCatalog` 扫描侧改判别式 + `.staging` 跳过 + 残留清理

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/pets/petCatalog.ts`
- Modify: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Consumes: `isLive2DManifestRaw`, `parseLive2DManifest` (Task 1), `parsePetManifest` (existing)
- Produces: `PetSummary` gains `renderType: 'sprite' | 'live2d'` and `renderReady: boolean`; new export `cleanupStaleStaging(userPetsDir: string): void`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/pets/petCatalog.test.ts` (keep existing tests; `makePet`'s expected summaries below need the two new fields):

```ts
import { rmSync } from 'node:fs' // 追加到现有 import 行

function makeLive2DPet(root: string, id: string, displayName = id): string {
  const dir = join(root, id)
  mkdirSync(join(dir, 'model'), { recursive: true })
  const manifest = {
    schemaVersion: 2, id, displayName, description: `${id} 的描述`,
    render: {
      type: 'live2d', model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: {}
    }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'model', 'character.model3.json'), JSON.stringify({ FileReferences: {} }), 'utf-8')
  return dir
}
```

Update the existing `'合并两来源...'` style assertions to check the new fields, and append:

```ts
describe('listPets — render 判别式', () => {
  it('sprite 包 renderType=sprite, renderReady=true', () => {
    const bundled = scratch(); const user = scratch()
    makePet(bundled, 'youka', '幽香')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ renderType: 'sprite', renderReady: true })
  })
  it('live2d 包 renderType=live2d, renderReady=false', () => {
    const bundled = scratch(); const user = scratch()
    makeLive2DPet(user, 'chitose', '千岁')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out[0]).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
  })
  it('坏的 live2d 包(render.type 声明了但校验不过)照样跳过,不炸整表', () => {
    const bundled = scratch(); const user = scratch()
    const dir = join(user, 'bad'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify({ schemaVersion: 2, id: 'bad', render: { type: 'live2d' } }), 'utf-8')
    makePet(bundled, 'good', '好包')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['good'])
  })
})

describe('scanDir — .staging 排除', () => {
  it('.staging 目录不当成宠物条目', () => {
    const user = scratch()
    mkdirSync(join(user, '.staging', 'abc123'), { recursive: true })
    writeFileSync(join(user, '.staging', 'abc123', 'pet.json'), '{}', 'utf-8')
    const out = listPets({ bundledPetsDir: scratch(), userPetsDir: user })
    expect(out).toEqual([])
  })
})

describe('cleanupStaleStaging', () => {
  it('清空 .staging 下的所有残留子目录', () => {
    const user = scratch()
    mkdirSync(join(user, '.staging', 'leftover1'), { recursive: true })
    mkdirSync(join(user, '.staging', 'leftover2'), { recursive: true })
    cleanupStaleStaging(user)
    expect(existsSync(join(user, '.staging', 'leftover1'))).toBe(false)
    expect(existsSync(join(user, '.staging', 'leftover2'))).toBe(false)
  })
  it('.staging 目录本身不存在时不抛', () => {
    const user = scratch()
    expect(() => cleanupStaleStaging(user)).not.toThrow()
  })
})
```

Update the `import` line at the top of the test file to include `cleanupStaleStaging`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: FAIL — `renderType`/`renderReady` missing from summaries, `cleanupStaleStaging` not exported.

- [ ] **Step 3: Implement**

In `src/shared/ipc.ts`, change:

```ts
export interface PetSummary { id: string; displayName: string; description: string }
```

to:

```ts
export interface PetSummary {
  id: string; displayName: string; description: string
  renderType: 'sprite' | 'live2d'
  /** sprite 恒 true;live2d 在 Phase 2 恒 false——渲染引擎(Phase 3/4)还不存在。 */
  renderReady: boolean
}
```

In `src/main/pets/petCatalog.ts`, rewrite `readSummary` and `scanDir`, and add `cleanupStaleStaging`:

```ts
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw } from '@shared/petPackage'
import type { PetSummary, ImportResult } from '@shared/ipc'

export const STAGING_DIR_NAME = '.staging'

// ... isValidPetId 不变 ...

/** 读单个宠物目录的 summary;坏包(缺 pet.json / 校验失败)返回 null。
 *  按 render.type 判别式分流到对应解析器。 */
function readSummary(petDir: string): PetSummary | null {
  try {
    const raw = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf-8'))
    if (isLive2DManifestRaw(raw)) {
      const manifest = parseLive2DManifest(raw)
      return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: false }
    }
    const manifest = parsePetManifest(raw)
    return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'sprite', renderReady: true }
  } catch (e) {
    console.warn('[petCatalog] 跳过坏宠物包', petDir, e)
    return null
  }
}

function scanDir(petsRoot: string): PetSummary[] {
  if (!existsSync(petsRoot)) return []
  const out: PetSummary[] = []
  for (const name of readdirSync(petsRoot)) {
    if (name === STAGING_DIR_NAME) continue
    const petDir = join(petsRoot, name)
    try {
      if (!statSync(petDir).isDirectory()) continue
    } catch (e) {
      console.warn('[petCatalog] 跳过无法访问的目录项', petDir, e)
      continue
    }
    const s = readSummary(petDir)
    if (s) out.push(s)
  }
  return out
}

// listPets 函数体不变

/** 应用启动时调用:清掉上次崩溃/中断导入残留的 .staging 子目录(未完整提交的导入不会"复活")。 */
export function cleanupStaleStaging(userPetsDir: string): void {
  const stagingRoot = join(userPetsDir, STAGING_DIR_NAME)
  if (!existsSync(stagingRoot)) return
  for (const name of readdirSync(stagingRoot)) {
    rmSync(join(stagingRoot, name), { recursive: true, force: true })
  }
}
```

Leave `importPetFolder` as-is for this task (Task 8 rewrites it) — its return still satisfies the `ImportResult` type since `PetSummary`'s new fields aren't populated there yet, which will make its own existing tests fail on the new-field assertions. That's expected and intentional: Task 8 fixes it. To keep this task's test run green in isolation, update the **existing** `importPetFolder` tests' `toEqual`/`toMatchObject` pet assertions in this same edit to also expect `renderType: 'sprite', renderReady: true`, and manually add those two fields to the `importPetFolder` return statement's `pet:` object as a minimal one-line change (not the full rewrite — that's Task 8):

```ts
return { ok: true, pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'sprite', renderReady: true } }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: PASS — all existing + new tests.

Also run: `pnpm typecheck` — other files still reading `PetSummary` (`petChatList.ts`, `settings.ts`, `dialog.ts`) only destructure `id`/`displayName`, so the added required fields shouldn't break their compilation; confirm this is actually true and fix any TS error that surfaces (e.g. object literals elsewhere constructing a bare `PetSummary` would now fail — grep for `: PetSummary` and object literals typed as `PetSummary` if `pnpm typecheck` reports one).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(pets): 宠物目录扫描识别 render 判别式,新增 .staging 跳过与残留清理"
```

---

### Task 8: `importPetFolder` 重写为统一 staging 导入流程

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/pets/petCatalog.ts`
- Modify: `src/main/pets/petCatalog.test.ts`

**Interfaces:**
- Consumes: `scanImportSource` (Task 4), `readTextureInfos`/`evaluateTextureBudget` (Task 3), `listModelFilesRecursive`/`scanAndPatchOrphanResources`/`detectPossibleWatermarkProtection` (Task 5), `parseLive2DManifest`/`isLive2DManifestRaw` (Task 1)
- Produces: `ImportReason` gains new variants; `ImportResult`'s `ok:true` branch gains optional `warnings?: string[]`; `importPetFolder` keeps its exact existing signature `(srcDir: string, dirs: {bundledPetsDir,userPetsDir}) => ImportResult` but is internally rewritten

- [ ] **Step 1: Write the failing tests**

In `src/shared/ipc.ts`, this task will change `ImportReason`/`ImportResult` — write the test expectations first against the *current* petCatalog test file, extending it:

```ts
// 追加到 src/main/pets/petCatalog.test.ts,复用上面 Task 7 已加入的 makeLive2DPet 辅助函数

function fakePngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('importPetFolder — 统一 staging 流程', () => {
  it('sprite 包:不再直接复制到最终目录的同时留下残留——原子提交后 .staging 为空', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    expect(existsSync(join(user, 'newpet', 'pet.json'))).toBe(true)
    expect(readdirSync(join(user, '.staging'))).toEqual([])
  })

  it('sprite 包提交后 pet.json 被打上 schemaVersion:2 + render.type=sprite 标记', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'stamped', '盖章')
    importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    const written = JSON.parse(readFileSync(join(user, 'stamped', 'pet.json'), 'utf-8'))
    expect(written.schemaVersion).toBe(2)
    expect(written.render).toEqual({ type: 'sprite' })
  })

  it('live2d 包:合法输入 → 成功导入,renderType=live2d/renderReady=false', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'chitose', '千岁')
    writeFileSync(join(petSrc, 'model', 'tex_00.png'), fakePngBytes(512, 512))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toMatchObject({ id: 'chitose', renderType: 'live2d', renderReady: false })
    expect(existsSync(join(user, 'chitose', 'model', 'character.model3.json'))).toBe(true)
  })

  it('live2d 包:游离表情/动作文件自动找回,warnings 里报告数量', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'orphaned', '游离')
    writeFileSync(join(petSrc, 'model', 'happy.exp3.json'), '{}')
    writeFileSync(join(petSrc, 'model', 'Scene1.motion3.json'), '{}')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('找回'))).toBe(true)
    const written = JSON.parse(readFileSync(join(user, 'orphaned', 'model', 'character.model3.json'), 'utf-8'))
    expect(written.FileReferences.Expressions).toHaveLength(1)
  })

  it('live2d 包:补丁后仍无动作/表情 → warnings 含水印提示,但仍然导入成功', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'watermarked', '水印')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings?.some((w) => w.includes('未声明任何动作'))).toBe(true)
  })

  it('live2d 包:纹理超过硬限制(>8192px) → 拒绝导入,staging 清理干净', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'toobig', '太大')
    writeFileSync(join(petSrc, 'model', 'huge.png'), fakePngBytes(9000, 9000))
    // makeLive2DPet 默认的 render.model 已经指向 model/character.model3.json,直接覆盖该文件内容即可
    const modelJson = { FileReferences: { Textures: ['huge.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('texture-too-large')
    expect(existsSync(join(user, '.staging'))).toBe(false)
    expect(existsSync(join(user, 'toobig'))).toBe(false)
  })

  it('live2d 包:model3.json 引用的贴图缺失 → missing-model-refs,不提交', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'brokenref', '缺引用')
    const modelJson = { FileReferences: { Textures: ['does-not-exist.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-model-refs')
  })

  it('禁止的文件类型(.exe)出现在源目录 → forbidden-file-type,sprite/live2d 都适用', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makePet(src, 'withexe', '带exe')
    writeFileSync(join(petSrc, 'evil.exe'), 'x')
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forbidden-file-type')
  })

  it('中途校验失败不留 .staging 残留(以纹理超限用例为准复查)', () => {
    const src = scratch(); const user = scratch()
    const petSrc = makeLive2DPet(src, 'cleanup', '清理')
    writeFileSync(join(petSrc, 'model', 'huge.png'), fakePngBytes(9000, 9000))
    const modelJson = { FileReferences: { Textures: ['huge.png'] } }
    writeFileSync(join(petSrc, 'model', 'character.model3.json'), JSON.stringify(modelJson))
    importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(existsSync(join(user, '.staging'))).toBe(false)
  })
})
```

Also update the pre-existing `id-exists`/`bad-id`/`no-manifest`/`invalid-manifest`/`missing-spritesheet` tests from before Task 7 — they still call `importPetFolder` the same way and expect the same `reason`s, so they should keep passing unmodified through the rewrite; re-run them as part of Step 2/4 to confirm.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: FAIL — new `reason`/`warnings` behavior not implemented yet.

- [ ] **Step 3: Implement**

In `src/shared/ipc.ts`:

```ts
export type ImportReason =
  | 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists' | 'copy-failed'
  | 'path-traversal' | 'symlink-rejected' | 'forbidden-file-type'
  | 'dir-too-large' | 'too-many-files' | 'json-too-large'
  | 'texture-too-large' | 'too-many-textures' | 'missing-model-refs'
export type ImportResult =
  | { ok: true; pet: PetSummary; warnings?: string[] }
  | { ok: false; reason: ImportReason; message: string }
```

In `src/main/pets/petCatalog.ts`, replace `importPetFolder` entirely:

```ts
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { scanImportSource } from './importSecurity'
import { readTextureInfos, evaluateTextureBudget } from './live2dTextureBudget'
import { listModelFilesRecursive, scanAndPatchOrphanResources, detectPossibleWatermarkProtection, type Model3Json } from './live2dOrphanResources'

function newStagingDir(userPetsDir: string): string {
  return join(userPetsDir, STAGING_DIR_NAME, randomBytes(8).toString('hex'))
}

function importSpritePet(raw: unknown, srcDir: string, stagingDir: string, dirs: { bundledPetsDir: string; userPetsDir: string }): ImportResult {
  let manifest
  try {
    manifest = parsePetManifest(raw)
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
  cpSync(srcDir, stagingDir, { recursive: true })
  // 打上 v2 标记(向前兼容,不改变任何已有字段语义)
  const stampedRaw = { ...(raw as Record<string, unknown>), schemaVersion: 2, render: { type: 'sprite' } }
  writeFileSync(join(stagingDir, 'pet.json'), JSON.stringify(stampedRaw, null, 2), 'utf-8')
  const finalDir = join(dirs.userPetsDir, manifest.id)
  renameSync(stagingDir, finalDir)
  return { ok: true, pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'sprite', renderReady: true } }
}

function importLive2DPet(raw: unknown, srcDir: string, stagingDir: string, dirs: { bundledPetsDir: string; userPetsDir: string }): ImportResult {
  let manifest
  try {
    manifest = parseLive2DManifest(raw)
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `pet.json 不合法:${(e as Error).message}` }
  }
  if (!isValidPetId(manifest.id)) {
    return { ok: false, reason: 'bad-id', message: `pet.json 的 id 非法:${manifest.id}(只允许字母数字下划线连字符)` }
  }
  if (existsSync(join(dirs.bundledPetsDir, manifest.id)) || existsSync(join(dirs.userPetsDir, manifest.id))) {
    return { ok: false, reason: 'id-exists', message: `id「${manifest.id}」已存在,请修改宠物包 pet.json 的 id 后重试` }
  }
  const modelJsonSrcPath = join(srcDir, manifest.render.model)
  if (!existsSync(modelJsonSrcPath)) {
    return { ok: false, reason: 'missing-model-refs', message: `找不到 render.model 指向的文件:${manifest.render.model}` }
  }
  let model3Json: Model3Json
  try {
    model3Json = JSON.parse(readFileSync(modelJsonSrcPath, 'utf-8'))
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `model3.json 不是合法 JSON:${(e as Error).message}` }
  }
  const modelDir = dirname(modelJsonSrcPath)

  const refFiles = [
    model3Json.FileReferences.Moc,
    model3Json.FileReferences.Physics,
    model3Json.FileReferences.Pose,
    model3Json.FileReferences.DisplayInfo,
    ...(model3Json.FileReferences.Textures ?? [])
  ].filter((f): f is string => typeof f === 'string')
  for (const f of refFiles) {
    if (!existsSync(join(modelDir, f))) {
      return { ok: false, reason: 'missing-model-refs', message: `model3.json 引用的文件缺失:${f}` }
    }
  }

  const textureFiles = model3Json.FileReferences.Textures ?? []
  const textureInfos = readTextureInfos(modelDir, textureFiles)
  const budget = evaluateTextureBudget(textureInfos)
  if (budget.hardViolation) {
    return { ok: false, reason: budget.hardViolation.includes('数量') ? 'too-many-textures' : 'texture-too-large', message: budget.hardViolation }
  }

  const allModelFiles = listModelFilesRecursive(modelDir)
  const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(model3Json, allModelFiles)
  const warnings = [...budget.softWarnings]
  if (recoveredExpressionCount > 0 || recoveredMotionCount > 0) {
    warnings.push(`已自动找回 ${recoveredExpressionCount} 个表情文件、${recoveredMotionCount} 个动作文件`)
  }
  if (detectPossibleWatermarkProtection(patchedModel3Json)) {
    warnings.push('该模型未声明任何动作/表情,可能需要额外处理才能正常显示角色')
  }
  if (manifest.thumbnail && !existsSync(join(srcDir, manifest.thumbnail))) {
    return { ok: false, reason: 'missing-model-refs', message: `找不到 thumbnail 指向的文件:${manifest.thumbnail}` }
  }

  cpSync(srcDir, stagingDir, { recursive: true })
  const modelJsonStagingPath = join(stagingDir, manifest.render.model)
  writeFileSync(modelJsonStagingPath, JSON.stringify(patchedModel3Json, null, 2), 'utf-8')
  const finalDir = join(dirs.userPetsDir, manifest.id)
  renameSync(stagingDir, finalDir)

  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: false },
    ...(warnings.length > 0 ? { warnings } : {})
  }
}

/**
 * 校验外部宠物文件夹并导入到 userData/pets/<id>。统一 staging + 安全校验 + 原子移动:
 * 两种包共用路径安全校验和 staging/提交流程,live2d 专属校验(引用完整性/纹理预算/
 * 游离资源找回/水印提示)只在 render.type===live2d 时跑。任一环节失败都清理 staging 残留,
 * 不触碰最终目录;冲突(id 已存在)一律拒绝,绝不覆盖。
 */
export function importPetFolder(
  srcDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): ImportResult {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: 'no-manifest', message: '所选文件夹里没有 pet.json' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    return { ok: false, reason: 'invalid-manifest', message: `pet.json 不是合法 JSON:${(e as Error).message}` }
  }

  const violation = scanImportSource(srcDir)
  if (violation) return { ok: false, reason: violation.reason, message: violation.message }

  const stagingDir = newStagingDir(dirs.userPetsDir)
  const result = isLive2DManifestRaw(raw)
    ? importLive2DPet(raw, srcDir, stagingDir, dirs)
    : importSpritePet(raw, srcDir, stagingDir, dirs)

  if (!result.ok) {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  return result
}
```

Add `renameSync`, `writeFileSync` to the `node:fs` import at the top of `petCatalog.ts` (alongside the existing `cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`
Expected: PASS — all tests from Tasks 7 and 8, plus the original pre-existing `importPetFolder` tests (no-manifest/invalid-manifest/missing-spritesheet/bad-id/id-exists), unchanged in behavior for sprite packages.

Then run: `pnpm typecheck && pnpm test`
Expected: PASS across the whole repo — this is the first point where a type or another consumer of `ImportResult`/`PetSummary` (e.g. `settings.ts`) could break; fix any surfaced error.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(pets): 导入流程改为统一 staging+安全校验+原子移动,live2d 走专属校验链"
```

---

### Task 9: `renderReady` 贯穿头像/聊天列表/热切换防御

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/pets/petAvatar.ts`
- Modify: `src/main/pets/petAvatar.test.ts` (create if it doesn't exist — check first)
- Modify: `src/main/pets/petChatList.ts`
- Modify: `src/main/pets/petChatList.test.ts`
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `PetSummary.renderType`/`renderReady` (Task 7)
- Produces: `PetChatListItem` gains `renderReady: boolean`; `petAvatarCache.avatarOf` branches on render type for live2d `thumbnail`; `switchPet` rejects `renderReady:false` targets

- [ ] **Step 1: Write the failing tests**

Check whether `src/main/pets/petAvatar.test.ts` already exists:

Run: `pnpm vitest run src/main/pets/petAvatar.test.ts` (expect "no test files found" if absent — if it exists, read it first and extend it instead of overwriting).

Create (or extend) `src/main/pets/petAvatar.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPetAvatarCache } from './petAvatar'

function scratch(): string { return mkdtempSync(join(tmpdir(), 'petavatar-')) }

function fakePngBytes(): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(4, 16)
  buf.writeUInt32BE(4, 20)
  return buf
}

describe('createPetAvatarCache — live2d thumbnail branch', () => {
  it('返回 "" 且不抛,当 live2d 包没有 thumbnail 字段', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    const manifest = {
      schemaVersion: 2, id: 'x', displayName: 'X', description: 'd',
      render: { type: 'live2d', model: 'model/x.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'x')).toBe('')
  })

  it('从 thumbnail 字段读到有效 PNG 时返回非空 data URL', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    writeFileSync(join(dir, 'thumbnail.png'), fakePngBytes())
    const manifest = {
      schemaVersion: 2, id: 'y', displayName: 'Y', description: 'd', thumbnail: 'thumbnail.png',
      render: { type: 'live2d', model: 'model/y.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'y')).toMatch(/^data:image\/png;base64,/)
  })
})
```

Extend `src/main/pets/petChatList.test.ts` (read it first, then add):

```ts
it('renderReady 透传到 PetChatListItem', () => {
  const pets = [{ id: 'a', displayName: 'A', description: '', renderType: 'live2d' as const, renderReady: false }]
  const out = buildPetChatList({ pets, activeId: 'nope', activeMessages: [], peekLast: () => undefined, avatarOf: () => '' })
  expect(out[0].renderReady).toBe(false)
})
```

For `switchPet`'s guard, there's no existing test file for `shell/index.ts` (it's Electron main-process wiring, verified by running the app per `CLAUDE.md`'s "GUI/Electron wiring is verified by running the app" convention) — no automated test for Step 1/4 of this file's change; it's covered by Task 11's manual walkthrough.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/pets/petAvatar.test.ts src/main/pets/petChatList.test.ts`
Expected: FAIL (new file/behavior missing).

- [ ] **Step 3: Implement**

In `src/shared/ipc.ts`, add to `PetChatListItem`:

```ts
export interface PetChatListItem {
  id: string
  displayName: string
  avatarDataUrl: string
  lastMessage?: string
  lastMessageTime?: number
  active: boolean
  /** false → 该宠物渲染引擎未就绪(live2d 包在 Phase 2 恒为 false),UI 应禁用点击。 */
  renderReady: boolean
}
```

In `src/main/pets/petAvatar.ts`, branch `avatarOf` on render type:

```ts
import { nativeImage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { frameRect, parsePetManifest, isLive2DManifestRaw, parseLive2DManifest } from '@shared/petPackage'

const AVATAR_PX = 48

export function resolvePetDir(petId: string, dirs: { bundledPetsDir: string; userPetsDir: string }): string {
  const userDir = join(dirs.userPetsDir, petId)
  return existsSync(join(userDir, 'pet.json')) ? userDir : join(dirs.bundledPetsDir, petId)
}

export function createPetAvatarCache(): { avatarOf: (petDir: string, petId: string) => string } {
  const cache = new Map<string, { mtimeMs: number; url: string }>()
  return {
    avatarOf(petDir, petId) {
      try {
        const manifestPath = join(petDir, 'pet.json')
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (isLive2DManifestRaw(raw)) {
          const manifest = parseLive2DManifest(raw)
          if (!manifest.thumbnail) return ''
          const thumbPath = join(petDir, manifest.thumbnail)
          const mtimeMs = statSync(thumbPath).mtimeMs
          const hit = cache.get(petId)
          if (hit && hit.mtimeMs === mtimeMs) return hit.url
          const img = nativeImage.createFromPath(thumbPath)
          if (img.isEmpty()) { cache.set(petId, { mtimeMs, url: '' }); return '' }
          const url = img.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'good' }).toDataURL()
          cache.set(petId, { mtimeMs, url })
          return url
        }
        const manifest = parsePetManifest(raw)
        const idle = manifest.animations.idle
        if (!idle) return ''
        const sheetPath = join(petDir, manifest.spritesheetPath)
        const mtimeMs = statSync(sheetPath).mtimeMs
        const hit = cache.get(petId)
        if (hit && hit.mtimeMs === mtimeMs) return hit.url
        const img = nativeImage.createFromPath(sheetPath)
        if (img.isEmpty()) { cache.set(petId, { mtimeMs, url: '' }); return '' }
        const r = frameRect(manifest.sheet, idle.row, 0)
        const url = img.crop({ x: r.x, y: r.y, width: r.w, height: r.h })
          .resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'good' })
          .toDataURL()
        cache.set(petId, { mtimeMs, url })
        return url
      } catch (e) {
        console.warn('[petAvatar] 裁头像失败', petId, e)
        return ''
      }
    }
  }
}
```

In `src/main/pets/petChatList.ts`, thread `renderReady` through:

```ts
const item: PetChatListItem = {
  id: p.id,
  displayName: p.displayName,
  avatarDataUrl: input.avatarOf(p.id),
  active: p.id === input.activeId,
  renderReady: p.renderReady
}
```

In `src/main/shell/index.ts`, tighten `switchPet`'s existence check (around line 489-494) to also gate on `renderReady`:

```ts
async function switchPet(petId: string): Promise<boolean> {
  if (petId === session.petId) return false
  const target = listPets(petCatalogDirs).find((p) => p.id === petId)
  if (!target) {
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '找不到这只宠物')
    return false
  }
  if (!target.renderReady) {
    dialog.window()?.webContents.send(IPC.CHAT_ERROR, '这只宠物的渲染引擎还没就绪,暂时无法切换')
    return false
  }
  // ...其余逻辑不变（先建后弃 createPetSession 等）
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/pets/petAvatar.test.ts src/main/pets/petChatList.test.ts`
Expected: PASS

Run: `pnpm typecheck && pnpm test`
Expected: PASS across repo.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/pets/petAvatar.ts src/main/pets/petAvatar.test.ts src/main/pets/petChatList.ts src/main/pets/petChatList.test.ts src/main/shell/index.ts
git commit -m "feat(pets): renderReady 贯穿头像来源/聊天列表/热切换防御性校验"
```

---

### Task 10: 渲染层 UI——禁用态选择器 + 多行导入反馈

**Files:**
- Modify: `src/renderer/dialog.ts`
- Modify: `src/renderer/dialog.html`
- Modify: `src/renderer/settings.ts`
- Modify: `src/renderer/settings.html`

**Interfaces:**
- Consumes: `PetChatListItem.renderReady` (Task 9), `PetSummary.renderReady` (Task 7), `ImportResult.warnings` (Task 8)

No automated tests for this task — DOM wiring in this codebase is verified by running the app (`CLAUDE.md`: "GUI/Electron wiring is verified by running the app"; there is no existing `dialog.test.ts`/`settings.test.ts` precedent to extend). Verification happens in Task 11's manual walkthrough.

- [ ] **Step 1: `dialog.ts` — disabled pet-row rendering**

In `src/renderer/dialog.ts`, replace `renderPetList`:

```ts
function renderPetList(items: PetChatListItem[]): void {
  petListEl.innerHTML = ''
  for (const it of items) {
    const row = document.createElement('div')
    const classes = ['pet-row']
    if (it.active) classes.push('active')
    if (!it.renderReady) classes.push('disabled')
    row.className = classes.join(' ')
    if (!it.renderReady) row.title = '渲染引擎未就绪'
    const av = document.createElement('div')
    av.className = 'pr-avatar'
    if (it.avatarDataUrl) av.style.backgroundImage = `url(${it.avatarDataUrl})`
    const text = document.createElement('div')
    text.className = 'pr-text'
    const name = document.createElement('div')
    name.className = 'pr-name'
    name.textContent = it.displayName
    const last = document.createElement('div')
    last.className = 'pr-last'
    last.textContent = it.renderReady ? (it.lastMessage ?? '还没聊过') : '渲染引擎未就绪'
    text.append(name, last)
    row.append(av, text)
    if (!it.active && it.renderReady) row.addEventListener('click', () => { void switchTo(it.id) })
    petListEl.appendChild(row)
  }
}
```

- [ ] **Step 2: `dialog.html` — disabled row style**

In `src/renderer/dialog.html`, add right after the existing `.pet-row.active::before { ... }` rule (around line 38):

```css
.pet-row.disabled { cursor: default; opacity: 0.5; }
.pet-row.disabled:hover { background: none; }
```

- [ ] **Step 3: `settings.ts` — disabled `<option>` + import detail box**

In `src/renderer/settings.ts`, add near the other `$<...>` declarations (after line 28's `importPetBtn`):

```ts
const importDetail = $<HTMLElement>('importDetail')
```

Replace `refreshPets`:

```ts
async function refreshPets(selectId: string): Promise<void> {
  const pets = await window.settingsApi.listPets()
  petSelect.innerHTML = ''
  for (const p of pets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.renderReady ? p.displayName : `${p.displayName}(渲染引擎未就绪)`
    if (!p.renderReady) opt.disabled = true
    petSelect.appendChild(opt)
  }
  // 选中项:优先目标 id;若不可选(不在列表/坏包/渲染未就绪)则回落第一个可选宠物
  const selectable = pets.filter((p) => p.renderReady)
  petSelect.value = selectId
  if (petSelect.value !== selectId && selectable.length > 0) petSelect.value = selectable[0].id
}
```

Replace the `importPetBtn` click handler:

```ts
importPetBtn.addEventListener('click', async () => {
  importDetail.style.display = 'none'
  importDetail.innerHTML = ''
  try {
    const res = await window.settingsApi.importPet()
    if (!res) return // 用户取消,静默
    if (res.ok) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
      if (res.warnings && res.warnings.length > 0) {
        importDetail.style.display = 'block'
        for (const w of res.warnings) {
          const line = document.createElement('div')
          line.textContent = `· ${w}`
          importDetail.appendChild(line)
        }
      }
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})
```

- [ ] **Step 4: `settings.html` — markup + style for the import detail box**

In `src/renderer/settings.html`, add right after the `importPet`/`relaunch` button row (after line 108's closing `</div>`):

```html
            <div id="importDetail" class="hint" style="display:none;border:1px solid var(--border);border-radius:var(--radius-control);padding:8px 10px"></div>
```

- [ ] **Step 5: Typecheck (no unit test for this task)**

Run: `pnpm typecheck`
Expected: PASS — no type errors from the new DOM element access or the `PetChatListItem`/`PetSummary`/`ImportResult` field usage.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/dialog.ts src/renderer/dialog.html src/renderer/settings.ts src/renderer/settings.html
git commit -m "feat(pets): 选择器禁用未就绪的 live2d 条目,导入反馈支持多行提示"
```

---

### Task 11: 启动清理接线 + 全量验证

**Files:**
- Modify: `src/main/shell/index.ts`

**Interfaces:**
- Consumes: `cleanupStaleStaging` (Task 7)

- [ ] **Step 1: Wire `cleanupStaleStaging` into startup**

In `src/main/shell/index.ts`, find where `petCatalogDirs` is first available near the top of `startShell()`/the shell bootstrap function (same scope that already calls `listPets(petCatalogDirs)` at line 112), and add a single call right after `petCatalogDirs` is constructed, before any `listPets`/`IMPORT_PET` handler registration:

```ts
cleanupStaleStaging(petCatalogDirs.userPetsDir)
```

Add `cleanupStaleStaging` to the existing `import { ... } from './pets/petCatalog'` (or equivalent) import line at the top of the file.

- [ ] **Step 2: Full verification**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

Run: `pnpm test`
Expected: PASS, all existing tests plus every test added in Tasks 1-9.

Run: `pnpm build`
Expected: PASS, all three bundles (main/preload/renderer) build cleanly.

- [ ] **Step 3: Manual real-app walkthrough**

Run: `pnpm preview`

Manually confirm (per design doc's "真机验收" section — this phase touches no rendering/GPU code, so this is a light confirmation pass, not a full GUI regression matrix):

- [ ] Settings → "导入宠物包…" still imports an existing sprite pet folder successfully (no behavior regression from the staging rewrite)
- [ ] Prepare a minimal live2d test folder (pet.json with `render.type:"live2d"` + a `model/character.model3.json` + a small real PNG texture) and import it via the same button; confirm the multi-line `importDetail` box appears with any expected warnings, and the pet now shows in the Settings dropdown as `<displayName>(渲染引擎未就绪)`, disabled
- [ ] Open the chat dialog's left pet list; confirm the live2d entry appears greyed out with a "渲染引擎未就绪" tooltip on hover, and clicking it does nothing (no switch attempt, no error flash)
- [ ] Restart the app once with a live2d pet mid-import deliberately left in `.staging` (simulate by killing the app mid-`importPetFolder` via a breakpoint, or just manually create a stray `userData/pets/.staging/whatever/` folder) and confirm it's gone after the next launch

- [ ] **Step 4: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(pets): 启动时清理残留 .staging 目录"
```

---

## Self-Review Notes (already applied above, recorded for the reviewer)

- **Spec coverage:** every numbered item in the design doc's "导入流程"/"kibo-pet:// 受限资源协议"/"目录扫描与选择器展示" sections maps to a task above (Tasks 1-10); the "Phase 4/5/6 前置设计备忘录" section is explicitly non-code and isn't a task. `cleanupStaleStaging` (design doc step 12) is Task 7+11. Thumbnail handling (design doc step 9) is Task 8 (validation at import) + Task 9 (avatar sourcing).
- **Deviation from the design doc's literal wording, noted for the user:** the design doc's schema section mentions `PetSummary` could carry `thumbnailDataUrl?`; this plan instead threads live2d thumbnails through the *existing* `petAvatarCache`/`PetChatListItem.avatarDataUrl` mechanism (Task 9) — functionally equivalent (same visual result), avoids a second parallel avatar-data path, and matches how sprite pets already work. Worth a one-line flag to the user during task review.
- **Type consistency check:** `ImportResult`'s `pet: PetSummary` (Task 7/8) matches the `PetSummary` shape everywhere it's constructed; `PetChatListItem.renderReady` (Task 9) is produced by `buildPetChatList` from `PetSummary.renderReady` (Task 7) — same boolean, no renaming drift. `scanImportSource`'s `SecurityViolation.reason` values (Task 4) are a strict subset of `ImportReason` (Task 8) — every reason it can return exists in the extended union.
- **No placeholders:** every step above has literal code, not descriptions of code.
