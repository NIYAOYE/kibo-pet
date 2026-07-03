import { join } from 'node:path'
import type { ChatMessage } from '@shared/ipc'
import type { LlmProvider } from '../providers/llmProvider'
import type { Embedder } from '../providers/embedder'
import { WINDOW_TURNS } from '../agent/promptAssembler'
import { loadFacts, saveFacts, upsertFact, newFactId, type FactsFile } from './factStore'
import { loadIndexFor, saveIndex, missingFactIds, topKFactIds, upsertVectors } from './vectorIndex'
import { loadTranscript, saveTranscript, appendMessage as appendToTranscript, type TranscriptFile } from './transcriptStore'
import {
  loadSummary, saveSummary, overflowRange, summarize,
  SUMMARY_TIMEOUT_MS, type SummaryFile
} from './workingSummary'

export const RECALL_TOP_K = 5
export const RECALL_THRESHOLD = 0.3
export const DEGRADED_RECENT = 10
export const EMBED_TIMEOUT_MS = 10000

export interface RecallResult { facts: string[]; summary?: string }

export interface MemoryManager {
  messages(): ChatMessage[]
  appendMessage(msg: ChatMessage): void
  saveFact(text: string): { text: string; deduped: boolean }
  recall(query: string, signal: AbortSignal): Promise<RecallResult>
  maybeSummarize(makeProvider: () => LlmProvider | null): void
}

/**
 * 记忆门面:facts/vector-index/summary/transcript 四文件的唯一编排者。
 * 原则(§5.6):记忆链路任何故障都不阻断对话主链路——recall 永不抛,退化返回。
 */
export function createMemoryManager(opts: {
  dir: string
  getEmbedder: () => Embedder | null
  now?: () => Date
}): MemoryManager {
  const factsFile = join(opts.dir, 'facts.json')
  const indexFile = join(opts.dir, 'vector-index.json')
  const summaryFile = join(opts.dir, 'summary.json')
  const transcriptFile = join(opts.dir, 'transcript.json')
  const now = opts.now ?? (() => new Date())

  let facts: FactsFile = loadFacts(factsFile)
  let transcript: TranscriptFile = loadTranscript(transcriptFile)
  let summary: SummaryFile = loadSummary(summaryFile)
  let summarizing = false

  function degradedFacts(): string[] {
    return [...facts.facts]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, DEGRADED_RECENT)
      .map((f) => f.text)
  }

  function withSummary(list: string[]): RecallResult {
    return summary.text ? { facts: list, summary: summary.text } : { facts: list }
  }

  return {
    messages: () => transcript.messages,

    appendMessage(msg) {
      transcript = appendToTranscript(transcript, msg)
      try { saveTranscript(transcriptFile, transcript) } catch (e) { console.warn('[memory] transcript 写盘失败', e) }
    },

    saveFact(text) {
      const r = upsertFact(facts, text, now().toISOString(), newFactId())
      facts = r.file
      saveFacts(factsFile, facts) // 抛错交给工具 registry 转 isError
      return { text: r.fact.text, deduped: r.deduped }
    },

    async recall(query, signal) {
      const embedder = opts.getEmbedder()
      if (!embedder || facts.facts.length === 0) return withSummary(degradedFacts())
      // 独立超时 + 外部取消桥接(同 agentLoop 模式)
      const internal = new AbortController()
      const onAbort = (): void => internal.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => internal.abort(), EMBED_TIMEOUT_MS)
      try {
        let index = loadIndexFor(indexFile, embedder.model)
        const byId = new Map(facts.facts.map((f) => [f.id, f.text]))
        const missing = missingFactIds([...byId.keys()], index)
        if (missing.length > 0) {
          const vectors = await embedder.embed(missing.map((id) => byId.get(id) ?? ''), internal.signal)
          index = upsertVectors(index, missing.map((factId, i) => ({ factId, vector: vectors[i] })))
          saveIndex(indexFile, index)
        }
        const [qv] = await embedder.embed([query], internal.signal)
        const ids = topKFactIds(qv, index.entries, RECALL_TOP_K, RECALL_THRESHOLD)
        return withSummary(ids.map((id) => byId.get(id)).filter((t): t is string => !!t))
      } catch {
        return withSummary(degradedFacts()) // 静默退化,绝不阻断对话
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },

    maybeSummarize(makeProvider) {
      if (summarizing) return
      const range = overflowRange(
        { totalCount: transcript.totalCount, messagesLen: transcript.messages.length },
        summary.coveredCount,
        WINDOW_TURNS
      )
      if (!range) return
      const provider = makeProvider()
      if (!provider) return
      summarizing = true
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS)
      const slice = transcript.messages.slice(range.start, range.end)
      void summarize({ provider, prevSummary: summary.text, messages: slice, signal: ctrl.signal })
        .then((text) => {
          if (text) {
            summary = { schemaVersion: 1, text, coveredCount: range.newCoveredCount, updatedAt: now().toISOString() }
            saveSummary(summaryFile, summary)
          }
        })
        .catch(() => { /* 保留旧摘要,下次再试 */ })
        .finally(() => { clearTimeout(timer); summarizing = false })
    }
  }
}
