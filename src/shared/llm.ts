export type ProviderKind = 'fake' | 'anthropic' | 'openai-compat'

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ProviderSettings { kind: ProviderKind; baseURL?: string; model: string }

export const SETTINGS_SCHEMA_VERSION = 1

export interface AppSettings { schemaVersion: number; provider: ProviderSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' }
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
