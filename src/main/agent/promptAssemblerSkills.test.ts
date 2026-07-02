import { describe, it, expect } from 'vitest'
import { assemblePrompt } from './promptAssembler'
import type { PersonaBlocks } from '../persona/personaLoader'

const persona: PersonaBlocks = { persona: '# Persona\n小精灵', voice: '', behavior: '', tools: '' }

describe('assemblePrompt 技能清单', () => {
  it('有技能:system 含清单段与 read_skill 指引,置于 persona 之后', () => {
    const { system } = assemblePrompt(persona, [], [
      { name: 'web-summary', description: '搜索并总结话题' }
    ])
    expect(system).toContain('# 可用技能')
    expect(system).toContain('- web-summary:搜索并总结话题')
    expect(system).toContain('read_skill')
    expect(system.indexOf('小精灵')).toBeLessThan(system.indexOf('# 可用技能'))
  })

  it('无技能(空数组/缺省):不出现清单段,行为与 MVP-03 相同', () => {
    expect(assemblePrompt(persona, [], []).system).not.toContain('# 可用技能')
    expect(assemblePrompt(persona, []).system).not.toContain('# 可用技能')
  })
})
