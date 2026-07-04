import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isValidPetId, listPets, importPetFolder } from './petCatalog'

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

describe('importPetFolder', () => {
  it('合法包 → 复制到 userPetsDir/<id> 并返回 summary', () => {
    const src = scratch()
    const user = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'newpet', '新宠物')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: user })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pet).toEqual({ id: 'newpet', displayName: '新宠物', description: 'newpet 的描述' })
    expect(existsSync(join(user, 'newpet', 'pet.json'))).toBe(true)
    expect(existsSync(join(user, 'newpet', 'spritesheet.webp'))).toBe(true)
  })

  it('缺 pet.json → no-manifest,不复制', () => {
    const src = scratch()
    const user = scratch()
    mkdirSync(join(src, 'x'), { recursive: true })
    const r = importPetFolder(join(src, 'x'), { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'no-manifest' })
  })

  it('pet.json 字段不合法 → invalid-manifest', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id: 'x' }), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'invalid-manifest' })
  })

  it('spritesheet 缺失 → missing-spritesheet', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: 'x', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'missing-spritesheet' })
  })

  it('id 含路径穿越 → bad-id', () => {
    const src = scratch()
    const dir = join(src, 'x'); mkdirSync(dir, { recursive: true })
    const manifest = {
      id: '../evil', displayName: 'X', description: 'd', spritesheetPath: 'spritesheet.webp',
      sheet: { rows: 13, cols: 8, cellWidth: 192, cellHeight: 208 },
      animations: { idle: { row: 0, frames: 4, fps: 6, loop: true } }
    }
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(manifest), 'utf-8')
    writeFileSync(join(dir, 'spritesheet.webp'), 'x', 'utf-8')
    const r = importPetFolder(dir, { bundledPetsDir: scratch(), userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  it('id 与 userData 已有宠物冲突 → id-exists,不覆盖', () => {
    const src = scratch()
    const user = scratch()
    const petSrc = makePet(src, 'dup', '导入版')
    makePet(user, 'dup', '原有版') // userData 已存在
    const r = importPetFolder(petSrc, { bundledPetsDir: scratch(), userPetsDir: user })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
    // 原有目录未被覆盖
    const kept = JSON.parse(readFileSync(join(user, 'dup', 'pet.json'), 'utf-8'))
    expect(kept.displayName).toBe('原有版')
  })

  it('id 与内置宠物冲突 → id-exists', () => {
    const src = scratch()
    const bundled = scratch()
    const petSrc = makePet(src, 'youka', '导入幽香')
    makePet(bundled, 'youka', '内置幽香')
    const r = importPetFolder(petSrc, { bundledPetsDir: bundled, userPetsDir: scratch() })
    expect(r).toMatchObject({ ok: false, reason: 'id-exists' })
  })
})
