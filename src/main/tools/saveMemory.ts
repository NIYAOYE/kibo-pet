import type { ToolSpec } from './toolSpec'

/**
 * 长期记忆写入工具:saveFact 由外部注入(memoryManager.saveFact),
 * 本模块不碰文件系统;抛错交给 registry 转 isError 回灌。
 */
export function createSaveMemoryTool(
  saveFact: (text: string) => { text: string; deduped: boolean }
): ToolSpec {
  return {
    name: 'save_memory',
    description:
      '把关于用户的一条稳定事实、偏好或重要事件记进长期记忆(如「用户叫小星」「用户爱吃冰淇淋」)。' +
      'text 要简洁、自包含;临时话题或一次性问题不要记。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要记住的一条事实,简洁自包含' } },
      required: ['text']
    },
    async run(input, ctx) {
      const { text } = input as { text: string }
      const trimmed = text.trim()
      if (!trimmed) throw new Error('text 不能为空')
      const r = saveFact(trimmed)
      ctx.onStatus?.(`记住了:${r.text}`)
      return r.deduped ? `这条已经记过了,已更新时间:${r.text}` : `已记住:${r.text}`
    }
  }
}
