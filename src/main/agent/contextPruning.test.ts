import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@shared/llm'
import { pruneStaleImages, KEEP_RECENT_IMAGES, STALE_IMAGE_NOTE } from './contextPruning'

const img = (tag: string): { mimeType: string; dataBase64: string } => ({
  mimeType: 'image/png',
  dataBase64: `data-${tag}`
})

const shotResult = (id: string, tag: string): AgentMessage => ({
  role: 'tool_result',
  toolUseId: id,
  content: `已截屏 ${tag}`,
  images: [img(tag)]
})

describe('pruneStaleImages', () => {
  it('带图 tool_result 不超过保留数时不做任何改动', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '帮我点一下' },
      shotResult('t1', 'a'),
      shotResult('t2', 'b')
    ]
    pruneStaleImages(messages, 2)
    expect((messages[1] as { images?: unknown[] }).images).toHaveLength(1)
    expect((messages[2] as { images?: unknown[] }).images).toHaveLength(1)
    expect((messages[1] as { content: string }).content).toBe('已截屏 a')
  })

  it('超过保留数时剥离最早的图片并追加过期占位,保留最近的', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '多步任务' },
      shotResult('t1', 'a'),
      shotResult('t2', 'b'),
      shotResult('t3', 'c')
    ]
    pruneStaleImages(messages, 2)
    const oldest = messages[1] as { content: string; images?: unknown[] }
    expect(oldest.images).toBeUndefined()
    expect(oldest.content).toContain('已截屏 a')
    expect(oldest.content).toContain(STALE_IMAGE_NOTE)
    expect((messages[2] as { images?: unknown[] }).images).toHaveLength(1)
    expect((messages[3] as { images?: unknown[] }).images).toHaveLength(1)
  })

  it('幂等:重复裁剪不会重复追加占位文本', () => {
    const messages: AgentMessage[] = [shotResult('t1', 'a'), shotResult('t2', 'b'), shotResult('t3', 'c')]
    pruneStaleImages(messages, 2)
    pruneStaleImages(messages, 2)
    const oldest = messages[0] as { content: string }
    const occurrences = oldest.content.split(STALE_IMAGE_NOTE).length - 1
    expect(occurrences).toBe(1)
  })

  it('持续增长的对话里,继续裁剪会淘汰新的"最早带图结果"', () => {
    const messages: AgentMessage[] = [shotResult('t1', 'a'), shotResult('t2', 'b'), shotResult('t3', 'c')]
    pruneStaleImages(messages, 2)
    messages.push(shotResult('t4', 'd'))
    pruneStaleImages(messages, 2)
    expect((messages[0] as { images?: unknown[] }).images).toBeUndefined()
    expect((messages[1] as { images?: unknown[] }).images).toBeUndefined()
    expect((messages[2] as { images?: unknown[] }).images).toHaveLength(1)
    expect((messages[3] as { images?: unknown[] }).images).toHaveLength(1)
  })

  it('不动 user 消息上的图片(当前回合的用户附图)', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '看这张图', images: [img('u')] },
      shotResult('t1', 'a'),
      shotResult('t2', 'b'),
      shotResult('t3', 'c')
    ]
    pruneStaleImages(messages, 2)
    expect((messages[0] as { images?: unknown[] }).images).toHaveLength(1)
  })

  it('不带图的 tool_result 不受影响、也不计入保留名额', () => {
    const messages: AgentMessage[] = [
      { role: 'tool_result', toolUseId: 't0', content: '已点击' },
      shotResult('t1', 'a'),
      { role: 'tool_result', toolUseId: 't2', content: '已输入文字' },
      shotResult('t3', 'b')
    ]
    pruneStaleImages(messages, 2)
    expect((messages[0] as { content: string }).content).toBe('已点击')
    expect((messages[1] as { images?: unknown[] }).images).toHaveLength(1)
    expect((messages[3] as { images?: unknown[] }).images).toHaveLength(1)
  })

  it('默认保留数导出为常量', () => {
    expect(KEEP_RECENT_IMAGES).toBeGreaterThanOrEqual(1)
  })
})
