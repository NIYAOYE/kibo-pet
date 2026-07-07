import { describe, it, expect } from 'vitest'
import { parseLines, pickLine } from './linesLoader'

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
