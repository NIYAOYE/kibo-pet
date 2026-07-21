# Live2D Phase 3:PetRenderer 抽象 + 精灵兼容驱动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `LoadedPet`/`loadPet`/`GET_PET` IPC 四件套拓宽成 sprite/live2d 判别式(`PetRenderSource`),定义 `PetRenderer` 接口边界,并把现有 `SpritePlayer` 收编成实现该接口的 `SpriteRenderer`,`PetController` 改为只依赖接口——不引入任何真实 Live2D 渲染。

**Architecture:** `src/shared/petPackage.ts` 新增判别式类型 `PetRenderSource`,`src/main/petLoader.ts` 按 `render.type` 分流产出;`src/renderer/petRenderer.ts` 定义纯接口,`src/renderer/spriteRenderer.ts`(原 `spritePlayer.ts`)实现它;`PetController`/`main.ts` 只认接口类型,渲染器具体类只在 `main.ts` 的一处工厂函数里出现。额外补一个启动路径的 `renderReady` 守卫(`resolveEffectivePetHome`),让 live2d 包永远不会在 Phase 4 真实渲染器就绪前被尝试加载。

**Tech Stack:** TypeScript, Electron(main/preload/renderer 三进程), Vitest。

## Global Constraints

- 包管理器是 pnpm,不用 npm/yarn。
- 跨进程类型只能走 `@shared/*` 别名,禁止在 main/preload/renderer 里硬编码 IPC 字符串——用 `ipc.ts` 的 `IPC` 常量。
- 纯逻辑用 TDD(先写失败的 Vitest);本阶段不触碰任何 GUI/Electron 可视行为,不需要新增真机验收步骤(设计文档已确认)。
- 不实现 `Live2DPetRenderer`、不接入 `kibo-pet://` 协议 handler、不铸造 protocol token——这些都是 Phase 4 范围。
- `PetRenderSource` 的 live2d 分支只带 `{ type: 'live2d'; manifest: Live2DManifest }`,不带任何 `baseUrl`/资源地址字段(见设计文档"修正"节)。
- `setFacing()` 在本阶段对 `SpriteRenderer` 是显式 no-op,`PetController` 不调用它。
- 提交信息用 conventional commit 格式(`feat(scope): ...`),消息正文用中文。
- 每个任务完成后跑 `pnpm typecheck` 确认整个项目(不只是改动文件)类型正确。

---

### Task 1: `PetRenderSource` 判别式 + `loadPet()` 分流 + IPC/preload 类型贯穿

**Files:**
- Modify: `src/shared/petPackage.ts`(追加类型,文件末尾)
- Modify: `src/shared/ipc.ts`(删除 `LoadedPet`,`PetApi.getPet` 改签名,更新一处过时注释)
- Modify: `src/main/petLoader.ts`(重写 `loadPet()`)
- Modify: `src/main/petLoader.test.ts`(更新现有断言 + 新增 live2d 用例)
- Modify: `src/preload/index.ts`(类型 import 调整)
- Modify: `src/main/shell/petSession.ts:142`(`.manifest.voice` 访问需要按判别式收窄)
- Modify: `src/main/shell/index.ts:753`(同上)
- Modify: `src/renderer/dialog.ts`(`loadAvatar()` 直接调用 `getPet()` 并解构 `manifest.animations`/`manifest.sheet`/`spritesheetDataUrl` 裁剪聊天头像;写 plan 时漏查了这个消费点,由 Task 1 implementer 在 `pnpm typecheck` 时发现。修法与其它两处一致:`if (pet.type !== 'sprite') return`,复用函数已有的"裁不出就静默放弃、退回 CSS 占位"降级路径,不新增分支逻辑)

**为什么这些改动都在本任务范围内:** `PetManifest.voice?: PetVoice` 只存在于 sprite 分支;`Live2DManifest` 没有 `voice` 字段。`loadPet()` 的返回类型一旦从扁平结构改成判别式联合,这两处直接 `.manifest.voice` 的访问就会编译报错("属性 'voice' 在类型 'Live2DManifest' 上不存在")——这是本任务的类型改动直接导致的破坏,不修就无法让项目在本任务结束时保持可编译,因此和 Task 1 的其余改动绑在一起,不拆成单独任务。

