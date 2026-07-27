import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

// `require('electron')` under plain vitest (not the real Electron binary) resolves to a
// path string, not the API surface — `nativeImage` would be `undefined` in every test file.
// Mock just enough of it here so this test verifies petAvatar.ts's own branching/caching
// logic (which live2d/sprite path it takes, what it does with the result), not Electron's
// real PNG decoding — consistent with this codebase's convention that Electron-native-API
// behavior itself is verified by running the app, not vitest (see CLAUDE.md).
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (_path: string) => ({
      isEmpty: () => false,
      resize: (_opts: unknown) => ({ toDataURL: () => 'data:image/png;base64,ZmFrZQ==' }),
      crop: (_rect: unknown) => ({
        resize: (_opts: unknown) => ({ toDataURL: () => 'data:image/png;base64,ZmFrZQ==' })
      })
    })
  }
}))

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

  // 防御纵深(C-1 第二道关卡的另一处触发点):裁头像给宠物选择器每一个已列出的宠物都会跑
  // 一次,单是"打开宠物选择器"就会触发读取——即便一份恶意/被篡改过的 pet.json 绕过了
  // import 时的校验、直接落到了 petDir 里,这里也不能无条件读盘。
  it('live2d 包 thumbnail 路径穿越出 petDir → 返回空字符串,不读取外部文件(即便穿越目标真实存在)', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    const outsideDir = scratch()
    const outsideFile = join(outsideDir, 'secret.png')
    writeFileSync(outsideFile, fakePngBytes())
    const traversalRelPath = relative(dir, outsideFile)
    const manifest = {
      schemaVersion: 2, id: 'w', displayName: 'W', description: 'd', thumbnail: traversalRelPath,
      render: { type: 'live2d', model: 'model/w.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'w')).toBe('')
  })
})

describe('createPetAvatarCache — customAvatar 优先分支', () => {
  it('customAvatar 存在且有效时优先于 sprite idle 首帧,返回非空 data URL', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'sheet.webp'), fakePngBytes())
    writeFileSync(join(dir, 'avatar-custom.png'), fakePngBytes())
    const manifest = {
      id: 'c1', displayName: 'C1', description: 'd', spritesheetPath: 'sheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } },
      customAvatar: 'avatar-custom.png'
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'c1')).toMatch(/^data:image\/png;base64,/)
  })

  it('customAvatar 存在且有效时优先于 live2d thumbnail,返回非空 data URL', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'model'), { recursive: true })
    writeFileSync(join(dir, 'thumbnail.png'), fakePngBytes())
    writeFileSync(join(dir, 'avatar-custom.png'), fakePngBytes())
    const manifest = {
      schemaVersion: 2, id: 'c2', displayName: 'C2', description: 'd', thumbnail: 'thumbnail.png',
      customAvatar: 'avatar-custom.png',
      render: { type: 'live2d', model: 'model/c2.model3.json', viewport: { width: 1, height: 1, resolutionCap: 1 },
        transform: { scale: 1, offsetX: 0, offsetY: 0, anchorX: 0, anchorY: 0, bubbleAnchorX: 0, bubbleAnchorY: 0 },
        interaction: { mirrorOnWalk: false, mouseTracking: false, lipSyncParameter: 'p' }, stateMap: {} }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'c2')).toMatch(/^data:image\/png;base64,/)
  })

  it('customAvatar 路径穿越出 petDir → 返回空字符串,不读取外部文件(即便穿越目标真实存在)', () => {
    const dir = scratch()
    const outsideDir = scratch()
    const outsideFile = join(outsideDir, 'secret.png')
    writeFileSync(outsideFile, fakePngBytes())
    const traversalRelPath = relative(dir, outsideFile)
    const manifest = {
      id: 'c3', displayName: 'C3', description: 'd', spritesheetPath: 'sheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } },
      customAvatar: traversalRelPath
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'c3')).toBe('')
  })
})

describe('createPetAvatarCache — sprite spritesheet 分支', () => {
  it('spritesheetPath 路径穿越出 petDir → 返回空字符串,不读取外部文件(即便穿越目标真实存在)', () => {
    const dir = scratch()
    const outsideDir = scratch()
    const outsideFile = join(outsideDir, 'secret.webp')
    writeFileSync(outsideFile, fakePngBytes())
    const traversalRelPath = relative(dir, outsideFile)
    const manifest = {
      id: 'z', displayName: 'Z', description: 'd', spritesheetPath: traversalRelPath,
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const cache = createPetAvatarCache()
    expect(cache.avatarOf(dir, 'z')).toBe('')
  })
})
