import { describe, it, expect } from 'vitest'
import { assemblePrompt, WINDOW_TURNS } from './promptAssembler'
import type { ChatMessage } from '@shared/ipc'

const persona = { persona: 'P', voice: 'V', behavior: 'B', tools: 'T' }

describe('assemblePrompt', () => {
  it('joins persona blocks in order into system, with a memory placeholder', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system.startsWith('P\n\nV\n\nB\n\nT')).toBe(true)
    expect(system).toContain('MVP-05') // 记忆占位注释
  })

  it('maps pet->assistant / user->user and truncates to the window', () => {
    const transcript: ChatMessage[] = []
    for (let i = 0; i < WINDOW_TURNS + 4; i++) {
      transcript.push({ role: i % 2 === 0 ? 'user' : 'pet', text: `m${i}` })
    }
    const { messages } = assemblePrompt(persona, transcript)
    expect(messages.length).toBeLessThanOrEqual(WINDOW_TURNS)
    expect(messages[0].role).toBe('user') // 窗口首条必须是 user
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true)
  })

  it('drops a leading assistant turn so messages start with user', () => {
    const transcript: ChatMessage[] = [
      { role: 'pet', text: 'hi' },
      { role: 'user', text: 'hello' }
    ]
    const { messages } = assemblePrompt(persona, transcript)
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('skips empty persona blocks', () => {
    const { system } = assemblePrompt({ persona: 'P', voice: '', behavior: '', tools: '' }, [])
    expect(system.startsWith('P\n\n<!--')).toBe(true)
  })
})
