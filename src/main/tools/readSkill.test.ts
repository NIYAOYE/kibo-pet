import { describe, it, expect } from 'vitest'
import { createReadSkillTool } from './readSkill'
import type { SkillIndex } from '../skills/skillLoader'

const skills: SkillIndex = {
  list: () => [{ name: 'web-summary', description: '总结话题' }],
  body: (name) => (name === 'web-summary' ? '# 用法\n先搜再总结。' : null)
}
const ctx = { signal: new AbortController().signal }

describe('createReadSkillTool', () => {
  const tool = createReadSkillTool(skills)

  it('声明:名字 read_skill,name 必填', () => {
    expect(tool.name).toBe('read_skill')
    expect(tool.inputSchema.required as string[]).toContain('name')
  })

  it('返回正文并带来源标注', async () => {
    const out = await tool.run({ name: 'web-summary' }, ctx)
    expect(out).toContain('技能说明文档')
    expect(out).toContain('先搜再总结')
  })

  it('未知技能名抛错并列出可用技能(registry 转 isError 回灌)', async () => {
    await expect(tool.run({ name: 'nope' }, ctx)).rejects.toThrow(/web-summary/)
  })
})
