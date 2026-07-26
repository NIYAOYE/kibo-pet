# Live2D 原始资源自动导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让导入器接受没有 `pet.json` 的原始 Live2D 目录，并安全补齐已有但不完整的 Live2D manifest。

**Architecture:** 在主进程宠物目录新增一个专职的 manifest 解析/生成模块。它先从受信任扫描结果中取得唯一 `.model3.json`，再生成完整默认 manifest 或只合并缺失字段；`petCatalog` 继续承担安全校验、资源复制、staging 与提交。生成/补齐信息通过已有 warnings 通道送到设置页预览，无需扩大 IPC 权限。

**Tech Stack:** TypeScript、Node `fs/path/crypto`、Vitest、Electron IPC（既有 `StageImportOutcome`）。

---

## 文件结构

- Create: `src/main/pets/live2dAutoManifest.ts` — 扫描 `.model3.json`，生成合法默认 manifest，或安全地补齐一个 Live2D manifest。
- Create: `src/main/pets/live2dAutoManifest.test.ts` — 生成/补齐规则的纯函数测试。
- Modify: `src/main/pets/petCatalog.ts` — 在既有安全扫描之后、Live2D 导入之前调用新模块；把自动化说明追加到 warnings 并把生成的 manifest 写入 staging。
- Modify: `src/main/pets/petCatalog.test.ts` — 覆盖无 manifest、部分 manifest、歧义模型和 staging 持久化行为。
- Modify: `src/shared/ipc.ts` — 为“没有模型/多个模型”添加明确的导入失败 reason；既有 warnings/预览载荷保持不变。

不改 `src/renderer/settings.ts`：它已经把 `StageImportOutcome.warnings` 渲染在预览面板中，导入器提供的“已生成/已补齐/发现资源数”说明会直接显示。

### Task 1: 定义自动 manifest 解析器

**Files:**
- Create: `src/main/pets/live2dAutoManifest.ts`
- Create: `src/main/pets/live2dAutoManifest.test.ts`
- Modify: `src/shared/ipc.ts:229-233`

- [ ] **Step 1: 写出解析器的失败测试**

在 `src/main/pets/live2dAutoManifest.test.ts` 新建测试，直接给纯函数传入目录名、相对模型路径和 raw manifest，不读真实磁盘：

```ts
import { describe, expect, it } from 'vitest'
import { parseLive2DManifest } from '@shared/petPackage'
import { resolveAutoLive2DManifest } from './live2dAutoManifest'

describe('resolveAutoLive2DManifest', () => {
  it('没有 pet.json 且只有一个 model3 文件时生成完整合法 manifest', () => {
    const result = resolveAutoLive2DManifest(undefined, {
      folderName: 'Panda cake', modelPaths: ['Panda cake/Panda cake.model3.json'], occupiedIds: new Set()
    })
    expect(result).toMatchObject({ ok: true, mode: 'generated' })
    if (!result.ok) throw new Error('expected generated manifest')
    expect(parseLive2DManifest(result.manifest).render).toMatchObject({
      type: 'live2d', model: 'Panda cake/Panda cake.model3.json',
      transform: { autoFitted: false, anchorX: 0.5, anchorY: 1 },
      interaction: { mirrorOnWalk: false, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: {}
    })
  })

  it('只补齐缺失字段，不覆盖用户的合法 viewport、id 与 stateMap', () => {
    const result = resolveAutoLive2DManifest({
      schemaVersion: 2, id: 'custom', displayName: '自定义名', description: 'd',
      render: { type: 'live2d', model: 'm/a.model3.json', viewport: { width: 720, height: 900, resolutionCap: 2 }, stateMap: { idle: { motionGroup: 'Idle' } } }
    }, { folderName: 'ignored', modelPaths: ['m/a.model3.json'], occupiedIds: new Set() })
    if (!result.ok) throw new Error('expected completed manifest')
    expect(result.mode).toBe('completed')
    expect(result.manifest.render.viewport).toEqual({ width: 720, height: 900, resolutionCap: 2 })
    expect(result.manifest.render.stateMap).toEqual({ idle: { motionGroup: 'Idle' } })
    expect(result.manifest.render.transform.autoFitted).toBe(false)
    expect(result.completedFields).toEqual(expect.arrayContaining(['render.transform', 'render.interaction']))
  })

  it('字段存在但类型错误时保留错误并由 manifest 校验拒绝', () => {
    const result = resolveAutoLive2DManifest({
      schemaVersion: 2, id: 'bad', displayName: 'Bad', description: 'd',
      render: { type: 'live2d', model: 'm/a.model3.json', viewport: 123 }
    }, { folderName: 'bad', modelPaths: ['m/a.model3.json'], occupiedIds: new Set() })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-manifest' })
  })

  it.each([
    [[], 'missing-live2d-model'],
    [['a.model3.json', 'b.model3.json'], 'ambiguous-live2d-model']
  ])('无 manifest 时模型列表 %j 返回具体错误', (modelPaths, reason) => {
    expect(resolveAutoLive2DManifest(undefined, { folderName: 'x', modelPaths, occupiedIds: new Set() }))
      .toMatchObject({ ok: false, reason })
  })
})
```

