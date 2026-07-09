import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactionCategory } from '@shared/reactionPlanner'
import type { TtsLanguage } from '@shared/llm'

export interface Line { text: string; text_ja?: string; text_en?: string; audio?: string }
export type LinesTable = Partial<Record<ReactionCategory, Line[]>> & { greet?: Line[] }

export function parseLines(raw: string): LinesTable {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return {} }
  if (typeof data !== 'object' || data === null) return {}
  const out: Record<string, Line[]> = {}
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith('_')) continue // 跳过 _about 等元数据键
    if (!Array.isArray(val)) continue
    const lines: Line[] = []
    for (const item of val) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec.text !== 'string') continue
      const line: Line = { text: rec.text }
      if (typeof rec.text_ja === 'string') line.text_ja = rec.text_ja
      if (typeof rec.text_en === 'string') line.text_en = rec.text_en
      if (typeof rec.audio === 'string') line.audio = rec.audio
      lines.push(line)
    }
    if (lines.length > 0) out[key] = lines
  }
  return out as LinesTable
}

const cache = new Map<string, LinesTable>()

export function loadLines(petDir: string): LinesTable {
  const cached = cache.get(petDir)
  if (cached) return cached
  let table: LinesTable
  try { table = parseLines(readFileSync(join(petDir, 'lines.json'), 'utf-8')) }
  catch { table = {} }
  cache.set(petDir, table)
  return table
}

export function pickLine(
  table: LinesTable,
  category: ReactionCategory,
  avoidText?: string,
  rng: () => number = Math.random
): Line | null {
  const lines = table[category]
  if (!lines || lines.length === 0) return null
  const pool = lines.length > 1 && avoidText ? lines.filter((l) => l.text !== avoidText) : lines
  const candidates = pool.length > 0 ? pool : lines
  return candidates[Math.floor(rng() * candidates.length)] ?? null
}

/** 按朗读语言取台词文案;缺对应语言字段时回退中文原文(硬读,不现场翻译)。 */
export function resolveLineText(line: Line, language: TtsLanguage): string {
  if (language === 'ja' && line.text_ja) return line.text_ja
  if (language === 'en' && line.text_en) return line.text_en
  return line.text
}
