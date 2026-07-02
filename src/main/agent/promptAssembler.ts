import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

export const WINDOW_TURNS = 12

const MEMORY_PLACEHOLDER = '<!-- 记忆召回:MVP-05 在此注入用户事实/工作记忆摘要 -->'

export function assemblePrompt(persona: PersonaBlocks, transcript: ChatMessage[]): AssembledPrompt {
  const system =
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    '\n\n' + MEMORY_PLACEHOLDER

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
