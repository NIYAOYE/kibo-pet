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
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string }

/**
 * 主进程内核的对话消息:UI 层 ChatTurn 之外,增加工具调用往返两种角色。
 * 工具消息只在主进程流转,渲染层与 transcript 不感知。
 */
export type AgentMessage =
  | ChatTurn
  | { role: 'assistant_tool_use'; text?: string; toolUse: ToolUse }
  | { role: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: ImagePart[] }

export interface ProviderSettings { kind: ProviderKind; baseURL?: string; model: string }

export type SearchBackendKind = 'duckduckgo' | 'tavily'
export interface SearchSettings { backend: SearchBackendKind }

export interface EmbeddingSettings { baseURL: string; model: string }
export interface MemorySettings { embedding: EmbeddingSettings | null }

export interface TextToolsSettings { autoCopyResult: boolean }

export interface FirecrawlSettings { enabled: boolean; baseURL?: string }

export interface DesktopControlSettings { enabled: boolean }

export type BrowserControlMode = 'isolated' | 'cdp'
/** chromePath:独立实例模式下可选的自定义 Chrome 可执行文件路径,绕开 Playwright 的
 *  channel:'chrome' 自动探测——该探测在 Windows 上优先检查 %LOCALAPPDATA%,若用户机器上
 *  同时存在一个损坏的 per-user 安装和一个能用的系统级安装,会优先选中坏的那个且无法察觉
 *  (只做存在性检查,不检查是否真的能启动)。留空则维持原有自动探测行为。 */
export interface BrowserControlSettings { enabled: boolean; mode: BrowserControlMode; chromePath?: string }

export type TtsDevice = 'auto' | 'cuda' | 'cpu'
export type TtsTargetLanguage = 'auto' | 'zh' | 'ja' | 'en'
export type TtsPlaybackTrigger = 'batch' | 'stream'
export type TtsSynthesisChunking = 'token' | 'sentence'
/** 边生成边播放时,朗读文本的切分方案:sentence=逐句立即朗读(开口最快);smart=短句攒到最小长度再朗读(逐句翻译更稳、不易漏读)。 */
export type TtsTextSplit = 'sentence' | 'smart'

export interface TtsSettings {
  enabled: boolean
  /** 语音运行时(可移植 Python + 依赖)安装位置;空字符串 = 未配置 */
  runtimeInstallPath: string
  device: TtsDevice
  useFlashAttn: boolean
  targetLanguage: TtsTargetLanguage
  playbackTrigger: TtsPlaybackTrigger
  synthesisChunking: TtsSynthesisChunking
  textSplit: TtsTextSplit
  isCutText: boolean
  cutMinLen: number
  cutMute: number
  speed: number
  noiseScale: number
  temperature: number
  topK: number
  topP: number
  repetitionPenalty: number
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  runtimeInstallPath: '',
  device: 'auto',
  useFlashAttn: false,
  targetLanguage: 'auto',
  playbackTrigger: 'batch',
  synthesisChunking: 'sentence',
  textSplit: 'smart',
  isCutText: true,
  cutMinLen: 10,
  cutMute: 0.3,
  speed: 1,
  noiseScale: 0.5,
  temperature: 1,
  topK: 15,
  topP: 1,
  repetitionPenalty: 1.35
}

export const SETTINGS_SCHEMA_VERSION = 10

export interface AppSettings { schemaVersion: number; activePetId: string; provider: ProviderSettings; search: SearchSettings; memory: MemorySettings; textTools: TextToolsSettings; firecrawl: FirecrawlSettings; desktopControl: DesktopControlSettings; browserControl: BrowserControlSettings; tts: TtsSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  activePetId: 'luluka',
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  tts: DEFAULT_TTS_SETTINGS
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
