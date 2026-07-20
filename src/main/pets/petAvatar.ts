import { nativeImage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { frameRect, parsePetManifest } from '@shared/petPackage'

const AVATAR_PX = 48

/** userData 包优先(与 listPets 去重口径一致),否则内置只读包。 */
export function resolvePetDir(petId: string, dirs: { bundledPetsDir: string; userPetsDir: string }): string {
  const userDir = join(dirs.userPetsDir, petId)
  return existsSync(join(userDir, 'pet.json')) ? userDir : join(dirs.bundledPetsDir, petId)
}

/** 从宠物 spritesheet 裁 idle 首帧成小圆头像的 data URL;按 spritesheet mtime 缓存。
 *  webp 解码失败(某些平台 nativeImage 不支持)或缺 idle 动画 → 返回 ''(渲染层退回色块占位)。 */
export function createPetAvatarCache(): { avatarOf: (petDir: string, petId: string) => string } {
  const cache = new Map<string, { mtimeMs: number; url: string }>()
  return {
    avatarOf(petDir, petId) {
      try {
        const manifestPath = join(petDir, 'pet.json')
        const manifest = parsePetManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
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
