import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { loadPet } from './petLoader'

const lulukaDir = resolve(__dirname, '../../pets/luluka')

describe('loadPet', () => {
  it('loads luluka manifest and embeds spritesheet as data url', async () => {
    const pet = await loadPet(lulukaDir)
    expect(pet.manifest.id).toBe('luluka')
    expect(pet.manifest.animations.idle.row).toBe(0)
    expect(pet.spritesheetDataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(pet.spritesheetDataUrl.length).toBeGreaterThan(1000)
  })

  it('throws on a directory without pet.json', async () => {
    await expect(loadPet(resolve(__dirname, '__no_such_pet_dir__'))).rejects.toThrow()
  })
})
