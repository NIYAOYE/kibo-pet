import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type Live2DManifest } from '@shared/petPackage'
import type { PetSummary, ImportResult, ImportReason } from '@shared/ipc'
import { scanImportSource, isPathSafe } from './importSecurity'
import { readTextureInfos, evaluateTextureBudget } from './live2dTextureBudget'
import {
  listModelFilesRecursive,
  scanAndPatchOrphanResources,
  detectPossibleWatermarkProtection,
  type Model3Json
} from './live2dOrphanResources'

export const STAGING_DIR_NAME = '.staging'
const STAGING_ID_PATTERN = /^[0-9a-f]{16}$/

/** 合法宠物 id:仅字母数字下划线连字符,拒绝路径分隔/穿越。与 config/settings.ts 的正则同源。 */
export function isValidPetId(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
}

/** 读单个宠物目录的 summary;坏包(缺 pet.json / 校验失败)返回 null。
 *  按 render.type 判别式分流到对应解析器。 */
function readSummary(petDir: string): PetSummary | null {
  try {
    const raw = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf-8'))
    if (isLive2DManifestRaw(raw)) {
      const manifest = parseLive2DManifest(raw)
      return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'live2d', renderReady: true }
    }
    const manifest = parsePetManifest(raw)
    return { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'sprite', renderReady: true }
  } catch (e) {
    console.warn('[petCatalog] 跳过坏宠物包', petDir, e)
    return null
  }
}

/** 扫一个 pets 根目录下的所有子目录,产出合法宠物 summary(坏包跳过)。跳过 .staging 临时目录。 */
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

/**
 * 枚举全部可用宠物:合并内置只读包与 userData 包,按 id 去重(userData 优先,
 * 因为内置包首启会被播种到 userData,同 id 视为同一只),按 displayName 排序。
 */
export function listPets(dirs: { bundledPetsDir: string; userPetsDir: string }): PetSummary[] {
  const byId = new Map<string, PetSummary>()
  for (const s of scanDir(dirs.bundledPetsDir)) byId.set(s.id, s)
  for (const s of scanDir(dirs.userPetsDir)) byId.set(s.id, s) // userData 覆盖内置
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
}

/** sprite 包校验链(与改造前逐字节一致),复制到 staging 后打上 v2 标记再交给调用方原子提交。 */
function importSpritePet(
  raw: unknown,
  srcDir: string,
  stagingDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): ImportResult {
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
  try {
    cpSync(srcDir, stagingDir, { recursive: true })
    // 打上 v2 标记(向前兼容,不改变任何已有字段语义)
    const stampedRaw = { ...(raw as Record<string, unknown>), schemaVersion: 2, render: { type: 'sprite' } }
    writeFileSync(join(stagingDir, 'pet.json'), JSON.stringify(stampedRaw, null, 2), 'utf-8')
    const finalDir = join(dirs.userPetsDir, manifest.id)
    renameSync(stagingDir, finalDir)
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: `导入失败:${(e as Error).message}` }
  }
  return {
    ok: true,
    pet: { id: manifest.id, displayName: manifest.displayName, description: manifest.description, renderType: 'sprite', renderReady: true }
  }
}

/**
 * live2d 包专属校验链:render.model / model3.json FileReferences 的每一个外部可控路径都要过
 * isPathSafe 才能拼路径读盘(拒绝路径穿越);随后跑纹理预算 + 游离表情/动作找回 + 水印提示;
 * 全部通过后才复制到 staging、写回补丁后的 model3.json,再交给调用方原子提交。
 */