**Interfaces:**
- Consumes: `src/shared/petPackage.ts` 已有的 `parsePetManifest`、`parseLive2DManifest`、`isLive2DManifestRaw`、`PetManifest`、`Live2DManifest`(全部已存在,无需改动)。
- Produces: `PetRenderSource`(`src/shared/petPackage.ts` 导出的判别式类型,供 Task 3/4/5 使用)、`loadPet(petDir: string): Promise<PetRenderSource>`(签名变化,供 `src/main/shell/index.ts` 现有调用点自动适配,无需改动调用点代码)。

- [ ] **Step 1: 写失败的测试(更新现有断言 + 新增 live2d 用例)**

把 `src/main/petLoader.test.ts` 整个替换成:

```ts
import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPet } from './petLoader'

const lulukaDir = resolve(__dirname, '../../pets/luluka')

/** 故意不创建 model3.json 指向的文件:证明 loadPet 的 live2d 分支只读 pet.json,不读模型文件。 */
function makeLive2DPetDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'petloader-live2d-'))
  const dir = join(root, 'chitose')
  mkdirSync(dir, { recursive: true })
  const manifest = {
    schemaVersion: 2, id: 'chitose', displayName: '千岁', description: '千岁的描述',
    render: {
      type: 'live2d', model: 'model/character.model3.json',
      viewport: { width: 360, height: 480, resolutionCap: 1.5 },
      transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0.5, anchorY: 1, bubbleAnchorX: 0.5, bubbleAnchorY: 0 },
      interaction: { mirrorOnWalk: true, mouseTracking: true, lipSyncParameter: 'ParamMouthOpenY' },
      stateMap: {}
    }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  return dir
}

describe('loadPet', () => {
  it('loads luluka manifest and embeds spritesheet as data url', async () => {
    const pet = await loadPet(lulukaDir)
    expect(pet.type).toBe('sprite')
    if (pet.type !== 'sprite') throw new Error('unreachable')
    expect(pet.manifest.id).toBe('luluka')
    expect(pet.manifest.animations.idle.row).toBe(0)
    expect(pet.spritesheetDataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(pet.spritesheetDataUrl.length).toBeGreaterThan(1000)
  })

  it('loads a live2d manifest without touching any model file', async () => {
    const dir = makeLive2DPetDir()
    const pet = await loadPet(dir)
    expect(pet.type).toBe('live2d')
    if (pet.type !== 'live2d') throw new Error('unreachable')
    expect(pet.manifest.id).toBe('chitose')
    expect(pet.manifest.render.model).toBe('model/character.model3.json')
  })

  it('throws on a directory without pet.json', async () => {
    await expect(loadPet(resolve(__dirname, '__no_such_pet_dir__'))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/petLoader.test.ts`
Expected: FAIL —— `pet.type` 是 `undefined`(现有 `loadPet()` 返回扁平结构,没有 `type` 字段),且 live2d 用例会因为 `parsePetManifest` 校验不出 `sheet`/`animations` 字段而抛错。

- [ ] **Step 3: 在 `petPackage.ts` 追加 `PetRenderSource` 类型**

在 `src/shared/petPackage.ts` 文件末尾(`parseLive2DManifest` 函数之后)追加:

```ts
export type PetRenderSource =
  | { type: 'sprite'; manifest: PetManifest; spritesheetDataUrl: string }
  | { type: 'live2d'; manifest: Live2DManifest }
```

- [ ] **Step 4: 重写 `loadPet()`**

把 `src/main/petLoader.ts` 整个替换成:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type PetRenderSource } from '@shared/petPackage'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

