import type { ToolDef } from '@shared/llm'
import type { ToolSpec, ToolContext } from './toolSpec'

export interface ToolRunResult { content: string; isError?: boolean }

export interface ToolRegistry {
  defs(): ToolDef[]
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolRunResult>
}

/**
 * 轻量入参校验(required + 顶层属性类型),不引 ajv:
 * 工具入参都是模型生成的浅层对象,深层校验交给工具自身。
 */
export function validateInput(input: unknown, schema: Record<string, unknown>): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '入参必须是 JSON 对象'
  const obj = input as Record<string, unknown>
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>
  for (const key of ((schema.required as string[] | undefined) ?? [])) {
    if (obj[key] === undefined || obj[key] === null) return `缺少必填参数 ${key}`
  }
  for (const [key, value] of Object.entries(obj)) {
    const t = props[key]?.type
    if (value === undefined || value === null) continue
    if (t === 'string' && typeof value !== 'string') return `参数 ${key} 应为字符串`
    if (t === 'number' && typeof value !== 'number') return `参数 ${key} 应为数字`
    if (t === 'boolean' && typeof value !== 'boolean') return `参数 ${key} 应为布尔值`
  }
  return null
}

/** 未知工具 / 参数不合法 / 工具抛错都转为 isError 文本回灌给模型,绝不向 agent 循环抛异常。 */
export function createToolRegistry(tools: ToolSpec[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.name, t]))
  return {
    defs: () => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async run(name, input, ctx) {
      const tool = byName.get(name)
      if (!tool) return { isError: true, content: `未知工具:${name}。可用工具:${[...byName.keys()].join('、')}` }
      const err = validateInput(input, tool.inputSchema)
      if (err) return { isError: true, content: `参数不合法:${err}` }
      try {
        return { content: await tool.run(input, ctx) }
      } catch (e) {
        return { isError: true, content: `工具执行失败:${String((e as Error)?.message ?? e)}` }
      }
    }
  }
}
