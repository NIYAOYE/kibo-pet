export type ProviderKind = 'fake' | 'anthropic' | 'openai-compat'

export interface ImagePart { mimeType: string; dataBase64: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** 仅对 role:'user' 有意义:经预处理的图像;永不持久化 */
  images?: ImagePart[]
}

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolUse { id: string; name: string; input: unknown }

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUse: ToolUse }
  | { type: 'done' }
  | { type: 'error'; message: string }

/**
 * 主进程内核的对话消息:UI 层 ChatTurn 之外,增加工具调用往返两种角色。
 * 工具消息只在主进程流转,渲染层与 transcript 不感知。
 */
export type AgentMessage =
  | ChatTurn
  | { role: 'assistant_tool_use'; text?: string; toolUse: ToolUse }
  | { role: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface ProviderSettings { kind: ProviderKind; baseURL?: string; model: string }

export type SearchBackendKind = 'duckduckgo' | 'tavily'
export interface SearchSettings { backend: SearchBackendKind }

export interface EmbeddingSettings { baseURL: string; model: string }
export interface MemorySettings { embedding: EmbeddingSettings | null }

export const SETTINGS_SCHEMA_VERSION = 4

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null }
}

export interface Preset {
  id: string
  label: string
  kind: ProviderKind
  baseURL?: string
  defaultModel: string
}

/** 首启向导可选的预设;用户仍可改 baseURL/model。 */
export const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', kind: 'anthropic', defaultModel: 'claude-haiku-4-5' },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'qwen', label: '通义千问 (DashScope 兼容)', kind: 'openai-compat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai-compat', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  { id: 'ollama', label: '本地 Ollama', kind: 'openai-compat', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.1' }
]

/**
 * 回填设置窗时把已存 provider 映射回预设下拉:先按 kind + baseURL 精确匹配;匹配不到
 * (如用户用了自定义 baseURL / 中转端点)退回同 kind 的首个预设,保证 provider.kind
 * 不被改错(否则保存时会把 openai-compat 误写成列表首项 anthropic);两者皆无才回退列表首项。
 */
export function resolvePresetId(kind: ProviderKind, baseURL: string | undefined): string {
  const norm = baseURL ?? ''
  const exact = PRESETS.find((p) => p.kind === kind && (p.baseURL ?? '') === norm)
  if (exact) return exact.id
  const byKind = PRESETS.find((p) => p.kind === kind)
  return (byKind ?? PRESETS[0]).id
}