- [ ] **Step 2: 运行测试，确认缺少模块而失败**

Run: `pnpm vitest run src/main/pets/live2dAutoManifest.test.ts`  
Expected: FAIL，提示找不到 `./live2dAutoManifest`。

- [ ] **Step 3: 增加明确的导入错误类型**

在 `src/shared/ipc.ts` 的 `ImportReason` 联合类型末尾加入：

```ts
  | 'missing-live2d-model' | 'ambiguous-live2d-model'
```

不要复用 `no-manifest`：缺失 manifest 是可以自动处理的，而零/多个模型需要用户处理资源目录。

- [ ] **Step 4: 实现 `live2dAutoManifest.ts`**

定义只接受已发现模型相对路径的解析器，避免把未验证路径传给路径拼接逻辑：

```ts
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parseLive2DManifest, type Live2DManifest } from '@shared/petPackage'
import type { ImportReason } from '@shared/ipc'

type Input = { folderName: string; modelPaths: string[]; occupiedIds: ReadonlySet<string> }
export type AutoManifestResult =
  | { ok: true; mode: 'generated' | 'completed'; manifest: Live2DManifest; completedFields: string[] }
  | { ok: false; reason: ImportReason; message: string }
  | null

const DEFAULT_VIEWPORT = { width: 360, height: 480, resolutionCap: 1.5 }
const DEFAULT_TRANSFORM = { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0, autoFitted: false }
const DEFAULT_INTERACTION = { mirrorOnWalk: false, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' }

export function resolveAutoLive2DManifest(raw: unknown | undefined, input: Input): AutoManifestResult {
  // raw 是 undefined：必须恰有一个模型；raw 不是 render.type=live2d：返回 null，让 sprite 旧路径处理。
  // raw 是 Live2D：仅在 model 缺失时要求唯一模型；其余字段用 mergeMissing 保留类型错误，随后 parseLive2DManifest 拒绝。
}
```

实现细节必须满足：

- `modelPaths` 长度为 0/大于 1 时分别返回新增 reason 和列出相对路径的中文 message；
- 顶层 `id/displayName/description/schemaVersion` 缺失时补齐；已存在的值（包括错误类型）不覆盖；
- `mergeMissingObject(defaultValue, value)` 只在值为 `undefined` 时使用默认对象；值存在但不是对象时原样返回，保证 `parseLive2DManifest` 报错；
- `viewport`、`transform`、`interaction`、`stateMap` 分别深度补齐缺少的键；
- 显示名取模型文件名去掉 `.model3.json`，`id` 用目录名转为小写 ASCII `a-z0-9_-`；为空时用 `live2d`；若已占用则追加 `-${sha256(modelPath).slice(0, 8)}`；
- 用 `parseLive2DManifest` 对最终对象做唯一的结构正确性判定，捕获异常后返回 `{ ok:false, reason:'invalid-manifest', message: ... }`；
- `completedFields` 只记录实际补齐的用户可读路径（如 `render.transform.offsetY`），无 manifest 时使用 `['pet.json']`。

- [ ] **Step 5: 运行解析器测试，确认通过**

Run: `pnpm vitest run src/main/pets/live2dAutoManifest.test.ts`  
Expected: PASS，所有生成、补齐、歧义和非法类型断言通过。

- [ ] **Step 6: 提交纯逻辑与测试**

```bash
git add src/main/pets/live2dAutoManifest.ts src/main/pets/live2dAutoManifest.test.ts src/shared/ipc.ts
git commit -m "feat(Live2D): 生成基础宠物配置"
```

### Task 2: 将解析器接入安全 staging 导入

**Files:**
- Modify: `src/main/pets/petCatalog.ts:1-15,122-302`
- Modify: `src/main/pets/petCatalog.test.ts:1-70,260-470`

- [ ] **Step 1: 写出 stage 导入的失败测试**

在 `petCatalog.test.ts` 现有 Live2D staging describe 中新增：

