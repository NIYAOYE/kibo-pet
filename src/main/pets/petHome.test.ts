import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensurePetHome } from './petHome'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pethome-'))
}
function makeBundledPet(root: string, id: string): string {
  const dir = join(root, 'pets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id }), 'utf-8')
  writeFileSync(join(dir, 'persona.md'), '# Persona\n原始人设', 'utf-8')
  return join(root, 'pets')
}

describe('ensurePetHome', () => {
  it('petHome 不存在 → 从内置包整包复制', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const { petHome, memoryDir } = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka' })
    expect(existsSync(join(petHome, 'pet.json'))).toBe(true)
    expect(existsSync(join(petHome, 'persona.md'))).toBe(true)
    expect(memoryDir).toBe(join(petHome, 'memory'))
  })

  it('petHome 已存在 → 不覆盖用户改动(幂等)', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const petHome = join(userDataDir, 'pets', 'luluka')
    mkdirSync(petHome, { recursive: true })
    writeFileSync(join(petHome, 'persona.md'), '# Persona\n用户改过的人设', 'utf-8')
    ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka' })
    expect(readFileSync(join(petHome, 'persona.md'), 'utf-8')).toContain('用户改过的人设')
  })

  it('旧全局 memory 存在且新位置无 → 迁移进宠物家目录', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '[]', 'utf-8')
    const { memoryDir } = ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka', legacyMemoryDir })
    expect(existsSync(join(memoryDir, 'facts.json'))).toBe(true)
    expect(existsSync(legacyMemoryDir)).toBe(false)
  })

  it('新位置已有 memory → 不迁移旧全局', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    const bundledPetsDir = makeBundledPet(bundledRoot, 'luluka')
    const petHome = join(userDataDir, 'pets', 'luluka')
    mkdirSync(join(petHome, 'memory'), { recursive: true })
    writeFileSync(join(petHome, 'memory', 'facts.json'), '["new"]', 'utf-8')
    const legacyMemoryDir = join(userDataDir, 'memory')
    mkdirSync(legacyMemoryDir, { recursive: true })
    writeFileSync(join(legacyMemoryDir, 'facts.json'), '["old"]', 'utf-8')
    ensurePetHome({ userDataDir, bundledPetsDir, activePetId: 'luluka', legacyMemoryDir })
    expect(readFileSync(join(petHome, 'memory', 'facts.json'), 'utf-8')).toBe('["new"]')
    expect(existsSync(legacyMemoryDir)).toBe(true)
  })

  it('内置包缺失该宠物 → 抛明确错误', () => {
    const userDataDir = scratch()
    const bundledRoot = scratch()
    mkdirSync(join(bundledRoot, 'pets'), { recursive: true })
    expect(() => ensurePetHome({ userDataDir, bundledPetsDir: join(bundledRoot, 'pets'), activePetId: 'ghost' }))
      .toThrow(/not found/i)
  })
})
