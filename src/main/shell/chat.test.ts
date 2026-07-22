import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatStore, buildQuickActionPreview, MAX_CLIPBOARD_CHARS } from './chat'
import { createMemoryManager } from '../memory/memoryManager'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { AppSettings, StreamChunk } from '@shared/llm'
import { DEFAULT_TTS_SETTINGS, DEFAULT_GENIE_TTS_SETTINGS } from '@shared/llm'
import type { TodoStore } from '../todos/todoStore'

const settings: AppSettings = {
  schemaVersion: 3,
  activePetId: 'luluka',
  provider: { kind: 'fake', model: 'fake' },
  search: { backend: 'duckduckgo' },
  memory: { embedding: null },
  textTools: { autoCopyResult: false },
  firecrawl: { enabled: false },
  desktopControl: { enabled: false },
  browserControl: { enabled: false, mode: 'isolated' },
  appFocusLlmOpener: { enabled: false },
  tts: DEFAULT_TTS_SETTINGS,
  ttsGenie: DEFAULT_GENIE_TTS_SETTINGS,
  gpuAcceleration: { experimental: false },
  live2d: { mouseTrackingEnabled: false }
}

function recording(inner: LlmProvider, seen: StreamChatRequest[]): LlmProvider {
  return { streamChat: (req) => { seen.push(req); return inner.streamChat(req) } }
}

