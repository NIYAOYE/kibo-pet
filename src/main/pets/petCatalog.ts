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
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
}
