import type { ChatMessage, ChatSendPayload } from '@shared/ipc'
import type { AppSettings } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { loadPersona } from '../persona/personaLoader'
import { assemblePrompt } from '../agent/promptAssembler'
import { runAgent } from '../agent/agentLoop'
import { createProvider } from '../providers/createProvider'

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
  loadSettings: () => AppSettings
  getKey: () => string | null
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
}): ChatStore {
  const transcript: ChatMessage[] = []
  let inFlight: AbortController | null = null

  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
  }

  return {
    messages: () => transcript,
    cancel,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      if (!text) return
      cancel() // 新消息取消在途
      transcript.push({ role: 'user', text })
      opts.pushUpdate(transcript)
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        transcript.push({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(transcript)
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const { system, messages } = assemblePrompt(persona, transcript)
      const provider = createProvider(settings.provider, key)

      const ctrl = new AbortController()
      inFlight = ctrl
      let acc = ''
      void runAgent({
        provider,
        system,
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT_MS,
        signal: ctrl.signal,
        onText: (t) => { acc += t; opts.pushStream(t) }
      }).then((res) => {
        if (inFlight === ctrl) inFlight = null
        if (res.canceled) return // 静默丢弃
        if (res.error) {
          opts.pushUpdate(transcript)
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
          return
        }
        transcript.push({ role: 'pet', text: acc })
        opts.pushUpdate(transcript)
        opts.pushDone()
        opts.emitPetEvent('replyDone')
      })
    }
  }
}
