import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatStore, buildQuickActionPreview, MAX_CLIPBOARD_CHARS } from './chat'
import { createMemoryManager } from '../memory/memoryManager'
import { createFakeProvider } from '../providers/fakeProvider'
import type { LlmProvider, StreamChatRequest } from '../providers/llmProvider'
import type { AppSettings, StreamChunk } from '@shared/llm'
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
  tts: { enabled: false, language: 'zh' }
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
  },
  ttsOpts?: {
    tts?: import('../providers/tts').TtsProvider
    translate?: typeof import('../agent/translate').translateText
    settingsOverride?: AppSettings
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
    loadSettings: () => ttsOpts?.settingsOverride ?? settings,
    getKey: () => 'k',
    getSearchKey: () => null,
    getFirecrawlKey: () => firecrawlKey,
    buildDesktopTools: desktop?.buildDesktopTools,
    wrapDesktopTools: desktop?.wrapDesktopTools,
    buildBrowserTools: desktop?.buildBrowserTools,
    makeProvider: () => recording(provider, seen),
    prepareImages: (atts) => atts.map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 })),
    clipboard: { readText: clip?.readText ?? (() => ''), writeText: clip?.writeText ?? ((t) => { written.push(t) }) },
    emitPetEvent: () => {},
    pushUpdate: () => {},
    pushStream: () => {},
    pushStatus: () => {},
    pushDone: () => done(),
    pushError: () => done(),
    openSettings: () => {},
    tts: ttsOpts?.tts,
    translate: ttsOpts?.translate
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

describe('TTS 接线', () => {
  function fakeTts() {
    const calls: string[] = []
    return {
      calls,
      tts: {
        start: async () => true,
        begin: (id: string, lang: string) => calls.push(`begin:${id}:${lang}`),
        pushToken: (t: string) => calls.push(`pushToken:${t}`),
        finish: () => calls.push('finish'),
        cancel: () => calls.push('cancel'),
        close: async () => {}
      }
    }
  }

  const ttsSettingsZh: AppSettings = { ...settings, tts: { enabled: true, language: 'zh' } }
  const ttsSettingsJa: AppSettings = { ...settings, tts: { enabled: true, language: 'ja' } }

  it('zh:流式 token 边生成边 pushToken,结束调 finish', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store, finished } = makeStore(createFakeProvider({ reply: '你好呀' }), seen, undefined, undefined, { tts, settingsOverride: ttsSettingsZh })
    store.handleSend({ text: '嗨' })
    await finished
    // calls[0] 固定是 'cancel':handleSend 开头无条件调用 cancel()(哪怕没有在途请求),
    // 这样才能打断"发新消息前宠物正在念 lines.json 台词"这种与 chat.ts 自身 inFlight 无关的语音。
    expect(calls[0]).toBe('cancel')
    expect(calls[1]).toMatch(/^begin:chat-\d+:zh$/)
    // fakeProvider 默认按 chunkSize=2 分块调用 onText('你好呀' → '你好'+'呀' 两次),
    // 故按拼接后的整体校验"流式 token 边生成边 pushToken"这一意图,而非单次调用的字面值。
    const pushed = calls.filter((c) => c.startsWith('pushToken:')).map((c) => c.slice('pushToken:'.length)).join('')
    expect(pushed).toBe('你好呀')
    expect(calls[calls.length - 1]).toBe('finish')
  })

  it('ja:回复生成阶段不调用 pushToken(zh 专属流式分支不触发);回复完毕后翻译整句,再一次性 begin/pushToken/finish', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const translate = async () => 'おはよう'
    const { store, finished } = makeStore(createFakeProvider({ reply: '早安' }), seen, undefined, undefined, { tts, translate, settingsOverride: ttsSettingsJa })
    store.handleSend({ text: '嗨' })
    await finished
    // pushDone() 在翻译发起之前就已同步调用,finished 在此刻已经 resolve,翻译分支还没跑
    expect(calls.filter((c) => c.startsWith('pushToken')).length).toBe(0)
    await new Promise((r) => setTimeout(r, 0)) // 让翻译分支的微任务/宏任务跑完
    expect(calls).toEqual(expect.arrayContaining([expect.stringMatching(/^begin:chat-\d+:ja$/), 'pushToken:おはよう', 'finish']))
  })

  it('ja:翻译失败(返回 null)→ 静默不朗读,不抛错、不影响文字回复', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const translate = async () => null
    const { store, memory, finished } = makeStore(createFakeProvider({ reply: '早安' }), seen, undefined, undefined, { tts, translate, settingsOverride: ttsSettingsJa })
    store.handleSend({ text: '嗨' })
    await finished
    await new Promise((r) => setTimeout(r, 0)) // 让翻译分支的微任务跑完
    expect(calls.some((c) => c.startsWith('begin'))).toBe(false)
    expect(memory.messages().map((m) => m.text)).toEqual(['嗨', '早安']) // 文字回复不受影响
  })

  it('tts.enabled:false → 不调用 begin/pushToken/finish(cancel() 仍会被调,但那是无条件的兜底,真实 ttsProvider 在禁用态下会安全吸收它)', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store, finished } = makeStore(createFakeProvider({ reply: '你好' }), seen, undefined, undefined, { tts, settingsOverride: settings })
    store.handleSend({ text: '嗨' })
    await finished
    expect(calls.some((c) => c.startsWith('begin') || c.startsWith('pushToken') || c === 'finish')).toBe(false)
  })

  it('新消息打断:cancel() 会调用 tts.cancel()', async () => {
    const seen: StreamChatRequest[] = []
    const { calls, tts } = fakeTts()
    const { store } = makeStore(createFakeProvider({ reply: '你好' }), seen, undefined, undefined, { tts, settingsOverride: ttsSettingsZh })
    store.handleSend({ text: '第一句' })
    store.cancel()
    expect(calls).toContain('cancel')
  })
})
