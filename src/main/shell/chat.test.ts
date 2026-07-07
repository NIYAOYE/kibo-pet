import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatStore, buildQuickActionPreview, MAX_CLIPBOARD_CHARS } from './chat'
import { createMemoryManager } from '../memory/memoryManager'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { AppSettings } from '@shared/llm'
import type { TodoStore } from '../todos/todoStore'

const settings: AppSettings = {
  schemaVersion: 3,
  activePetId: 'luluka',
  provider: { kind: 'fake', model: 'fake' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false }
}

function recording(inner: LlmProvider, seen: StreamChatRequest[]): LlmProvider {
  return { streamChat: (req) => { seen.push(req); return inner.streamChat(req) } }
}

let dir: string
let firecrawlKey: string | null = null
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-')); firecrawlKey = null })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeStore(provider: LlmProvider, seen: StreamChatRequest[], clip?: { readText?: () => string; writeText?: (t: string) => void }) {
  const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
  const written: string[] = []
  let done: () => void = () => {}
  const finished = new Promise<void>((r) => { done = r })
  const store = createChatStore({
    petDir: join(dir, 'no-pet'), // persona 缺失退化为空,无碍
    skills: { list: () => [], body: () => null },
    memory,
    todoStore: {
      list: () => [],
      add: (i) => ({ id: 'x', title: i.title, createdAt: 0, dueAt: i.dueAt, done: false, doneAt: null, firedAt: null }),
      toggleDone: () => null,
      remove: () => false,
      markFired: () => {},
      onChange: () => () => {}
    } as TodoStore,
    loadSettings: () => settings,
    getKey: () => 'k',
    getSearchKey: () => null,
    getFirecrawlKey: () => firecrawlKey,
    makeProvider: () => recording(provider, seen),
    prepareImages: (atts) => atts.map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 })),
    clipboard: { readText: clip?.readText ?? (() => ''), writeText: clip?.writeText ?? ((t) => { written.push(t) }) },
    emitPetEvent: () => {},
    pushUpdate: () => {},
    pushStream: () => {},
    pushStatus: () => {},
    pushDone: () => done(),
    pushError: () => done(),
    openSettings: () => {}
  })
  return { store, memory, finished, written }
}

describe('chat 记忆管道(集成:fake provider + 退化召回)', () => {
  it('召回的事实注入 system;user/pet 消息都持久化', async () => {
    const seen: StreamChatRequest[] = []
    const { store, memory, finished } = makeStore(createFakeProvider({ reply: '你好小星!' }), seen)
    memory.saveFact('用户叫小星')
    store.handleSend({ text: '你好' })
    await finished
    expect(seen[0].system).toContain('# 关于用户的记忆')
    expect(seen[0].system).toContain('用户叫小星')
    const t = JSON.parse(readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8'))
    expect(t.messages.map((m: { text: string }) => m.text)).toEqual(['你好', '你好小星!'])
  })

  it('模型调 save_memory → 事实落盘 facts.json', async () => {
    const seen: StreamChatRequest[] = []
    const provider = createFakeProvider({
      script: [
        [{ type: 'tool_use', toolUse: { id: 't1', name: 'save_memory', input: { text: '用户爱吃冰淇淋' } } }],
        [{ type: 'text', text: '记好啦!' }, { type: 'done' }]
      ]
    })
    const { store, finished } = makeStore(provider, seen)
    store.handleSend({ text: '我爱吃冰淇淋,记住哦' })
    await finished
    const facts = JSON.parse(readFileSync(join(dir, 'memory', 'facts.json'), 'utf-8'))
    expect(facts.facts.map((f: { text: string }) => f.text)).toEqual(['用户爱吃冰淇淋'])
  })

  it('save_memory 工具在 registry 中注册(defs 传给 provider)', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name)).toContain('save_memory')
  })

  it('firecrawl 关闭时不挂载 read_url/extract_from_url(即便有 key)', async () => {
    settings.firecrawl = { enabled: false }
    firecrawlKey = 'k'
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    const names = seen[0].tools?.map((t) => t.name) ?? []
    expect(names).not.toContain('read_url')
    expect(names).not.toContain('extract_from_url')
  })

  it('firecrawl 启用且有 key 时挂载两个工具', async () => {
    settings.firecrawl = { enabled: true }
    firecrawlKey = 'k'
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    const names = seen[0].tools?.map((t) => t.name) ?? []
    expect(names).toContain('read_url')
    expect(names).toContain('extract_from_url')
    settings.firecrawl = { enabled: false } // 复位,避免影响其它用例
  })

  it('firecrawl 启用但无 key 时不挂载', async () => {
    settings.firecrawl = { enabled: true }
    firecrawlKey = null
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    const names = seen[0].tools?.map((t) => t.name) ?? []
    expect(names).not.toContain('read_url')
    expect(names).not.toContain('extract_from_url')
    settings.firecrawl = { enabled: false } // 复位,避免影响其它用例
  })

  it('重启(重建 store)后 messages 恢复', async () => {
    const seen: StreamChatRequest[] = []
    const first = makeStore(createFakeProvider({ reply: '好' }), seen)
    first.store.handleSend({ text: '第一句' })
    await first.finished
    const second = makeStore(createFakeProvider({ reply: '好' }), [])
    expect(second.store.messages().map((m) => m.text)).toEqual(['第一句', '好'])
  })
})

