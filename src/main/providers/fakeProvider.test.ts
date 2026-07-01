import { describe, it, expect } from 'vitest'
import { createFakeProvider } from './fakeProvider'
import type { StreamChunk } from '@shared/llm'

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

const req = (signal: AbortSignal) => ({ system: 's', messages: [], maxOutputTokens: 64, signal })

describe('fakeProvider', () => {
  it('streams the reply in order then done', async () => {
    const p = createFakeProvider({ reply: 'abcd', chunkSize: 2 })
    const chunks = await collect(p.streamChat(req(new AbortController().signal)))
    expect(chunks).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'text', text: 'cd' },
      { type: 'done' }
    ])
  })

  it('emits an error chunk when failWith is set', async () => {
    const p = createFakeProvider({ failWith: 'boom' })
    const chunks = await collect(p.streamChat(req(new AbortController().signal)))
    expect(chunks).toEqual([{ type: 'error', message: 'boom' }])
  })

  it('stops early when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = createFakeProvider({ reply: 'abcd', chunkSize: 1 })
    const chunks = await collect(p.streamChat(req(ctrl.signal)))
    expect(chunks).toEqual([]) // aborted before first yield
  })
})
