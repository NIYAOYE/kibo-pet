import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PersonaBlocks { persona: string; voice: string; behavior: string; tools: string }

function keyFor(heading: string): keyof PersonaBlocks | null {
  const h = heading.toLowerCase()
  if (h.includes('persona')) return 'persona'
  if (h.includes('voice')) return 'voice'
  if (h.includes('behavior')) return 'behavior'
  if (h.includes('tools')) return 'tools'
  return null
}

export function parsePersona(md: string): PersonaBlocks {
  const blocks: PersonaBlocks = { persona: '', voice: '', behavior: '', tools: '' }
  let current: keyof PersonaBlocks | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (current) blocks[current] = buf.join('\n').trim()
    buf = []
  }
  for (const line of md.split(/\r?\n/)) {
    const m = /^#\s+(.*)$/.exec(line)
    if (m) { flush(); current = keyFor(m[1]); continue }
    if (current) buf.push(line)
  }
  flush()
  return blocks
}

const cache = new Map<string, PersonaBlocks>()

export function loadPersona(petDir: string): PersonaBlocks {
  const cached = cache.get(petDir)
  if (cached) return cached
  let blocks: PersonaBlocks
  try {
    blocks = parsePersona(readFileSync(join(petDir, 'persona.md'), 'utf-8'))
  } catch {
    blocks = { persona: '', voice: '', behavior: '', tools: '' }
  }
  cache.set(petDir, blocks)
  return blocks
}
