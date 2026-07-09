import { describe, it, expect } from 'vitest'
import type { TtsLanguage } from '@shared/llm'
import { parseLines, pickLine, resolveLineText, type Line } from './linesLoader'

describe('parseLines', () => {
  it('解析合法台词表并跳过 _about 元数据', () => {
    const raw = JSON.stringify({
      _about: '说明',
      idle: [{ text: 'a' }, { text: 'b', audio: 'voice/b.wav' }],
      click: [{ text: 'c' }]
    })
    const t = parseLines(raw)
    expect(t.idle).toEqual([{ text: 'a' }, { text: 'b', audio: 'voice/b.wav' }])
    expect(t.click).toEqual([{ text: 'c' }])
    expect((t as Record<string, unknown>)._about).toBeUndefined()
  })

  it('坏 JSON → 空表', () => {
    expect(parseLines('{ not json')).toEqual({})
  })

  it('跳过非数组值与缺 text 的条目', () => {
    const raw = JSON.stringify({ idle: 'x', wake: [{ nope: 1 }, { text: 'ok' }] })
    const t = parseLines(raw)
    expect(t.idle).toBeUndefined()
    expect(t.wake).toEqual([{ text: 'ok' }])
  })
})

describe('pickLine', () => {
  const table = { idle: [{ text: 'a' }, { text: 'b' }] }
  it('空/缺 category → null', () => {
    expect(pickLine({}, 'idle')).toBeNull()
    expect(pickLine(table, 'click')).toBeNull()
  })
  it('rng 决定选中项', () => {
    expect(pickLine(table, 'idle', undefined, () => 0)).toEqual({ text: 'a' })
    expect(pickLine(table, 'idle', undefined, () => 0.99)).toEqual({ text: 'b' })
  })
  it('avoidText 时避开上一句', () => {
    expect(pickLine(table, 'idle', 'a', () => 0)).toEqual({ text: 'b' })
  })
  it('只有一条时即便命中 avoidText 也返回它', () => {
    expect(pickLine({ idle: [{ text: 'a' }] }, 'idle', 'a')).toEqual({ text: 'a' })
  })
})

describe('parseLines 多语言字段', () => {
  it('解析 text_ja/text_en', () => {
    const raw = JSON.stringify({ idle: [{ text: '早安', text_ja: 'おはよう', text_en: 'Good morning' }] })
    const t = parseLines(raw)
    expect(t.idle).toEqual([{ text: '早安', text_ja: 'おはよう', text_en: 'Good morning' }])
  })
  it('缺 text_ja/text_en 时不产出这两个 key(而不是 undefined 占位)', () => {
    const t = parseLines(JSON.stringify({ idle: [{ text: '早安' }] }))
    expect(t.idle![0]).toEqual({ text: '早安' })
    expect('text_ja' in t.idle![0]).toBe(false)
  })
})

describe('resolveLineText', () => {
  it('zh 直接用 text', () => {
    expect(resolveLineText({ text: '早安', text_ja: 'おはよう' }, 'zh')).toBe('早安')
  })
  it('ja 有 text_ja 时用它', () => {
    expect(resolveLineText({ text: '早安', text_ja: 'おはよう' }, 'ja')).toBe('おはよう')
  })
  it('ja 缺 text_ja 时回退 text(硬读中文原文)', () => {
    expect(resolveLineText({ text: '早安' }, 'ja')).toBe('早安')
  })
  it('en 有 text_en 时用它,缺则回退 text', () => {
    expect(resolveLineText({ text: '早安', text_en: 'Good morning' }, 'en')).toBe('Good morning')
    expect(resolveLineText({ text: '早安' }, 'en')).toBe('早安')
  })
})
