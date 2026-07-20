import { describe, it, expect } from 'vitest'
import { previewOf, buildPetChatList } from './petChatList'
import type { ChatMessage, PetSummary } from '@shared/ipc'

describe('previewOf', () => {
  it('无消息返回 undefined', () => { expect(previewOf(undefined)).toBeUndefined() })
  it('折叠空白、去首尾空格', () => {
    expect(previewOf({ role: 'pet', text: '  你好\n  世界  ' })).toBe('你好 世界')
  })
  it('超长截断加省略号(20 字上限)', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三'
    expect(previewOf({ role: 'user', text: long })).toBe(long.slice(0, 20) + '…')
  })
  it('纯空白返回 undefined', () => { expect(previewOf({ role: 'pet', text: '   ' })).toBeUndefined() })
})

describe('buildPetChatList', () => {
  const pets: PetSummary[] = [
    { id: 'a', displayName: 'Alpha', description: '' },
    { id: 'b', displayName: 'Bravo', description: '' }
  ]
  it('活跃宠物用 activeMessages 末条,非活跃用 peekLast,active 标记正确', () => {
    const activeMessages: ChatMessage[] = [
      { role: 'user', text: 'hi', timestamp: 100 },
      { role: 'pet', text: '在的', timestamp: 200 }
    ]
    const peekLast = (id: string): ChatMessage | undefined =>
      id === 'b' ? { role: 'pet', text: '好久不见', timestamp: 50 } : undefined
    const avatarOf = (id: string): string => (id === 'a' ? 'data:img-a' : '')
    const out = buildPetChatList({ pets, activeId: 'a', activeMessages, peekLast, avatarOf })
    expect(out).toEqual([
      { id: 'a', displayName: 'Alpha', avatarDataUrl: 'data:img-a', lastMessage: '在的', lastMessageTime: 200, active: true },
      { id: 'b', displayName: 'Bravo', avatarDataUrl: '', lastMessage: '好久不见', lastMessageTime: 50, active: false }
    ])
  })
  it('无历史的宠物 lastMessage/lastMessageTime 为 undefined', () => {
    const out = buildPetChatList({ pets, activeId: 'a', activeMessages: [], peekLast: () => undefined, avatarOf: () => '' })
    expect(out[0].lastMessage).toBeUndefined()
    expect(out[0].lastMessageTime).toBeUndefined()
    expect(out[1].active).toBe(false)
  })
})
