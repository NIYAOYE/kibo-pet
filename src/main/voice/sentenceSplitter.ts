// 换行也算边界:列表/分点内容往往整段没有标点,只靠换行分隔;
// 不切的话会攒成一大块,逐句翻译时既容易超出输出预算被截断,质量也差。
const SENTENCE_END = /[。！？.!?…\n]/

export interface SentenceSplitter {
  /** 喂入一段新的增量文本,返回本次新增的、已经凑齐的完整句子(可能为空数组)。 */
  push(delta: string): string[]
  /** 回复结束时调用:吐出缓冲区里剩下的不完整尾巴(无则返回 null)并清空缓冲区。 */
  flush(): string | null
}

const DIGIT = /[0-9]/

function findBoundary(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i]
    if (!SENTENCE_END.test(ch)) continue
    if (ch === '.' && DIGIT.test(s[i - 1] ?? '')) {
      if (i + 1 >= s.length) continue // 后面还没到,可能是小数点,等更多文本到达再判断
      if (DIGIT.test(s[i + 1])) continue // 前后都是数字 → 小数点,不是句子边界
    }
    return i
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
        const piece = buf.slice(start, idx + 1)
        if (piece.trim().length > 0) out.push(piece) // 空行等纯空白片段没有朗读价值,直接丢弃
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

/** 智能合并模式的默认阈值:攒够这么多可见字符才作为一段吐出。 */
const SMART_MIN_CHARS = 30

/**
 * 智能合并短句:在句子切分的基础上,把切出来的句子先攒着,累计可见字符数
 * 达到阈值才作为一段吐出。零碎的短句/列表行(如"湿度: 68%")单独送去
 * 逐句翻译很不稳定,合并成有上下文的段落后翻译质量和稳定性都明显更好。
 */
export function createSmartSplitter(minChars: number = SMART_MIN_CHARS): SentenceSplitter {
  const inner = createSentenceSplitter()
  let pending = ''
  return {
    push(delta: string): string[] {
      const out: string[] = []
      for (const sentence of inner.push(delta)) {
        pending += sentence
        if (pending.trim().length >= minChars) {
          out.push(pending)
          pending = ''
        }
      }
      return out
    },
    flush(): string | null {
      const rest = pending + (inner.flush() ?? '')
      pending = ''
      return rest.trim().length > 0 ? rest : null
    }
  }
}
