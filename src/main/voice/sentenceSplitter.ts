const SENTENCE_END = /[。！？.!?…]/

export interface SentenceSplitter {
  /** 喂入一段新的增量文本,返回本次新增的、已经凑齐的完整句子(可能为空数组)。 */
  push(delta: string): string[]
  /** 回复结束时调用:吐出缓冲区里剩下的不完整尾巴(无则返回 null)并清空缓冲区。 */
  flush(): string | null
}

function findBoundary(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (SENTENCE_END.test(s[i])) return i
  }
  return -1
}

export function createSentenceSplitter(): SentenceSplitter {
  let buf = ''
  return {
    push(delta: string): string[] {
      buf += delta
      const out: string[] = []
      let start = 0
      while (start < buf.length) {
        const idx = findBoundary(buf, start)
        if (idx === -1) break
        out.push(buf.slice(start, idx + 1))
        start = idx + 1
      }
      buf = buf.slice(start)
      return out
    },
    flush(): string | null {
      const rest = buf
      buf = ''
      return rest.trim().length > 0 ? rest : null
    }
  }
}
