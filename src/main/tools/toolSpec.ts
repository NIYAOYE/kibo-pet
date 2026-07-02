import type { ToolDef } from '@shared/llm'

export interface ToolContext {
  signal: AbortSignal
  /** 工具自行播报进行中的状态(如「正在搜索:xxx」);安静工具不调 */
  onStatus?: (text: string) => void
}

export interface ToolSpec extends ToolDef {
  run(input: unknown, ctx: ToolContext): Promise<string>
}
