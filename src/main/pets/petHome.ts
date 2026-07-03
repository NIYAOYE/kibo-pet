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