describe('chat 图像', () => {
  const att = { kind: 'image' as const, mimeType: 'image/jpeg', dataBase64: 'QUJD' }

  it('图挂在当前 user 回合,传给 provider', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: '看到啦' }), seen)
    store.handleSend({ text: '这是什么', attachments: [att] })
    await finished
    const last = seen[0].messages[seen[0].messages.length - 1]
    expect(last.role).toBe('user')
    expect((last as { images?: unknown[] }).images?.length).toBe(1)
  })

  it('transcript 用户回合存 [图片] 前缀,不含 base64', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '看看', attachments: [att] })
    await finished
    const raw = readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8')
    expect(raw).not.toContain('QUJD')
    const t = JSON.parse(raw)
    expect(t.messages[0].text).toBe('[图片] 看看')
  })

  it('纯图(空文字)也能发送', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '', attachments: [att] })
    await finished
    expect(seen.length).toBe(1)
  })

  it('无文字无图直接忽略', () => {
    const seen: StreamChatRequest[] = []
    const { store } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: '   ' })
    expect(seen.length).toBe(0)
  })
})

describe('MVP-08 runQuickAction', () => {
  it('buildQuickActionPreview 生成占位:label + 截断预览', () => {
    expect(buildQuickActionPreview('总结要点', 'a'.repeat(50))).toBe(`【总结要点】${'a'.repeat(20)}…`)
    expect(buildQuickActionPreview('翻译', '短')).toBe('【翻译】短')
  })

  it('剪贴板空 → 报错,不发起模型调用', async () => {
    const seen: StreamChatRequest[] = []
    const { store } = makeStore(createFakeProvider({ reply: 'x' }), seen, { readText: () => '' })
    store.runQuickAction('translate')
    expect(seen.length).toBe(0)
  })

  it('剪贴板原文喂当轮 prompt,但 transcript 只存占位(不含原文)', async () => {
    const seen: StreamChatRequest[] = []
    // 原文刻意 > 20 字(buildQuickActionPreview 的截断阈值),否则短原文会被整段保留进占位符,
    // 使"不含原文"断言恒假——这是本计划先前的一处测试数据缺陷,已在实现阶段发现并修正。
    const original = `需要翻译的原文${'Z'.repeat(20)}`
    const { store, finished } = makeStore(createFakeProvider({ reply: '译文' }), seen, { readText: () => original })
    store.runQuickAction('translate')
    await finished
    const last = seen[0].messages[seen[0].messages.length - 1] as { role: string; content: string }
    expect(last.content).toContain(original)                     // 喂给模型:完整原文
    const raw = readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8')
    expect(raw).not.toContain(original)                           // 不落盘:完整原文不出现
    expect(raw).toContain('【翻译(中↔英)】')                     // 占位在
  })

  it('autoCopyResult 开启时把结果写回剪贴板', async () => {
    settings.textTools = { autoCopyResult: true }
    const seen: StreamChatRequest[] = []
    const { store, finished, written } = makeStore(createFakeProvider({ reply: '译文结果' }), seen, { readText: () => 'hello' })
    store.runQuickAction('translate')
    await finished
    expect(written).toContain('译文结果')
    settings.textTools = { autoCopyResult: false } // 复位,避免影响其它用例
  })

  it('快捷动作不带工具(空 registry)', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, { readText: () => 'x' })
    store.runQuickAction('summarize')
    await finished
    expect(seen[0].tools).toBeUndefined()
  })
})
