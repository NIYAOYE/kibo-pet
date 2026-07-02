import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'
import type { SkillMeta } from '../skills/skillLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

export const WINDOW_TURNS = 12

const MEMORY_PLACEHOLDER = '<!-- 记忆召回:MVP-05 在此注入用户事实/工作记忆摘要 -->'

function skillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  return (
    '\n\n# 可用技能\n' +
    '你有以下技能;当用户的请求匹配某个技能的用途时,先用 read_skill 工具读取它的完整说明再照做:\n' +
    skills.map((s) => `- ${s.name}:${s.description}`).join('\n')
  )
}

export function assemblePrompt(
  persona: PersonaBlocks,
  transcript: ChatMessage[],
  skills: SkillMeta[] = []
): AssembledPrompt {
  const system =
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    skillsSection(skills) +
    '\n\n' + MEMORY_PLACEHOLDER

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
