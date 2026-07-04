import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isValidPetId, listPets } from './petCatalog'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'petcatalog-'))
}

/** 写一个最小合法宠物包目录(pet.json + 占位 spritesheet)。 */
function makePet(root: string, id: string, displayName = id): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    displayName,
    description: `${id} 的描述`,
    spritesheetPath: 'spritesheet.webp',
    sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
    animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
  }
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(dir, 'spritesheet.webp'), 'fake-bytes', 'utf-8')
  return dir
}

describe('isValidPetId', () => {
  it('接受纯字母数字下划线连字符', () => {
    expect(isValidPetId('luluka')).toBe(true)
    expect(isValidPetId('shiraishi-mio')).toBe(true)
    expect(isValidPetId('pet_2')).toBe(true)
  })
  it('拒绝路径分隔/穿越/空/非字符串', () => {
    expect(isValidPetId('../evil')).toBe(false)
    expect(isValidPetId('a/b')).toBe(false)
    expect(isValidPetId('')).toBe(false)
    expect(isValidPetId(123)).toBe(false)
  })
})

describe('listPets', () => {
  it('合并两来源、按 displayName 排序', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'youka', '幽香')
    makePet(user, 'aaa', 'AAA')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['aaa', 'youka'])
    expect(out.find((p) => p.id === 'youka')?.displayName).toBe('幽香')
  })

  it('同 id 去重,userData 优先', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'luluka', '内置露露卡')
    makePet(user, 'luluka', '用户露露卡')
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out).toHaveLength(1)
    expect(out[0].displayName).toBe('用户露露卡')
  })

  it('坏包(pet.json 非法/缺失)跳过,不炸整表', () => {
    const bundled = scratch()
    const user = scratch()
    makePet(bundled, 'good', '好包')
    // 坏包:pet.json 缺 displayName
    const bad = join(bundled, 'bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'pet.json'), JSON.stringify({ id: 'bad' }), 'utf-8')
    // 无 pet.json 的目录
    mkdirSync(join(bundled, 'empty'), { recursive: true })
    const out = listPets({ bundledPetsDir: bundled, userPetsDir: user })
    expect(out.map((p) => p.id)).toEqual(['good'])
  })

  it('来源目录不存在 → 返回空数组不抛', () => {
    const out = listPets({ bundledPetsDir: join(tmpdir(), 'no-such-x'), userPetsDir: join(tmpdir(), 'no-such-y') })
    expect(out).toEqual([])
  })
})