let dir: string
let firecrawlKey: string | null = null
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-')); firecrawlKey = null })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeStore(
  provider: LlmProvider,
  seen: StreamChatRequest[],
  clip?: { readText?: () => string; writeText?: (t: string) => void },
  desktop?: {
    buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]
    wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[]
    buildBrowserTools?: () => import('../tools/toolSpec').ToolSpec[]
    beginDesktopControlTurn?: () => number
    endDesktopControlTurn?: (token: number) => void
  }
) {
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
    buildDesktopTools: desktop?.buildDesktopTools,
    wrapDesktopTools: desktop?.wrapDesktopTools,
    buildBrowserTools: desktop?.buildBrowserTools,
    beginDesktopControlTurn: desktop?.beginDesktopControlTurn,
    endDesktopControlTurn: desktop?.endDesktopControlTurn,
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

  it('调过工具的回合:pet 消息落盘时带 actions 字段(供后续回合提示词感知)', async () => {
    const seen: StreamChatRequest[] = []
    const provider = createFakeProvider({
      script: [
        [{ type: 'tool_use', toolUse: { id: 't1', name: 'save_memory', input: { text: '用户爱吃冰淇淋' } } }],
        [{ type: 'text', text: '记好啦!' }, { type: 'done' }]
      ]
    })
    const { store, finished } = makeStore(provider, seen)
    store.handleSend({ text: '记住我爱吃冰淇淋' })
    await finished
    const t = JSON.parse(readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8'))
    const pet = t.messages.find((m: { role: string }) => m.role === 'pet')
    expect(pet.actions).toEqual(['save_memory'])
  })

  it('没调工具的回合:pet 消息不带 actions 字段', async () => {
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: '你好!' }), seen)
    store.handleSend({ text: '你好' })
    await finished
    const t = JSON.parse(readFileSync(join(dir, 'memory', 'transcript.json'), 'utf-8'))
    const pet = t.messages.find((m: { role: string }) => m.role === 'pet')
    expect(pet.actions).toBeUndefined()
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

describe('desktopControl 工具挂载与轮数上限', () => {
  function fakeDesktopTool(name: string): import('../tools/toolSpec').ToolSpec {
    return { name, description: 'd', inputSchema: { type: 'object', properties: {}, required: [] }, run: async () => 'ok' }
  }

  it('desktopControl 关闭时不挂载,即便注入了 buildDesktopTools', async () => {
    settings.desktopControl = { enabled: false }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).not.toContain('take_screenshot')
  })

  it('desktopControl 开启时挂载 buildDesktopTools 返回的工具,并经过 wrapDesktopTools', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    let wrapped = false
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')],
      wrapDesktopTools: (tools) => { wrapped = true; return tools }
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).toContain('take_screenshot')
    expect(wrapped).toBe(true)
    settings.desktopControl = { enabled: false } // 复位
  })

  it('desktopControl 开启且实际用了桌面工具时,beginDesktopControlTurn 在工具执行前调用、endDesktopControlTurn 在整轮结束后用同一个 token 调用', async () => {
    // 回归用例:安全网(manualOverrideWatch)必须以"一整轮多步任务"为边界启动/停止,
    // 而不是每次单个工具调用都重启一次——否则两次工具调用之间(模型思考的几秒)完全
    // 失去监控,人工接管鼠标就无法打断自动化。这里只验证 chat.ts 按轮次边界调用这两个
    // 钩子、且传给 endDesktopControlTurn 的 token 与 beginDesktopControlTurn 的返回值一致;
    // token 匹配逻辑本身由 toolIndicatorGate.test.ts 覆盖。
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    const calls: string[] = []
    let issuedToken = -1
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')],
      beginDesktopControlTurn: () => { calls.push('begin'); issuedToken = 42; return issuedToken },
      endDesktopControlTurn: (token) => { calls.push(`end:${token}`) }
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(calls).toEqual(['begin', 'end:42'])
    settings.desktopControl = { enabled: false } // 复位
  })

  it('desktopControl 关闭时不会调用 beginDesktopControlTurn/endDesktopControlTurn', async () => {
    settings.desktopControl = { enabled: false }
    const seen: StreamChatRequest[] = []
    const calls: string[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')],
      beginDesktopControlTurn: () => { calls.push('begin'); return 1 },
      endDesktopControlTurn: () => { calls.push('end') }
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(calls).toEqual([])
  })

  it('desktopControl 开启时轮数上限提升到 20,超过 6 轮的工具循环仍能继续', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    const script: StreamChunk[][] = Array.from({ length: 10 }, (_, i) => [
      { type: 'tool_use' as const, toolUse: { id: `t${i}`, name: 'take_screenshot', input: {} } }
    ])
    script.push([{ type: 'text' as const, text: '看完了' }, { type: 'done' as const }])
    const { store, finished } = makeStore(createFakeProvider({ script }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: '帮我看看屏幕' })
    await finished
    const petMsgs = store.messages().filter((m) => m.role === 'pet')
    expect(petMsgs[petMsgs.length - 1]?.text).toBe('看完了') // 未被"轮数上限"错误打断
    settings.desktopControl = { enabled: false } // 复位
  })

  it('desktopControl 开启时 maxOutputTokens 提升,降低旁白+工具参数一起被截断的概率', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].maxOutputTokens).toBeGreaterThan(1024)
    settings.desktopControl = { enabled: false } // 复位
  })

  it('desktopControl 关闭时 maxOutputTokens 保持默认 1024', async () => {
    settings.desktopControl = { enabled: false }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen)
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].maxOutputTokens).toBe(1024)
  })

  it('browserControl 关闭时不挂载,即便注入了 buildBrowserTools', async () => {
    settings.browserControl = { enabled: false, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).not.toContain('browser_navigate')
  })

  it('browserControl 开启时挂载 buildBrowserTools 返回的工具', async () => {
    settings.browserControl = { enabled: true, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    const { store, finished } = makeStore(createFakeProvider({ reply: 'ok' }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: 'hi' })
    await finished
    expect(seen[0].tools?.map((t) => t.name) ?? []).toContain('browser_navigate')
    settings.browserControl = { enabled: false, mode: 'isolated' } // 复位
  })

  it('browserControl 开启时(即便 desktopControl 关闭)轮数上限提升到 40——超过旧的 20 上限、但在新上限内的循环仍能继续', async () => {
    settings.browserControl = { enabled: true, mode: 'isolated' }
    const seen: StreamChatRequest[] = []
    // 30 轮:超过旧的 desktopControl 共用上限(20),证明浏览器任务确实拿到了独立的更大预算,
    // 不是恰好卡在两个上限都满足的区间(之前 10 轮的写法在 20/40 任一上限下都会通过,没有区分度)。
    const script: StreamChunk[][] = Array.from({ length: 30 }, (_, i) => [
      { type: 'tool_use' as const, toolUse: { id: `t${i}`, name: 'browser_navigate', input: {} } }
    ])
    script.push([{ type: 'text' as const, text: '看完了' }, { type: 'done' as const }])
    const { store, finished } = makeStore(createFakeProvider({ script }), seen, undefined, {
      buildBrowserTools: () => [fakeDesktopTool('browser_navigate')]
    })
    store.handleSend({ text: '帮我搜一下' })
    await finished
    const petMsgs = store.messages().filter((m) => m.role === 'pet')
    expect(petMsgs[petMsgs.length - 1]?.text).toBe('看完了') // 未被"轮数上限"错误打断
    settings.browserControl = { enabled: false, mode: 'isolated' } // 复位
  })

  it('desktopControl 单独开启时轮数上限仍是 20,没有被浏览器任务的调整误伤', async () => {
    settings.desktopControl = { enabled: true }
    const seen: StreamChatRequest[] = []
    // 25 轮的脚本,若上限被误伤成 40 会全部跑完(seen.length===25);若仍是 20,provider
    // 只会被调用 20 次就因"轮数上限"停止,不会消费脚本剩下的 5 轮。
    const script: StreamChunk[][] = Array.from({ length: 25 }, (_, i) => [
      { type: 'tool_use' as const, toolUse: { id: `t${i}`, name: 'take_screenshot', input: {} } }
    ])
    const { store, finished } = makeStore(createFakeProvider({ script }), seen, undefined, {
      buildDesktopTools: () => [fakeDesktopTool('take_screenshot')]
    })
    store.handleSend({ text: '帮我看看屏幕' })
    await finished
    expect(seen.length).toBe(20)
    settings.desktopControl = { enabled: false } // 复位
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

describe('语音接线', () => {
  it('batch 模式:回复完整生成后调用一次 voice.speak(完整文本)', async () => {
    const seen: StreamChatRequest[] = []
    const spoken: string[] = []
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    let done: () => void = () => {}
    const finished = new Promise<void>((r) => { done = r })
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => recording(createFakeProvider({ reply: '你好呀' }), seen),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => done(),
      pushError: () => done(),
      openSettings: () => {},
      voice: { getSettings: () => ({ ...settings.tts, playbackTrigger: 'batch' }), speak: (t) => spoken.push(t), stop: () => {} }
    })
    store.handleSend({ text: '你好' })
    await finished
    expect(spoken).toEqual(['你好呀'])
  })

  it('stream 模式:每凑齐一个完整句子就调用一次 voice.speak', async () => {
    const seen: StreamChatRequest[] = []
    const spoken: string[] = []
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    let done: () => void = () => {}
    const finished = new Promise<void>((r) => { done = r })
    const provider = createFakeProvider({ script: [[{ type: 'text', text: '第一句。第二句!' }, { type: 'text', text: '第三句剩余' }, { type: 'done' }]] })
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => recording(provider, seen),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => done(),
      pushError: () => done(),
      openSettings: () => {},
      voice: { getSettings: () => ({ ...settings.tts, playbackTrigger: 'stream', textSplit: 'sentence' }), speak: (t) => spoken.push(t), stop: () => {} }
    })
    store.handleSend({ text: '你好' })
    await finished
    expect(spoken).toEqual(['第一句。', '第二句!', '第三句剩余'])
  })

  it('stream 模式 + textSplit=smart:短句合并攒够长度(或回复结束)才朗读', async () => {
    const seen: StreamChatRequest[] = []
    const spoken: string[] = []
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    let done: () => void = () => {}
    const finished = new Promise<void>((r) => { done = r })
    const provider = createFakeProvider({ script: [[{ type: 'text', text: '第一句。第二句!' }, { type: 'text', text: '第三句剩余' }, { type: 'done' }]] })
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => recording(provider, seen),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => done(),
      pushError: () => done(),
      openSettings: () => {},
      voice: { getSettings: () => ({ ...settings.tts, playbackTrigger: 'stream', textSplit: 'smart' }), speak: (t) => spoken.push(t), stop: () => {} }
    })
    store.handleSend({ text: '你好' })
    await finished
    // 三个短句合计不足智能合并阈值 → 一直攒着,回复结束时合并成一段朗读
    expect(spoken).toEqual(['第一句。第二句!第三句剩余'])
  })

  it('取消(cancel)时调用 voice.stop()', () => {
    const memory = createMemoryManager({ dir: join(dir, 'memory'), getEmbedder: () => null })
    const stopped: boolean[] = []
    const store = createChatStore({
      petDir: join(dir, 'no-pet'),
      skills: { list: () => [], body: () => null },
      memory,
      todoStore: { list: () => [], add: () => ({} as never), toggleDone: () => null, remove: () => false, markFired: () => {}, onChange: () => () => {} } as unknown as TodoStore,
      loadSettings: () => settings,
      getKey: () => 'k',
      getSearchKey: () => null,
      getFirecrawlKey: () => null,
      makeProvider: () => createFakeProvider({ reply: 'x', delayMs: 1000 }),
      prepareImages: () => [],
      clipboard: { readText: () => '', writeText: () => {} },
      emitPetEvent: () => {},
      pushUpdate: () => {},
      pushStream: () => {},
      pushStatus: () => {},
      pushDone: () => {},
      pushError: () => {},
      openSettings: () => {},
      voice: { getSettings: () => settings.tts, speak: () => {}, stop: () => stopped.push(true) }
    })
    // 不预先调用 handleSend:cancel() 应无条件停止朗读,无论是否有请求在途(设计文档 §6)
    store.cancel()
    expect(stopped).toEqual([true])
  })
})
