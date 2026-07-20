import type { ChatMessage, PetSummary, PetChatListItem } from '@shared/ipc'

const PREVIEW_MAX = 20

export function previewOf(msg: ChatMessage | undefined): string | undefined {
  if (!msg) return undefined
  const t = msg.text.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t
}

export interface PetChatListInput {
  pets: PetSummary[]
  activeId: string
  activeMessages: ChatMessage[]
  peekLast: (petId: string) => ChatMessage | undefined
  avatarOf: (petId: string) => string
}

export function buildPetChatList(input: PetChatListInput): PetChatListItem[] {
  return input.pets.map((p) => {
    const last = p.id === input.activeId
      ? input.activeMessages[input.activeMessages.length - 1]
      : input.peekLast(p.id)
    const item: PetChatListItem = {
      id: p.id,
      displayName: p.displayName,
      avatarDataUrl: input.avatarOf(p.id),
      active: p.id === input.activeId
    }
    const preview = previewOf(last)
    if (preview !== undefined) { item.lastMessage = preview; item.lastMessageTime = last?.timestamp }
    return item
  })
}
