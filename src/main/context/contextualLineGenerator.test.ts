import { describe, it, expect } from 'vitest'
import { generateContextualLine } from './contextualLineGenerator'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { StreamChunk } from '@shared/llm'

describe('generateContextualLine', () => {
  it('正常返回单行文本(掐头去尾空白)', async () => {
    const provider = createFakeProvider({ reply: '  又在摸鱼啦～  ' })
    const result = await generateContextualLine({
      personaText: '你是一只毒舌猫娘',
      processName: 'chrome.exe',
      windowTitle: 'Bilibili',
      provider
    })
    expect(result).toBe('又在摸鱼啦～')
  })

  it('provider 返回 error chunk → null', async () => {
    const provider = createFakeProvider({ failWith: '网络错误' })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider
    })
    expect(result).toBeNull()
  })

  it('空结果(reply 为空字符串) → null', async () => {
    const provider = createFakeProvider({ reply: '' })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider
    })
    expect(result).toBeNull()
  })

  it('超时 → null', async () => {
    const provider = createFakeProvider({ reply: 'hi', chunkSize: 1, delayMs: 150 })
    const result = await generateContextualLine({
      personaText: 'x', processName: 'a.exe', windowTitle: 'b', provider, timeoutMs: 20
    })
    expect(result).toBeNull()
  })

  it('system prompt 包含 persona 文本与固定的"一句话"指令,user content 带上应用名/窗口标题', async () => {
    let captured: StreamChatRequest | null = null
    const provider: LlmProvider = {
      async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
        captured = req
        yield { type: 'text', text: '好' }
        yield { type: 'done' }
      }
    }
    await generateContextualLine({
      personaText: '你是一只毒舌猫娘', processName: 'code.exe', windowTitle: 'main.ts', provider
    })
    expect(captured!.system).toContain('你是一只毒舌猫娘')
    expect(captured!.system).toContain('不要加引号')
    expect(captured!.messages[0]).toEqual({ role: 'user', content: '用户刚切换到：code.exe / main.ts' })
  })
})