export async function loadPet(petDir: string): Promise<PetRenderSource> {
  const manifestRaw = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
  if (isLive2DManifestRaw(manifestRaw)) {
    const manifest = parseLive2DManifest(manifestRaw)
    return { type: 'live2d', manifest }
  }
  const manifest = parsePetManifest(manifestRaw)
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { type: 'sprite', manifest, spritesheetDataUrl }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/main/petLoader.test.ts`
Expected: PASS(3 个用例全绿)。

- [ ] **Step 6: 更新 `src/shared/ipc.ts` —— 删除 `LoadedPet`,`PetApi.getPet` 改签名**

在 `src/shared/ipc.ts` 顶部的 import 里加入 `PetRenderSource`:

```ts
import type { PetManifest, PetVoice, PetRenderSource } from './petPackage'
```

删除这个接口整块(原第 90-94 行):

```ts
export interface LoadedPet {
  manifest: PetManifest
  /** data: URL of the spritesheet (webp), so the renderer needs no file access */
  spritesheetDataUrl: string
}
```

把 `PetApi` 接口里的这一行:

```ts
  getPet(): Promise<LoadedPet>
```

改成:

```ts
  getPet(): Promise<PetRenderSource>
```

把 `PetApi.onPetChanged` 的文档注释:

```ts
  /** 主进程通知宠物已换,渲染层重载精灵(重新 getPet + 重建 SpritePlayer) */
```

改成:

```ts
  /** 主进程通知宠物已换,渲染层重载精灵(重新 getPet + renderer.load()) */
```

- [ ] **Step 7: 更新 `src/preload/index.ts`**

把顶部 import 块里的:

```ts
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace, type ContextSignalKind,
  type VoiceApi, type VoiceInstallProgress, type VoicePcmChunk,
  type GenieVoiceApi, type GenieInstallProgress,
  type PetChatListItem, type PetSwitchedPayload
} from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
```

改成:

```ts
import {
  IPC, type PetApi, type ChatApi, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace, type ContextSignalKind,
  type VoiceApi, type VoiceInstallProgress, type VoicePcmChunk,
  type GenieVoiceApi, type GenieInstallProgress,
  type PetChatListItem, type PetSwitchedPayload
} from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
import type { PetRenderSource } from '@shared/petPackage'
```

把:

```ts
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
```

改成:

```ts
  getPet: (): Promise<PetRenderSource> => ipcRenderer.invoke(IPC.GET_PET),
```

- [ ] **Step 8: 修 `src/main/shell/petSession.ts:142` 的判别式收窄**

把:

```ts
      petVoice = (await loadPet(petDir)).manifest.voice
```

改成:

```ts
      const source = await loadPet(petDir)
      petVoice = source.type === 'sprite' ? source.manifest.voice : undefined
```

- [ ] **Step 9: 修 `src/main/shell/index.ts:753` 的判别式收窄**

把:

```ts
      activePetVoice = (await loadPet(session.petDir)).manifest.voice
```

改成:

```ts
      const loadedForVoice = await loadPet(session.petDir)
      activePetVoice = loadedForVoice.type === 'sprite' ? loadedForVoice.manifest.voice : undefined
```

- [ ] **Step 10: 修 `src/renderer/dialog.ts` 的 `loadAvatar()`(写 plan 时漏查的第四处消费点)**

把:

```ts
/** 从宠物 spritesheet 裁出 idle 动画首帧,作为聊天室头像;失败(如包缺 idle 动画)时静默放弃,
 *  头像元素退回 CSS 里的浅紫底色占位,不影响聊天功能本身。 */