```ts
it('原始 Live2D 目录没有 pet.json 时生成 manifest 并停在 staging 预览', () => {
  const src = scratch(); const user = scratch(); const dir = join(src, 'raw-model')
  mkdirSync(join(dir, 'model'), { recursive: true })
  writeFileSync(join(dir, 'model', 'raw.model3.json'), JSON.stringify({ FileReferences: {} }), 'utf-8')
  const r = stageImportPet(dir, { bundledPetsDir: scratch(), userPetsDir: user })
  expect(r).toMatchObject({ ok: true, committed: false })
  if (!r.ok || r.committed) throw new Error('expected staged Live2D import')
  expect(r.manifest.render.model).toBe('model/raw.model3.json')
  expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('已自动生成 pet.json')]))
  expect(JSON.parse(readFileSync(join(user, '.staging', r.stagingId, 'pet.json'), 'utf-8')).render.transform.autoFitted).toBe(false)
  expect(existsSync(join(dir, 'pet.json'))).toBe(false)
})

it('部分 Live2D manifest 只补齐缺失字段并在 staging 写入补齐结果', () => {
  const src = scratch(); const user = scratch(); const dir = join(src, 'partial')
  mkdirSync(join(dir, 'model'), { recursive: true })
  writeFileSync(join(dir, 'model', 'a.model3.json'), JSON.stringify({ FileReferences: {} }), 'utf-8')
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({
    schemaVersion: 2, id: 'partial', displayName: 'Partial', description: 'd',
    render: { type: 'live2d', model: 'model/a.model3.json', stateMap: { idle: { motionGroup: 'Idle' } } }
  }), 'utf-8')
  const r = stageImportPet(dir, { bundledPetsDir: scratch(), userPetsDir: user })
  if (!r.ok || r.committed) throw new Error('expected staged Live2D import')
  expect(r.manifest.render.stateMap).toEqual({ idle: { motionGroup: 'Idle' } })
  expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('已补齐')]))
})

it('无 manifest 但多个 model3 文件时拒绝且不留下 staging', () => {
  const src = scratch(); const user = scratch(); const dir = join(src, 'ambiguous')
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', 'a.model3.json'), '{}', 'utf-8')
  writeFileSync(join(dir, 'models', 'b.model3.json'), '{}', 'utf-8')
  const r = stageImportPet(dir, { bundledPetsDir: scratch(), userPetsDir: user })
  expect(r).toMatchObject({ ok: false, reason: 'ambiguous-live2d-model' })
  expect(existsSync(join(user, '.staging'))).toBe(false)
})
```

- [ ] **Step 2: 运行 staging 测试，确认当前实现失败**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts`  
Expected: FAIL：无 `pet.json` 仍返回 `no-manifest`，部分 manifest 仍被 `parseLive2DManifest` 拒绝。

- [ ] **Step 3: 在安全扫描后解析/生成 manifest**

调整 `stageImportPet` 的顺序为：

```ts
const violation = scanImportSource(srcDir)
if (violation) return { ok: false, reason: violation.reason, message: violation.message }

const manifestPath = join(srcDir, 'pet.json')
let raw: unknown | undefined
if (existsSync(manifestPath)) {
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) }
  catch (e) { return { ok: false, reason: 'invalid-manifest', message: `pet.json 不是合法 JSON:${(e as Error).message}` } }
}

const auto = resolveAutoLive2DManifest(raw, {
  folderName: basename(srcDir),
  modelPaths: findModel3JsonPaths(srcDir),
  occupiedIds: new Set([...listPets(dirs).map((pet) => pet.id)])
})
if (auto && !auto.ok) return auto
if (auto?.ok) {
  const autoNotes = auto.mode === 'generated'
    ? [`已自动生成 pet.json（模型：${auto.manifest.render.model}）`]
    : auto.completedFields.length > 0
      ? [`已补齐 pet.json：${auto.completedFields.join('、')}`]
      : []
  const result = importLive2DPet(auto.manifest, srcDir, stagingDir, dirs, autoNotes)
  if (!result.ok) {
    rmSync(stagingDir, { recursive: true, force: true })
    return result
  }
  return { ok: true, committed: false, stagingId, manifest: result.manifest, warnings: result.warnings }
}
return importSpritePet(raw, srcDir, stagingDir, dirs)
```

在 `petCatalog.ts` 增加文件私有函数 `findModel3JsonPaths(srcDir: string): string[]`：递归读取路径、只返回正斜杠相对路径且仅匹配以 `.model3.json` 结尾的普通文件。调用前已经过 `scanImportSource`，仍不得跟随符号链接。复用 `lstatSync` 和 `readdirSync`，不要接受来自 renderer 的文件路径字符串。

将 `importLive2DPet` 的签名扩展为接收 `autoNotes: string[] = []`，并在复制后**总是**写入 `finalManifest`：

```ts
writeFileSync(join(stagingDir, 'pet.json'), JSON.stringify(finalManifest, null, 2), 'utf-8')
```

这比当前“仅 possibleWatermark 时写 manifest”的逻辑多出必要行为：无 manifest 和部分 manifest 的规范化配置必须进入 staging，绝不能写回源目录。将 `autoNotes` 合入 warnings，例如：

```ts
warnings.unshift(
  auto.mode === 'generated'
    ? `已自动生成 pet.json（模型：${manifest.render.model}）`
    : `已补齐 pet.json：${auto.completedFields.join('、')}`
)
```

导入 `basename` 和新模块；现有完整 Live2D manifest 也可经解析器返回 `mode:'completed'` 且 `completedFields:[]`，此时不追加“已补齐”说明。

- [ ] **Step 4: 在导入后的模型资源统计中追加预览信息**

在 `scanAndPatchOrphanResources` 之后计算：

```ts
const expressionCount = patchedModel3Json.FileReferences.Expressions?.length ?? 0
const motionGroupCount = Object.keys(patchedModel3Json.FileReferences.Motions ?? {}).length
if (autoNotes.length > 0) warnings.unshift(`发现 ${expressionCount} 个表情、${motionGroupCount} 个动作组`)
```

只在本次生成或补齐时显示此信息，保持已有完整包导入的 warnings 文案稳定。不要把这些资源写入 `stateMap`，也不要推断任何动作语义。

- [ ] **Step 5: 运行导入回归测试，确认通过**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts src/main/pets/live2dAutoManifest.test.ts`  
Expected: PASS，包括既有 sprite、完整 Live2D、路径穿越、纹理预算、staging 提交/取消，以及新增自动化用例。

