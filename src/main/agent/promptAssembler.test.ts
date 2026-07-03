import { describe, it, expect } from 'vitest'
import { assemblePrompt, WINDOW_TURNS } from './promptAssembler'
import type { ChatMessage } from '@shared/ipc'

const persona = { persona: 'P', voice: 'V', behavior: 'B', tools: 'T' }

describe('assemblePrompt', () => {
  it('joins persona blocks in order into system', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system).toBe('P\n\nV\n\nB\n\nT')
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
    expect(system).toBe('P')
  })
})

describe('memory 注入', () => {
  it('facts 渲染为「关于用户的记忆」小节', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: ['用户叫小星', '用户爱吃冰淇淋'] })
    expect(system).toContain('# 关于用户的记忆')
    expect(system).toContain('- 用户叫小星')
    expect(system).toContain('- 用户爱吃冰淇淋')
    expect(system).not.toContain('# 上次对话摘要')
  })
  it('summary 渲染为「上次对话摘要」小节', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: [], summary: '上次聊到考研。' })
    expect(system).toContain('# 上次对话摘要\n上次聊到考研。')
    expect(system).not.toContain('# 关于用户的记忆')
  })
  it('无记忆时不出现记忆小节与占位注释', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: [] })
    expect(system).not.toContain('记忆')
    expect(system).not.toContain('<!--')
  })
})
