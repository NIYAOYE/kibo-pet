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
