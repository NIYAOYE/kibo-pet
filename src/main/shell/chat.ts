import type { ChatMessage, ChatSendPayload, ChatSendAttachment } from '@shared/ipc'
import type { AppSettings, ProviderSettings, ImagePart } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { loadPersona } from '../persona/personaLoader'
import { assemblePrompt } from '../agent/promptAssembler'
import { runAgent } from '../agent/agentLoop'
import { createProvider } from '../providers/createProvider'
import type { LlmProvider } from '../providers/llmProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import { createWebSearchTool } from '../tools/webSearch'
import { createReadSkillTool } from '../tools/readSkill'
import { createSaveMemoryTool } from '../tools/saveMemory'
import { createDuckDuckGoBackend } from '../tools/searchBackends/duckduckgo'
import { createTavilyBackend } from '../tools/searchBackends/tavily'
import type { SkillIndex } from '../skills/skillLoader'
import type { MemoryManager } from '../memory/memoryManager'

const TIMEOUT_MS = 60000
const MAX_OUTPUT_TOKENS = 1024
const UNCONFIGURED_REPLY = '(还没接上大脑)先在托盘「设置」里选好 Provider 并填 API Key 吧~我已帮你打开设置。'

export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
  cancel(): void
}

export function createChatStore(opts: {
  petDir: string
  skills: SkillIndex
  memory: MemoryManager
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  /** 测试注入缝;生产默认 createProvider */
  makeProvider?: (provider: ProviderSettings, key: string) => LlmProvider
  /** 主进程注入的图像预处理(chat.ts 不 import electron;测试注入直通实现) */
  prepareImages: (attachments: ChatSendAttachment[]) => ImagePart[]
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushStatus: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
}): ChatStore {
  const make = opts.makeProvider ?? createProvider
  let inFlight: AbortController | null = null

  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
  }

  return {
    messages: () => opts.memory.messages(),
    cancel,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      const rawAtts = payload?.attachments ?? []
      const hasImages = rawAtts.length > 0
      if (!text && !hasImages) return
      cancel() // 新消息取消在途

      // 单一预处理点:注入的 prepareImages 产出最终 ImagePart(图片永不落盘)
      const images: ImagePart[] = hasImages ? opts.prepareImages(rawAtts) : []
      // transcript 只存文本占位 + 标记;带图时前缀 [图片],让后续文本窗口知道这轮有图
      const storedText = hasImages ? (text ? `[图片] ${text}` : '[图片]') : text
      opts.memory.appendMessage(
        hasImages
          ? { role: 'user', text: storedText, attachments: rawAtts.map(() => ({ kind: 'image' as const })) }
          : { role: 'user', text: storedText }
      )
      opts.pushUpdate(opts.memory.messages())
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        opts.memory.appendMessage({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(opts.memory.messages())
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const provider = make(settings.provider, key)
      // 每次发送按当前设置构建后端与工具(设置可能在两次发送之间变更)
      const backend = settings.search.backend === 'tavily'
        ? createTavilyBackend(() => opts.getSearchKey())
        : createDuckDuckGoBackend()
      const registry = createToolRegistry([
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t))
      ])

      const ctrl = new AbortController()
      inFlight = ctrl
      let acc = ''
      void (async () => {
        // 召回在 runAgent 之前;recall 永不抛(内部退化),取消则直接放弃
        const recalled = await opts.memory.recall(text, ctrl.signal)
        if (ctrl.signal.aborted) return
        const { system, messages } = assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled)
        // 图挂当前回合:窗口末条即刚追加的 user 消息(assemblePrompt 已裁到 user 起头)
        const lastUser = messages[messages.length - 1]
        if (images.length > 0 && lastUser && lastUser.role === 'user') lastUser.images = images
        const res = await runAgent({
          provider,
          system,
          messages,
          registry,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          signal: ctrl.signal,
          onText: (t) => { acc += t; opts.pushStream(t) },
          onStatus: (t) => opts.pushStatus(t)
        })
        if (inFlight === ctrl) inFlight = null
        if (res.canceled) return // 静默丢弃
        if (res.error) {
          // 有部分文本(如轮数上限)时先落 transcript,再报错
          if (acc) opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
        } else {
          opts.memory.appendMessage({ role: 'pet', text: acc })
          opts.pushUpdate(opts.memory.messages())
          opts.pushDone()
          opts.emitPetEvent('replyDone')
        }
        // 回复收尾后检查滚动摘要(异步后台,不阻塞下一条)
        opts.memory.maybeSummarize(() => {
          const k = opts.getKey()
          return k ? make(settings.provider, k) : null
        })
      })()
    }
  }
}