async function loadAvatar(): Promise<void> {
  const pet = await window.petApi.getPet()
  petNameEl.textContent = pet.manifest.displayName
  const idle = pet.manifest.animations.idle
  if (!idle) return
```

改成:

```ts
/** 从宠物 spritesheet 裁出 idle 动画首帧,作为聊天室头像;失败(如包缺 idle 动画,或宠物
 *  是 live2d 类型)时静默放弃,头像元素退回 CSS 里的浅紫底色占位,不影响聊天功能本身。 */
async function loadAvatar(): Promise<void> {
  const pet = await window.petApi.getPet()
  petNameEl.textContent = pet.manifest.displayName
  if (pet.type !== 'sprite') return
  const idle = pet.manifest.animations.idle
  if (!idle) return
```

函数其余部分(`frameRect(pet.manifest.sheet, ...)`、`img.src = pet.spritesheetDataUrl` 等)不用改——`pet` 在这行之后已经被收窄成 `{ type: 'sprite'; ... }` 分支,后续访问自动类型正确。

- [ ] **Step 11: 全项目 typecheck**

Run: `pnpm typecheck`
Expected: 通过,无残留 `LoadedPet` 引用报错、无 `.manifest.voice` 判别式收窄报错、`src/renderer/dialog.ts` 干净。此时 `src/renderer/main.ts`/`src/renderer/petController.ts`/`src/renderer/spritePlayer.ts` 还没改,它们目前解构 `{ manifest, spritesheetDataUrl }`,在 `PetRenderSource` 是判别式联合类型后,这种解构会报"属性 `spritesheetDataUrl` 不存在于类型 `PetRenderSource`"的编译错误——这是预期的、留给 Task 3/4/5 处理,不是本任务的回归。确认报错只出现在这三个 renderer 文件里,`src/shared/*`、`src/main/*`、`src/preload/*`、`src/renderer/dialog.ts` 应该全部干净。

- [ ] **Step 12: 提交**

```bash
git add src/shared/petPackage.ts src/shared/ipc.ts src/main/petLoader.ts src/main/petLoader.test.ts src/preload/index.ts src/main/shell/petSession.ts src/main/shell/index.ts src/renderer/dialog.ts
git commit -m "$(cat <<'EOF'
feat(pets): PetRenderSource 判别式取代扁平 LoadedPet

loadPet() 按 render.type 分流,live2d 分支只解析 manifest,不读任何
模型文件(资源协议接线是 Phase 4 的事)。IPC/preload 类型贯穿更新;
petSession.ts/shell/index.ts/dialog.ts 三处直接消费 loadPet() 结果的
sprite 专属字段访问按判别式收窄(voice/spritesheetDataUrl 等字段只
存在于 sprite 分支)。
EOF
)"
```

---

### Task 2: 启动路径 `renderReady` 守卫(`resolveEffectivePetHome`)

**Files:**
- Create: `src/main/pets/resolveEffectivePetHome.ts`
- Create: `src/main/pets/resolveEffectivePetHome.test.ts`
- Modify: `src/main/shell/index.ts`(把 `resolvePetHome` 调用点换成 `resolveEffectivePetHome`)

**Interfaces:**
- Consumes: `resolvePetHome`/`ResolvePetHomeOptions`/`ResolvePetHomeResult`(`src/main/pets/resolvePetHome.ts`,已存在,不改动)、`listPets`(`src/main/pets/petCatalog.ts`,已存在,签名 `listPets(dirs: { bundledPetsDir: string; userPetsDir: string }): PetSummary[]`)。
- Produces: `resolveEffectivePetHome(opts: ResolveEffectivePetHomeOptions): ResolvePetHomeResult`,供 Task 内 `shell/index.ts` 调用点使用。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/pets/resolveEffectivePetHome.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveEffectivePetHome } from './resolveEffectivePetHome'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'resolveeffective-'))
}
function makeSpritePet(root: string, id: string): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id, displayName: id, description: `${id} 的描述`, spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'spritesheet.webp'), 'fake-bytes', 'utf-8')
}
function makeLive2DPet(root: string, id: string): void {
  const dir = join(root, id)
  mkdirSync(join(dir, 'model'), { recursive: true })
  const manifest = {
    schemaVersion: 2, id, displayName: id, description: `${id} 的描述`,
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
}
function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() as string
}

describe('resolveEffectivePetHome', () => {
  it('配置的宠物是 sprite → 正常 ready,用配置的 id', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeSpritePet(bundledPetsDir, 'luluka')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'luluka', defaultPetId: 'luluka', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('luluka')
  })

  it('配置的宠物是 live2d(renderReady:false)→ 回退默认 sprite 宠物,不当场启动', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    makeSpritePet(bundledPetsDir, 'luluka')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'luluka', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('luluka')
  })

  it('配置的宠物就是默认宠物且是 live2d(不应发生的极端情况)→ 没有二次回退目标,原样放行', () => {
    const userDataDir = scratch()
    const bundledPetsDir = scratch()
    makeLive2DPet(bundledPetsDir, 'chitose')
    const result = resolveEffectivePetHome({
      userDataDir, bundledPetsDir, userPetsDir: join(userDataDir, 'pets'),
      configuredPetId: 'chitose', defaultPetId: 'chitose', legacyMemoryDir: join(userDataDir, 'memory')
    })
    expect(result.mode).toBe('ready')
    if (result.mode === 'ready') expect(basenameOf(result.petHome.petHome)).toBe('chitose')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/pets/resolveEffectivePetHome.test.ts`
Expected: FAIL —— 模块 `./resolveEffectivePetHome` 不存在。

- [ ] **Step 3: 实现 `resolveEffectivePetHome`**

创建 `src/main/pets/resolveEffectivePetHome.ts`:

```ts
import { basename } from 'node:path'
import { resolvePetHome, type ResolvePetHomeOptions, type ResolvePetHomeResult } from './resolvePetHome'
import { listPets } from './petCatalog'

export interface ResolveEffectivePetHomeOptions extends ResolvePetHomeOptions {
  userPetsDir: string
}

/**
 * resolvePetHome() 只看"配置的 id 有没有对应的宠物包目录",不知道 renderReady 这个正交
 * 维度(渲染引擎是否就绪)。这层包装在其结果之上再补一次检查:若解析出的宠物
 * renderReady===false(即一个 live2d 包,Phase 3 时还没有真实渲染器),按"配置的 id 无效"
 * 同样的口径回退到 defaultPetId 重新解析一次——与 switchPet() 里已有的 renderReady 拦截
 * 口径保持一致。若连回退目标本身都不可用(不应发生),原样放行,交给渲染层的防御性兜底处理。
 */
export function resolveEffectivePetHome(opts: ResolveEffectivePetHomeOptions): ResolvePetHomeResult {
  const first = resolvePetHome(opts)
  if (first.mode === 'onboarding') return first
  const effectiveId = basename(first.petHome.petHome)
  const summary = listPets({ bundledPetsDir: opts.bundledPetsDir, userPetsDir: opts.userPetsDir }).find((p) => p.id === effectiveId)
  if (summary && !summary.renderReady && effectiveId !== opts.defaultPetId) {
    console.warn(`[pet] activePetId "${effectiveId}" 渲染引擎未就绪(live2d,Phase 3 尚无渲染器),回退默认宠物 "${opts.defaultPetId}"`)
    return resolvePetHome({ ...opts, configuredPetId: opts.defaultPetId })
  }
  return first
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/pets/resolveEffectivePetHome.test.ts`
Expected: PASS(3 个用例全绿)。

- [ ] **Step 5: 接入 `src/main/shell/index.ts`**

把顶部 import(原第 54 行):

```ts
import { resolvePetHome } from '../pets/resolvePetHome'
```

改成:

```ts
import { resolveEffectivePetHome } from '../pets/resolveEffectivePetHome'
```

把调用点(原第 194-200 行)：

```ts
  const resolved = resolvePetHome({
    userDataDir: userData,
    bundledPetsDir: petCatalogDirs.bundledPetsDir,
    configuredPetId,
    defaultPetId,
    legacyMemoryDir
  })
```

改成:

```ts
  const resolved = resolveEffectivePetHome({
    userDataDir: userData,
    bundledPetsDir: petCatalogDirs.bundledPetsDir,
    userPetsDir: petCatalogDirs.userPetsDir,
    configuredPetId,
    defaultPetId,
    legacyMemoryDir
  })
```

(`petCatalogDirs.userPetsDir` 已经在同一函数里定义,见原第 179 行 `const petCatalogDirs = { bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData, 'pets') }`,不需要新增变量。)

- [ ] **Step 6: 全项目 typecheck + 现有测试回归**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过,`resolvePetHome.test.ts` 不受影响(该文件本体未改动)。

- [ ] **Step 7: 提交**

```bash
git add src/main/pets/resolveEffectivePetHome.ts src/main/pets/resolveEffectivePetHome.test.ts src/main/shell/index.ts
git commit -m "$(cat <<'EOF'
feat(pets): 启动路径补 renderReady 守卫,与 switchPet 口径一致

activePetId 若指向一个 renderReady:false 的 live2d 包(Phase 3 尚无
渲染器),启动时回退默认宠物,而不是尝试构造一个 renderer 不认识的
渲染源。resolvePetHome 本体不改动,新增一层组合函数。
EOF
)"
```

---

### Task 3: `PetRenderer` 接口 + `SpriteRenderer`(收编 `SpritePlayer`)

**Files:**
- Create: `src/renderer/petRenderer.ts`
- Create: `src/renderer/spriteRenderer.ts`(内容取代 `src/renderer/spritePlayer.ts`)
- Create: `src/renderer/spriteRenderer.test.ts`(内容取代 `src/renderer/spritePlayer.test.ts`)
- Delete: `src/renderer/spritePlayer.ts`、`src/renderer/spritePlayer.test.ts`

**Interfaces:**
- Consumes: `PetRenderSource`(Task 1 产出,`@shared/petPackage`)、`frameRect`/`frameDurationMs`/`PetManifest`/`PetAnimation`(`@shared/petPackage`,已存在不变)。
- Produces: `PetRenderer` 接口 + `PetVisualState`/`PetHitResult`/`PetViewport` 类型(`src/renderer/petRenderer.ts`),`SpriteRenderer` 类(`src/renderer/spriteRenderer.ts`,构造函数 `new SpriteRenderer(canvas: HTMLCanvasElement)`),供 Task 4/5 使用。`nextFrameIndex` 纯函数原样保留导出。

- [ ] **Step 1: 写失败的测试(把 `spritePlayer.test.ts` 的内容原样迁到新文件,只改 import 路径)**

创建 `src/renderer/spriteRenderer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nextFrameIndex } from './spriteRenderer'