function importLive2DPet(
  raw: unknown,
  srcDir: string,
  stagingDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): { ok: true; manifest: Live2DManifest; warnings: string[] } | { ok: false; reason: ImportReason; message: string } {
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
  if (!isPathSafe(srcDir, manifest.render.model)) {
    return { ok: false, reason: 'path-traversal', message: `render.model 路径不安全:${manifest.render.model}` }
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
  if (!model3Json || typeof model3Json !== 'object' || !model3Json.FileReferences || typeof model3Json.FileReferences !== 'object') {
    return { ok: false, reason: 'invalid-manifest', message: 'model3.json 缺少 FileReferences 字段' }
  }

  // FileReferences 本身是对象只是第一层保证——它的每个成员字段仍可能被伪造成错误类型
  // (例如 Textures 里塞一个数字)。这些字段在下面会被直接拼进 path.join 或 .map/.flat 里,
  // 类型不对会在 isPathSafe 之前就抛出未捕获的 TypeError,把内部错误堆栈泄漏给调用方而不是
  // 干净的 invalid-manifest——因此必须在这里把形状校验完,而不是留到用到时才发现。
  const fr = model3Json.FileReferences
  const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'
  if (!isOptionalString(fr.Moc) || !isOptionalString(fr.Physics) || !isOptionalString(fr.Pose) || !isOptionalString(fr.DisplayInfo)) {
    return { ok: false, reason: 'invalid-manifest', message: 'model3.json FileReferences 的 Moc/Physics/Pose/DisplayInfo 必须是字符串' }
  }
  if (fr.Textures !== undefined && (!Array.isArray(fr.Textures) || !fr.Textures.every((t: unknown) => typeof t === 'string'))) {
    return { ok: false, reason: 'invalid-manifest', message: 'model3.json FileReferences.Textures 必须是字符串数组' }
  }
  if (
    fr.Expressions !== undefined &&
    (!Array.isArray(fr.Expressions) || !fr.Expressions.every((e: unknown) => e !== null && typeof e === 'object' && typeof (e as { File?: unknown }).File === 'string'))
  ) {
    return { ok: false, reason: 'invalid-manifest', message: 'model3.json FileReferences.Expressions 格式不合法' }
  }
  if (fr.Motions !== undefined) {
    const motionsValid =
      fr.Motions !== null &&
      typeof fr.Motions === 'object' &&
      Object.values(fr.Motions).every(
        (arr: unknown) => Array.isArray(arr) && arr.every((m: unknown) => m !== null && typeof m === 'object' && typeof (m as { File?: unknown }).File === 'string')
      )
    if (!motionsValid) {
      return { ok: false, reason: 'invalid-manifest', message: 'model3.json FileReferences.Motions 格式不合法' }
    }
  }

  const modelDir = dirname(modelJsonSrcPath)

  // model3.json 的 FileReferences 是用户导入包里自带的、未经信任的数据——在拼路径读盘前
  // 必须过一遍 isPathSafe,否则一个精心构造的 "../../../../some/system/file" 就能让
  // 下面的 existsSync/readTextureInfos 读到 modelDir 之外的任意本机文件(路径穿越/信息泄露)。
  const refFiles = [
    model3Json.FileReferences.Moc,
    model3Json.FileReferences.Physics,
    model3Json.FileReferences.Pose,
    model3Json.FileReferences.DisplayInfo,
    ...(model3Json.FileReferences.Textures ?? [])
  ].filter((f): f is string => typeof f === 'string')
  for (const f of refFiles) {
    if (!isPathSafe(modelDir, f)) {
      return { ok: false, reason: 'path-traversal', message: `model3.json 引用的路径不安全:${f}` }
    }
    if (!existsSync(join(modelDir, f))) {
      return { ok: false, reason: 'missing-model-refs', message: `model3.json 引用的文件缺失:${f}` }
    }
  }

  const textureFiles = model3Json.FileReferences.Textures ?? []
  const textureInfos = readTextureInfos(modelDir, textureFiles)
  const budget = evaluateTextureBudget(textureInfos)
  if (budget.hardViolation) {
    return {
      ok: false,
      reason: budget.hardViolation.includes('数量') ? 'too-many-textures' : 'texture-too-large',
      message: budget.hardViolation
    }
  }

  const allModelFiles = listModelFilesRecursive(modelDir)
  const { patchedModel3Json, recoveredExpressionCount, recoveredMotionCount } = scanAndPatchOrphanResources(model3Json, allModelFiles)
  const possibleWatermark = detectPossibleWatermarkProtection(patchedModel3Json)
  const warnings = [...budget.softWarnings]
  if (recoveredExpressionCount > 0 || recoveredMotionCount > 0) {
    warnings.push(`已自动找回 ${recoveredExpressionCount} 个表情文件、${recoveredMotionCount} 个动作文件`)
  }
  if (possibleWatermark) {
    warnings.push('该模型未声明任何动作/表情,可能需要额外处理才能正常显示角色')
  }
  if (manifest.thumbnail) {
    if (!isPathSafe(srcDir, manifest.thumbnail)) {
      return { ok: false, reason: 'path-traversal', message: `thumbnail 路径不安全:${manifest.thumbnail}` }
    }
    if (!existsSync(join(srcDir, manifest.thumbnail))) {
      return { ok: false, reason: 'missing-model-refs', message: `找不到 thumbnail 指向的文件:${manifest.thumbnail}` }
    }
  }

  let finalManifest: Live2DManifest = manifest
  try {
    cpSync(srcDir, stagingDir, { recursive: true })
    const modelJsonStagingPath = join(stagingDir, manifest.render.model)
    writeFileSync(modelJsonStagingPath, JSON.stringify(patchedModel3Json, null, 2), 'utf-8')
    if (possibleWatermark) {
      finalManifest = { ...manifest, render: { ...manifest.render, possibleWatermark: true } }
      writeFileSync(join(stagingDir, 'pet.json'), JSON.stringify(finalManifest, null, 2), 'utf-8')
    }
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: `导入失败:${(e as Error).message}` }
  }

  return { ok: true, manifest: finalManifest, warnings }
}

