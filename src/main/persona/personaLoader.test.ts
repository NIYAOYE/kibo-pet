import { describe, it, expect } from 'vitest'
import { parsePersona } from './personaLoader'

const md = `# Persona(人设 / 角色)
你是露露卡。

# Voice(语气 / 说话风格)
惜字如金。

# Behavior(行为准则)
先把事办成。

# Tools(对工具的态度)
需要就去查。
`

describe('parsePersona', () => {
  it('splits markdown into the four known blocks by heading keyword', () => {
    const b = parsePersona(md)
    expect(b.persona).toBe('你是露露卡。')
    expect(b.voice).toBe('惜字如金。')
    expect(b.behavior).toBe('先把事办成。')
    expect(b.tools).toBe('需要就去查。')
  })

  it('returns empty strings for missing blocks', () => {
    const b = parsePersona('# Persona\n只有人设。')
    expect(b.persona).toBe('只有人设。')
    expect(b.voice).toBe('')
    expect(b.behavior).toBe('')
    expect(b.tools).toBe('')
  })

  it('认领 Examples 块(few-shot 风格样本)', () => {
    const b = parsePersona(md + '\n# Examples(对话示范)\n用户:你好\n露露卡:唔。\n')
    expect(b.examples).toBe('用户:你好\n露露卡:唔。')
  })

  it('无 Examples 块时 examples 为空字符串', () => {
    const b = parsePersona(md)
    expect(b.examples).toBe('')
  })
})
