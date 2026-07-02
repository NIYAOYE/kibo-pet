import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SkillMeta { name: string; description: string }

export interface SkillIndex {
  list(): SkillMeta[]
  body(name: string): string | null
}

/**
 * 解析 SKILL.md:YAML frontmatter(--- 包围)里取 name/description(单行 key: value,
 * 手写解析不引 yaml 库),其余为正文。缺任一必填字段视为无效返回 null。
 */
export function parseSkillMd(md: string): { meta: SkillMeta; body: string } | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  if (!fm.name || !fm.description) return null
  return { meta: { name: fm.name, description: fm.description }, body: m[2].trim() }
}

/** 启动时扫描 skills 目录;坏文件跳过记 warning,目录缺失退化为空清单,绝不拖垮启动。 */
export function loadSkills(skillsDir: string): SkillIndex {
  const skills = new Map<string, { meta: SkillMeta; body: string }>()
  let entries: string[] = []
  try { entries = readdirSync(skillsDir) } catch { /* 目录不存在 → 无技能 */ }
  for (const entry of entries) {
    const file = join(skillsDir, entry, 'SKILL.md')
    let md: string
    try { md = readFileSync(file, 'utf-8') } catch { continue } // 无 SKILL.md 的子目录/文件,跳过
    const parsed = parseSkillMd(md)
    if (parsed) skills.set(parsed.meta.name, parsed)
    else console.warn(`[skills] 跳过无效 SKILL.md(缺 frontmatter 的 name/description):${file}`)
  }
  return {
    list: () => [...skills.values()].map((s) => s.meta),
    body: (name) => skills.get(name)?.body ?? null
  }
}
