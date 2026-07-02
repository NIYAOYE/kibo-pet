import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMd, loadSkills } from './skillLoader'

const VALID = `---
name: web-summary
description: 搜索并总结一个话题
---

# 用法

先搜再总结。`

describe('parseSkillMd', () => {
  it('解析 frontmatter 的 name/description 与正文', () => {
    const parsed = parseSkillMd(VALID)
    expect(parsed?.meta).toEqual({ name: 'web-summary', description: '搜索并总结一个话题' })
    expect(parsed?.body).toContain('# 用法')
    expect(parsed?.body).not.toContain('---')
  })
  it('CRLF 换行同样解析(Windows 仓库常见)', () => {
    expect(parseSkillMd(VALID.replace(/\n/g, '\r\n'))?.meta.name).toBe('web-summary')
  })
  it('缺 frontmatter / 缺 name 或 description 返回 null', () => {
    expect(parseSkillMd('# 没有 frontmatter')).toBeNull()
    expect(parseSkillMd('---\nname: x\n---\n正文')).toBeNull()
  })
})

describe('loadSkills', () => {
  const dirs: string[] = []
  const makeDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'pet-skills-')); dirs.push(d); return d }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('扫描目录:list 出清单,body 取正文', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'web-summary'))
    writeFileSync(join(dir, 'web-summary', 'SKILL.md'), VALID, 'utf-8')
    const idx = loadSkills(dir)
    expect(idx.list()).toEqual([{ name: 'web-summary', description: '搜索并总结一个话题' }])
    expect(idx.body('web-summary')).toContain('先搜再总结')
    expect(idx.body('nope')).toBeNull()
  })

  it('坏 SKILL.md 跳过不拖垮;没有 SKILL.md 的子目录忽略', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'SKILL.md'), '没有 frontmatter', 'utf-8')
    mkdirSync(join(dir, 'empty-dir'))
    mkdirSync(join(dir, 'good'))
    writeFileSync(join(dir, 'good', 'SKILL.md'), VALID, 'utf-8')
    expect(loadSkills(dir).list()).toHaveLength(1)
  })

  it('目录不存在 → 空清单(功能退化为无技能,不抛)', () => {
    const idx = loadSkills(join(tmpdir(), 'definitely-missing-skills-dir'))
    expect(idx.list()).toEqual([])
    expect(idx.body('any')).toBeNull()
  })
})