- [ ] **Step 6: 提交导入接线与测试**

```bash
git add src/main/pets/petCatalog.ts src/main/pets/petCatalog.test.ts
git commit -m "feat(Live2D): 自动补齐导入配置"
```

### Task 3: 验证预览反馈与跨进程类型

**Files:**
- Modify: `src/main/pets/petCatalog.test.ts:400-480`（仅当 Task 2 未覆盖 staged commit）
- Verify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/shell/index.ts`, `src/renderer/settings.ts`

- [ ] **Step 1: 写入确认提交与源目录不变的回归断言**

为 Task 2 的“原始目录没有 pet.json”用例追加：

```ts
const committed = commitStagedPet(r.stagingId, r.manifest.id, { bundledPetsDir: scratch(), userPetsDir: user })
expect(committed.ok).toBe(true)
expect(existsSync(join(dir, 'pet.json'))).toBe(false)
expect(existsSync(join(user, r.manifest.id, 'pet.json'))).toBe(true)
```

并增加一个空 `modelPaths` 的 stage 用例，断言 `{ reason: 'missing-live2d-model' }` 与 `.staging` 不存在。

- [ ] **Step 2: 运行新增断言，确认失败或补齐缺口**

Run: `pnpm vitest run src/main/pets/petCatalog.test.ts -t "原始 Live2D|多个 model3|没有可导入"`  
Expected: Task 2 完成后 PASS；若失败，修正测试暴露的 staging 写入或清理缺口，而非放宽断言。

- [ ] **Step 3: 确认无需新增 IPC 或 renderer 权限**

检查 `StageImportOutcome` 的 `warnings` 已通过 `settingsApi.stageImportPet()` 原样回到设置页，且 `settings.ts` 对 preview 与 committed 分支均调用 `appendWarnings`。不增加新的 IPC channel、preload API 或 renderer 文件系统访问；导入语义变化局限于主进程。

- [ ] **Step 4: 运行静态与全量单元测试**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: 两条命令退出码为 0；`ImportReason` 的穷尽分支、IPC 类型和全部 Vitest 测试通过。

- [ ] **Step 5: 做一次真实设置页验收**

Run: `pnpm preview`  
Expected: 在设置页依次选择“无 `pet.json` 的唯一模型目录”和“缺少 `transform/interaction/stateMap` 的目录”；两者都显示预览，并在 warnings 区出现生成/补齐说明及资源数量。取消后源目录与应用 pets 目录都不出现新包；确认后只在应用 pets 目录出现完整 `pet.json`。切换到该宠物后，首次加载将 `autoFitted` 写为 `true` 并写入实际 `scale/offsetX/offsetY`。

- [ ] **Step 6: 提交验证补充（若 Step 1 新增了测试）**

```bash
git add src/main/pets/petCatalog.test.ts
git commit -m "test(Live2D): 覆盖自动导入提交边界"
```

## 实施后收尾

- 在交付前执行 `git diff --check` 与 `git status --short`，确认没有误改用户资源目录或留下 staging 测试文件。
- 按仓库约束，将本功能的中间提交压缩为一个中文 conventional commit；不要合并或改写用户已有提交。
- 若视觉验收因本机没有可分发的真实模型而不能完成，在交付中明确给出上述两类目录的手工验收步骤，不能把自动化测试说成 GUI 已验收。