describe('nextFrameIndex', () => {
  it('advances within range', () => {
    expect(nextFrameIndex(0, 6, true)).toBe(1)
  })
  it('loops back to 0 when loop=true', () => {
    expect(nextFrameIndex(5, 6, true)).toBe(0)
  })
  it('holds last frame when loop=false', () => {
    expect(nextFrameIndex(4, 5, false)).toBe(4)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/renderer/spriteRenderer.test.ts`
Expected: FAIL —— 模块 `./spriteRenderer` 不存在。

- [ ] **Step 3: 创建 `PetRenderer` 接口文件**

创建 `src/renderer/petRenderer.ts`:

```ts
import type { PetRenderSource } from '@shared/petPackage'

/** 与 petBrain.ts 的 StepEffects.animation 同形状,直接复用其取值
 *  ('idle'/'walk-left'/'walk-right'/'drag'/'sleep'/'greet'/'thinking'/'talk')。 */
export type PetVisualState = string

export interface PetHitResult {
  hit: boolean
  /** live2d 命中的部位名(如 'Head'/'Body');sprite 渲染器不产出这个字段。 */
  area?: string
}

export interface PetViewport {
  width: number
  height: number
}

/**
 * PetController 只依赖这个接口,不知道背后是精灵动画还是 Live2D 模型。
 * 见主设计文档(docs/superpowers/specs/2026-07-20-live2d-renderer-design.md)§7.1。
 */
export interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  playState(state: PetVisualState): void
  /** live2d 用的镜像朝向;sprite 渲染器上是 no-op(朝向由 playState 的 walk-left/walk-right 决定)。 */
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
```

- [ ] **Step 4: 创建 `SpriteRenderer`**

创建 `src/renderer/spriteRenderer.ts`:

```ts
import { frameRect, frameDurationMs, type PetManifest, type PetAnimation, type PetRenderSource } from '@shared/petPackage'
import type { PetRenderer, PetVisualState, PetHitResult, PetViewport } from './petRenderer'

export function nextFrameIndex(current: number, frames: number, loop: boolean): number {
  const next = current + 1
  if (next < frames) return next
  return loop ? 0 : frames - 1
}

/** 精灵动画渲染器:收编自原 SpritePlayer,逐帧绘制逻辑不变,只是包了一层 PetRenderer 接口。 */
export class SpriteRenderer implements PetRenderer {
  private timer: number | null = null
  private frame = 0
  private state = ''
  private sheet: HTMLImageElement | null = null
  private manifest: PetManifest | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  async load(source: PetRenderSource): Promise<void> {
    if (source.type !== 'sprite') throw new Error('SpriteRenderer 只能加载 type:"sprite" 的 PetRenderSource')
    this.stop()
    const img = new Image()
    img.src = source.spritesheetDataUrl
    await img.decode()
    this.sheet = img
    this.manifest = source.manifest
    this.frame = 0
    this.state = ''
  }

  playState(state: PetVisualState): void {
    this.stop()
    if (!this.manifest) return
    const anim = this.manifest.animations[state]
    if (!anim) return
    this.state = state
    this.frame = 0
    this.canvas.width = this.manifest.sheet.cellWidth
    this.canvas.height = this.manifest.sheet.cellHeight
    this.tick(anim)
  }

  setFacing(_direction: 'left' | 'right'): void {
    // no-op:sprite 包的朝向由 playState('walk-left'/'walk-right') 自身决定(两行独立绘制
    // 的动画),不需要镜像变换。只有 Live2D 渲染器(Phase 4)会真正实现这个方法。
  }

  setLipSync(_level: number): void {
    // no-op:精灵格式没有可驱动的口型参数,这是格式本身的固有限制,不是遗漏。
  }

  hitTest(clientX: number, clientY: number): PetHitResult {
    return { hit: this.isPetPixel(clientX, clientY) }
  }

  resize(_viewport: PetViewport): void {
    // no-op:画布尺寸仍在 load()/playState() 时从 manifest.sheet 派生;真正的动态窗口
    // 尺寸是 Phase 5 的工作(主设计文档 §9)。
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
  }

  async destroy(): Promise<void> {
    this.stop()
    this.sheet = null
    this.manifest = null
  }

  private stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private tick(anim: PetAnimation): void {
    this.draw(anim, this.frame)
    const delay = frameDurationMs(anim, this.frame)
    const next = nextFrameIndex(this.frame, anim.frames, anim.loop)
    if (next === this.frame && !anim.loop) return // held last frame
    this.timer = window.setTimeout(() => {
      this.frame = next
      if (this.manifest?.animations[this.state] === anim) this.tick(anim)
    }, delay)
  }

  private draw(anim: PetAnimation, index: number): void {
    if (!this.manifest || !this.sheet) return
    const r = frameRect(this.manifest.sheet, anim.row, index)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, r.w, r.h)
    ctx.drawImage(this.sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  }

  /**
   * True when a viewport point falls on a non-transparent pixel of the pet.
   * Used to decide click-through: transparent areas should pass clicks below.
   */
  private isPetPixel(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) {
      return false
    }
    const px = Math.floor((clientX - rect.left) * (this.canvas.width / rect.width))
    const py = Math.floor((clientY - rect.top) * (this.canvas.height / rect.height))
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    const alpha = ctx.getImageData(px, py, 1, 1).data[3]
    return alpha > 10
  }
}
```

- [ ] **Step 5: 删除旧文件**

```bash
git rm src/renderer/spritePlayer.ts src/renderer/spritePlayer.test.ts
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run src/renderer/spriteRenderer.test.ts`
Expected: PASS(3 个用例全绿)。

- [ ] **Step 7: 全项目 typecheck**

Run: `pnpm typecheck`
Expected: `src/renderer/main.ts`/`src/renderer/petController.ts` 会报"找不到模块 './spritePlayer'"或"`SpritePlayer` 未定义"——这是预期的,留给 Task 4/5 修复,不是本任务回归。确认 `src/renderer/petRenderer.ts`/`src/renderer/spriteRenderer.ts` 这两个新文件本身没有类型错误(可以用 `pnpm typecheck 2>&1 | grep -v "spritePlayer\|petController.ts\|main.ts"` 之类的方式排除已知的、留给后续任务的报错,确认没有其它意外报错)。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/petRenderer.ts src/renderer/spriteRenderer.ts src/renderer/spriteRenderer.test.ts
git commit -m "$(cat <<'EOF'
feat(renderer): PetRenderer 接口 + SpriteRenderer 收编 SpritePlayer

逐帧绘制逻辑原样保留(nextFrameIndex/frameRect/frameDurationMs 不变),
只是包了一层接口:load() 吸收原来外部做的 Image 解码步骤,setFacing/
setLipSync/resize 对精灵渲染器是显式 no-op。旧 SpritePlayer 类删除。
EOF
)"
```

---

### Task 4: `PetController` 改为只依赖 `PetRenderer`

**Files:**
- Modify: `src/renderer/petController.ts`

**Interfaces:**
- Consumes: `PetRenderer`(Task 3,`./petRenderer`)。
- Produces: `PetController` 构造函数签名变为 `constructor(private renderer: PetRenderer)`,供 Task 5(`main.ts`)使用。

- [ ] **Step 1: 改 import 和构造函数**

把 `src/renderer/petController.ts` 顶部:

```ts
import { SpritePlayer } from './spritePlayer'
```

改成:

```ts
import type { PetRenderer } from './petRenderer'
```

把:

```ts
  constructor(private player: SpritePlayer) {}
```

改成:

```ts
  constructor(private renderer: PetRenderer) {}
```

- [ ] **Step 2: 改 `reload()`**

把:

```ts
  /** 热切换宠物:重新拉取宠物数据、换掉 SpritePlayer 的图集/manifest,大脑复位到 idle。 */
  async reload(): Promise<void> {
    const { manifest, spritesheetDataUrl } = await window.petApi.getPet()
    const sheet = new Image()
    sheet.src = spritesheetDataUrl
    await sheet.decode()
    this.player.reload(sheet, manifest)
    this.ctx = initBrain()
    this.currentAnim = ''
  }
```

改成:

```ts
  /** 热切换宠物:重新拉取宠物数据,交给渲染器重新加载,大脑复位到 idle。 */
  async reload(): Promise<void> {
    const source = await window.petApi.getPet()
    await this.renderer.load(source)
    this.ctx = initBrain()
    this.currentAnim = ''
  }
```

- [ ] **Step 3: 改 `tick()` 里唯一一处调用点**

把:

```ts
      this.player.play(effects.animation)
```

改成:

```ts
      this.renderer.playState(effects.animation)
```

- [ ] **Step 4: 全项目 typecheck**

Run: `pnpm typecheck`
Expected: `src/renderer/petController.ts` 不再报错;`src/renderer/main.ts` 仍会报错(留给 Task 5),这是预期的。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/petController.ts
git commit -m "$(cat <<'EOF'
refactor(renderer): PetController 只依赖 PetRenderer 接口

不再直接引用 SpritePlayer/SpriteRenderer 具体类;reload() 把
Image 解码步骤交还给 renderer.load() 内部处理。
EOF
)"
```

---

### Task 5: `main.ts` 接线(渲染器工厂 + hitTest)

**Files:**
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `SpriteRenderer`(Task 3)、`PetRenderer`/`PetRenderSource`(Task 3/1)、`PetController`(Task 4,构造函数签名 `constructor(private renderer: PetRenderer)`)。
- Produces: 无新导出——本任务是最终消费端接线。

- [ ] **Step 1: 改顶部 import**

把:

```ts
import { SpritePlayer } from './spritePlayer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
```

改成:

```ts
import { SpriteRenderer } from './spriteRenderer'
import { PetController } from './petController'
import { createPcmPlayer } from './voice/pcmPlayer'
import type { PetRenderer } from './petRenderer'
import type { PetRenderSource } from '@shared/petPackage'
```

- [ ] **Step 2: 加渲染器工厂函数,改 `boot()` 开头**

把:

```ts
async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const { manifest, spritesheetDataUrl } = await window.petApi.getPet()

  const sheet = new Image()
  sheet.src = spritesheetDataUrl
  await sheet.decode()

  const player = new SpritePlayer(canvas, sheet, manifest)
  const controller = new PetController(player)
  await controller.start()
```

改成:

```ts
function createRenderer(canvas: HTMLCanvasElement, source: PetRenderSource): PetRenderer {
  if (source.type === 'sprite') return new SpriteRenderer(canvas)
  // 理论上不可达:主进程的启动守卫(resolveEffectivePetHome)和 switchPet() 的 renderReady
  // 检查都会拦住 live2d 包,Phase 4 之前不会有真实渲染器可用。这里防御性地抛出,由下面
  // boot().catch(showBootError) 现有的错误横幅机制兜住,而不是让类型系统悄悄放过一个死代码路径。
  throw new Error('live2d 渲染器尚未实现(Phase 4)')
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('pet') as HTMLCanvasElement
  const source = await window.petApi.getPet()

  const renderer = createRenderer(canvas, source)
  await renderer.load(source)
  const controller = new PetController(renderer)
  await controller.start()
```

- [ ] **Step 3: 改鼠标穿透判断**

把:

```ts
    setIgnore(!player.isPetPixel(e.clientX, e.clientY))
```

改成:

```ts
    setIgnore(!renderer.hitTest(e.clientX, e.clientY).hit)
```

- [ ] **Step 4: 全项目 typecheck + 全部测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过,没有任何残留的 `SpritePlayer`/`LoadedPet` 引用。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/main.ts
git commit -m "$(cat <<'EOF'
refactor(renderer): main.ts 按 PetRenderSource 判别式选择渲染器

新增 createRenderer() 工厂,sprite 分支构造 SpriteRenderer;live2d
分支防御性抛错(不可达,Phase 4 前有启动守卫拦住)。鼠标点击穿透改用
renderer.hitTest()。
EOF
)"
```

---

### Task 6: 全量回归 + 真机确认

**Files:** 无新增/修改(纯验证任务)。

**Interfaces:** 无。

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 通过,零错误。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部通过(含 Task 1/2/3 新增的用例)。

- [ ] **Step 3: 全量 build**

Run: `pnpm build`
Expected: 三个 bundle(main/preload/renderer)构建成功,无 TS 报错。

- [ ] **Step 4: 真机确认(需要用户在有显示的环境跑,agent 会话无法自动化)**

Run: `pnpm preview`
确认以下均无回归(设计文档已确认 Phase 3 不引入新可视行为,这只是确认重构没破坏现状):
- 宠物正常显示 idle/walk/drag 等动画
- 单击开关对话框,双击 poke 反应
- 拖拽跟手
- 聊天面板点头像热切换宠物,精灵正常重载

- [ ] **Step 5: 确认无遗留 git 状态**

Run: `git status`
Expected: working tree clean(Task 1-5 每步都已提交)。