export type StageImportResult =
  | { ok: true; committed: true; pet: PetSummary; warnings?: string[] }
  | { ok: true; committed: false; stagingId: string; manifest: Live2DManifest; warnings: string[] }
  | { ok: false; reason: ImportReason; message: string }

/**
 * 校验外部宠物文件夹并复制到 `.staging`。sprite 包不经过预览,校验通过后立即原子提交到
 * userData/pets/<id>(`committed:true`);live2d 包停在 staging,等待调用方(设置页预览面板)
 * 调 commitStagedPet()/discardStagedPet() 决定去留(`committed:false`)。任一校验环节失败都
 * 清理 staging 残留,不触碰最终目录。
 */
export function stageImportPet(
  srcDir: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): StageImportResult {
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

  const stagingId = randomBytes(8).toString('hex')
  const stagingDir = join(dirs.userPetsDir, STAGING_DIR_NAME, stagingId)

  if (isLive2DManifestRaw(raw)) {
    const result = importLive2DPet(raw, srcDir, stagingDir, dirs)
    if (!result.ok) {
      rmSync(stagingDir, { recursive: true, force: true })
      return result
    }
    return { ok: true, committed: false, stagingId, manifest: result.manifest, warnings: result.warnings }
  }

  const result: ImportResult = importSpritePet(raw, srcDir, stagingDir, dirs)
  if (!result.ok) {
    rmSync(stagingDir, { recursive: true, force: true })
    return result
  }
  return { ok: true, committed: true, pet: result.pet, warnings: result.warnings }
}

/** 用户在预览面板点"确认导入":把 staging 目录原子移到最终目录。stagingId 必须是
 *  stageImportPet() 返回过的十六进制串(16 个字符),不接受任意路径——防止渲染进程
 *  (信任边界较低的一侧)喂一个精心构造的字符串跑出 .staging 目录之外。 */
export function commitStagedPet(
  stagingId: string,
  manifestId: string,
  dirs: { bundledPetsDir: string; userPetsDir: string }
): { ok: true; pet: PetSummary } | { ok: false; message: string } {
  if (!STAGING_ID_PATTERN.test(stagingId)) return { ok: false, message: '非法的 stagingId' }
  const stagingDir = join(dirs.userPetsDir, STAGING_DIR_NAME, stagingId)
  if (!existsSync(stagingDir)) return { ok: false, message: '预览已过期或已被清理,请重新导入' }
  if (!isValidPetId(manifestId)) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, message: `非法的宠物 id:${manifestId}` }
  }
  const finalDir = join(dirs.userPetsDir, manifestId)
  if (existsSync(join(dirs.bundledPetsDir, manifestId)) || existsSync(finalDir)) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, message: `id「${manifestId}」已存在,请修改宠物包 pet.json 的 id 后重试` }
  }
  try {
    renameSync(stagingDir, finalDir)
  } catch (e) {
    return { ok: false, message: `导入失败:${(e as Error).message}` }
  }
  const pet = readSummary(finalDir)
  if (!pet) return { ok: false, message: '提交后读取宠物包失败' }
  return { ok: true, pet }
}

/** 用户在预览面板点"取消":删掉 staging 目录,不留痕迹。stagingId 校验同 commitStagedPet()。 */
export function discardStagedPet(stagingId: string, userPetsDir: string): void {
  if (!STAGING_ID_PATTERN.test(stagingId)) return
  rmSync(join(userPetsDir, STAGING_DIR_NAME, stagingId), { recursive: true, force: true })
}

/** 应用启动时调用:清掉上次崩溃/中断导入残留的 .staging 子目录(未完整提交的导入不会"复活")。 */
export function cleanupStaleStaging(userPetsDir: string): void {
  const stagingRoot = join(userPetsDir, STAGING_DIR_NAME)
  if (!existsSync(stagingRoot)) return
  for (const name of readdirSync(stagingRoot)) {
    rmSync(join(stagingRoot, name), { recursive: true, force: true })
  }
}
