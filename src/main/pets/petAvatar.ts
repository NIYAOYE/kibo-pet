import { nativeImage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { frameRect, parsePetManifest, isLive2DManifestRaw, parseLive2DManifest } from '@shared/petPackage'
import { isPathSafe } from './importSecurity'

const AVATAR_PX = 48

/** userData 包优先(与 listPets 去重口径一致),否则内置只读包。 */
export function resolvePetDir(petId: string, dirs: { bundledPetsDir: string; userPetsDir: string }): string {
  const userDir = join(dirs.userPetsDir, petId)
  return existsSync(join(userDir, 'pet.json')) ? userDir : join(dirs.bundledPetsDir, petId)
}

/** 从宠物包裁小圆头像的 data URL,按源文件 mtime 缓存。
 *  自定义头像(manifest.customAvatar,用户在对话框头像上点出来导入的)优先于两种包类型
 *  各自的默认头像来源。
 *  sprite 包:裁 spritesheet 的 idle 首帧。
 *  live2d 包:读 manifest.thumbnail 静态图(若提供);无该字段则没有头像可裁。
 *  webp/图片解码失败、缺 idle 动画、缺 thumbnail 字段 → 返回 ''(渲染层退回色块占位)。 */
export function createPetAvatarCache(): { avatarOf: (petDir: string, petId: string) => string } {
  const cache = new Map<string, { mtimeMs: number; url: string }>()
  return {
    avatarOf(petDir, petId) {
      try {
        const manifestPath = join(petDir, 'pet.json')
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        const customAvatar = typeof raw?.customAvatar === 'string' ? raw.customAvatar : undefined
        if (customAvatar) {
          // 同一份 isPathSafe 防御纵深:customAvatar 是我们自己写入 pet.json 的,但读取时
          // 仍按外部输入对待(万一 pet.json 被手工改过),和 thumbnail/spritesheetPath 一致。
          if (!isPathSafe(petDir, customAvatar)) {
            throw new Error(`customAvatar 路径不安全:${customAvatar}`)
          }
          const avatarPath = join(petDir, customAvatar)
          const mtimeMs = statSync(avatarPath).mtimeMs
          const hit = cache.get(petId)
          if (hit && hit.mtimeMs === mtimeMs) return hit.url
          const img = nativeImage.createFromPath(avatarPath)
          if (img.isEmpty()) { cache.set(petId, { mtimeMs, url: '' }); return '' }
          const url = img.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'good' }).toDataURL()
          cache.set(petId, { mtimeMs, url })
          return url
        }
        if (isLive2DManifestRaw(raw)) {
          const manifest = parseLive2DManifest(raw)
          if (!manifest.thumbnail) return ''
          // 防御纵深(C-1 第二道关卡):裁头像给宠物选择器每一个已列出的宠物都会跑一次,单是
          // "打开宠物选择器"就会触发读取。import 时(petCatalog.ts importLive2DPet)已经校验
          // 过 thumbnail,这里再补一道是防一份已经落地/被手工改过的 pet.json——不合法就走下面
          // 统一的 catch,和这个函数里其它失败模式(解码失败/缺字段)一致地退回 ''。
          if (!isPathSafe(petDir, manifest.thumbnail)) {
            throw new Error(`thumbnail 路径不安全:${manifest.thumbnail}`)
          }
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
        // 防御纵深(C-1 第二道关卡,同上——本函数的 sprite 分支同理)。
        if (!isPathSafe(petDir, manifest.spritesheetPath)) {
          throw new Error(`spritesheetPath 路径不安全:${manifest.spritesheetPath}`)
        }
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
