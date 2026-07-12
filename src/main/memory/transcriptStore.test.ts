import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyTranscript, parseTranscript, appendMessage,
  loadTranscript, saveTranscript, TRANSCRIPT_MAX
} from './transcriptStore'

describe('appendMessage', () => {
  it('追加并递增 totalCount', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi' })
    t = appendMessage(t, { role: 'pet', text: 'yo' })
    expect(t.totalCount).toBe(2)
    expect(t.messages.map((m) => m.text)).toEqual(['hi', 'yo'])
  })
  it('超过上限从头裁剪,totalCount 不回退', () => {
    let t = emptyTranscript()
    for (let i = 0; i < 5; i++) t = appendMessage(t, { role: 'user', text: `m${i}` }, 3)
    expect(t.totalCount).toBe(5)
    expect(t.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4'])
  })
  it('默认上限是 200', () => {
    expect(TRANSCRIPT_MAX).toBe(200)
  })
})

describe('parseTranscript', () => {
  it('坏数据 → 空;非法消息被过滤;totalCount 至少等于 messages 长度', () => {
    expect(parseTranscript('x')).toEqual(emptyTranscript())
    const t = parseTranscript({ totalCount: 1, messages: [{ role: 'user', text: 'a' }, { role: 'ghost', text: 'b' }, null] })
    expect(t.messages).toEqual([{ role: 'user', text: 'a' }])
    expect(t.totalCount).toBe(1)
  })
  it('totalCount 缺失时回退为 messages 长度', () => {
    const t = parseTranscript({ messages: [{ role: 'user', text: 'a' }] })
    expect(t.totalCount).toBe(1)
  })
})

describe('loadTranscript / saveTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tr-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('往返一致;缺失/损坏 → 空', () => {
    const file = join(dir, 'transcript.json')
    expect(loadTranscript(file)).toEqual(emptyTranscript())
    const t = appendMessage(emptyTranscript(), { role: 'user', text: '你好' })
    saveTranscript(file, t)
    expect(loadTranscript(file)).toEqual(t)
    writeFileSync(file, '{broken', 'utf-8')
    expect(loadTranscript(file)).toEqual(emptyTranscript())
  })
})

describe('appendMessage 透传 timestamp', () => {
  it('传入 timestamp 时原样保留', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi', timestamp: 1000 })
    expect(t.messages[0]).toEqual({ role: 'user', text: 'hi', timestamp: 1000 })
  })
  it('未传 timestamp 时不生成该字段', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'user', text: 'hi' })
    expect(t.messages[0]).toEqual({ role: 'user', text: 'hi' })
  })
})

describe('actions 字段(跨回合动作摘要)', () => {
  it('append 保留合法的 actions 数组', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'pet', text: '办好啦', actions: ['weather', 'weather'] })
    expect(t.messages[0].actions).toEqual(['weather', 'weather'])
  })
  it('空数组/非字符串数组不落盘该字段', () => {
    let t = emptyTranscript()
    t = appendMessage(t, { role: 'pet', text: 'a', actions: [] })
    t = appendMessage(t, { role: 'pet', text: 'b', actions: [1, 2] as unknown as string[] })
    expect(t.messages[0].actions).toBeUndefined()
    expect(t.messages[1].actions).toBeUndefined()
  })
  it('parse 往返保留 actions', () => {
    const t = parseTranscript({ messages: [{ role: 'pet', text: 'x', actions: ['web_search'] }] })
    expect(t.messages[0].actions).toEqual(['web_search'])
  })
})

describe('parseTranscript 透传 timestamp', () => {
  it('保留合法 timestamp,非法类型的直接丢弃该字段', () => {
    const t = parseTranscript({
      messages: [
        { role: 'user', text: 'a', timestamp: 123 },
        { role: 'pet', text: 'b', timestamp: 'bad' }
      ]
    })
    expect(t.messages).toEqual([
      { role: 'user', text: 'a', timestamp: 123 },
      { role: 'pet', text: 'b' }
    ])
  })
})
