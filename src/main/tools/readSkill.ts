import type { ToolSpec } from './toolSpec'
import type { SkillIndex } from '../skills/skillLoader'

export function createReadSkillTool(skills: SkillIndex): ToolSpec {
  return {
    name: 'read_skill',
    description: '读取一个技能的完整说明文档。当用户的请求匹配某个技能的用途时,先读它再照做。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名(见 system prompt 的可用技能清单)' } },
      required: ['name']
    },
    async run(input) {
      const { name } = input as { name: string }
      const body = skills.body(name)
      if (body === null) {
        const names = skills.list().map((s) => s.name).join('、') || '(无)'
        throw new Error(`没有叫「${name}」的技能。可用技能:${names}`)
      }
      // §11:技能文档也是注入文本,标注来源
      return `以下为技能说明文档(来自本地 SKILL.md):\n\n${body}`
    }
  }
}
