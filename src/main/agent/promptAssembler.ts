import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'
import type { SkillMeta } from '../skills/skillLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

/** 召回的记忆上下文;memoryManager.RecallResult 结构兼容 */
export interface MemoryContext { facts: string[]; summary?: string }

export const WINDOW_TURNS = 12

function skillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  return (
    '\n\n# 可用技能\n' +
    '你有以下技能;当用户的请求匹配某个技能的用途时,先用 read_skill 工具读取它的完整说明再照做:\n' +
    skills.map((s) => `- ${s.name}:${s.description}`).join('\n')
  )
}

/** §5.4:[人设分块]+[召回的长期记忆]+[工作记忆摘要],记忆为空时对应小节整体省略 */
function memorySection(memory?: MemoryContext): string {
  if (!memory) return ''
  let out = ''
  if (memory.facts.length > 0) {
    out +=
      '\n\n# 关于用户的记忆\n以下是你之前记住的关于用户的事实,回答时自然地用上,不要生硬复述:\n' +
      memory.facts.map((f) => `- ${f}`).join('\n')
  }
  if (memory.summary) out += `\n\n# 上次对话摘要\n${memory.summary}`
  return out
}

export function assemblePrompt(
  persona: PersonaBlocks,
  transcript: ChatMessage[],
  skills: SkillMeta[] = [],
  memory?: MemoryContext
): AssembledPrompt {
  const system =
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    skillsSection(skills) +
    memorySection(memory)

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
