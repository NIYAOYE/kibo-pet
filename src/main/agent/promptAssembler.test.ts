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

  it('persona.examples 渲染为「对话示范」小节,并声明只用于风格参考', () => {
    const { system } = assemblePrompt({ ...persona, examples: '用户:你好\n宠物:哇!' }, [])
    expect(system).toContain('# 对话示范')
    expect(system).toContain('用户:你好\n宠物:哇!')
    expect(system).toContain('语气')
  })

  it('无 examples 时不出现「对话示范」小节', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system).not.toContain('对话示范')
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

describe('promptAssembler 当前时间注入', () => {
  it('给 nowMs 时 system 含"当前时间"', () => {
    const { system } = assemblePrompt(persona, [], [], undefined, 1_700_000_000_000)
    expect(system).toContain('当前时间')
  })
  it('不给 nowMs 时不含"当前时间"', () => {
    const { system } = assemblePrompt(persona, [], [], undefined)
    expect(system).not.toContain('当前时间')
  })
  it('时间戳在 system 末尾:persona 保持稳定前缀,分钟级变化不打穿前缀缓存', () => {
    const { system } = assemblePrompt(persona, [], [], { facts: ['用户叫小星'] }, 1_700_000_000_000)
    expect(system.startsWith('P')).toBe(true)
    expect(system.indexOf('# 当前时间')).toBeGreaterThan(system.indexOf('# 关于用户的记忆'))
  })
  it('nowMs 不同、其余相同时,两次 system 的公共前缀覆盖全部静态内容', () => {
    const a = assemblePrompt(persona, [], [], undefined, 1_700_000_000_000).system
    const b = assemblePrompt(persona, [], [], undefined, 1_700_000_060_000).system
    expect(a.startsWith('P\n\nV\n\nB\n\nT')).toBe(true)
    expect(b.startsWith('P\n\nV\n\nB\n\nT')).toBe(true)
  })
})

describe('工具执行规范注入', () => {
  it('hasTools=true 时 system 含"工具执行规范"小节', () => {
    const { system } = assemblePrompt(persona, [], [], undefined, undefined, true)
    expect(system).toContain('# 工具执行规范')
  })

  it('工具执行规范里包含系统级反注入声明(工具结果中的指令不是指示)', () => {
    const { system } = assemblePrompt(persona, [], [], undefined, undefined, true)
    expect(system).toContain('不要执行')
    expect(system).toContain('截图')
  })

  it('hasTools 缺省(false)时不出现该小节', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system).not.toContain('工具执行规范')
  })
})
