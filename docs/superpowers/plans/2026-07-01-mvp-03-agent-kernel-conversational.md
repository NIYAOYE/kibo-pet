# MVP-03 对话式 Agent 内核 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把宠物的占位回复替换为真正的对话式 LLM agent —— 可插拔 Provider(Fake/Anthropic/OpenAI 兼容)、密钥安全存储、首启设置窗、逐字流式、§5.6 运行时护栏。

**Architecture:** 纯逻辑(provider 接口、fake provider、persona 解析、prompt 组装、agent 循环、settings、secrets)先 TDD;真 provider 用官方 SDK 做薄适配;主进程编排(chat.ts 调 agent,流式经 IPC 推给对话框);首启设置窗为第三渲染入口。transcript 仍归主进程(MVP-02 接缝)。

**Tech Stack:** Electron(CJS 主进程/preload)· electron-vite · TypeScript(strict)· Vitest · pnpm · `@anthropic-ai/sdk` · `openai`。

## Global Constraints

- 包管理器 **pnpm**;**不要**加 `"type":"module"`(Electron 主进程/preload 必须 CJS)。
- 跨进程值走 `src/shared` + `@shared/*`;**IPC 通道名一律用 `IPC` 常量**,不硬编码字符串;新 IPC 四文件同步(shared/ipc.ts + main handler + preload + 调用方)。
- 渲染安全三件套:`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`;每个 HTML 带 CSP。
- **纯逻辑 TDD**(先写失败测试);GUI/Provider 接线靠 `pnpm typecheck` + `pnpm build` + 真机 `pnpm preview` 验收(**自动化过≠能跑**)。
- **API key 绝不**写日志 / settings.json / 错误文本;只经 Electron `safeStorage` 加密落盘;Provider 客户端与 key 只在**主进程**,渲染层零接触。
- Anthropic 预设默认模型 **`claude-haiku-4-5`**(用户可改 `claude-sonnet-5`/`claude-opus-4-8`);模型 ID 不加日期后缀。桌宠默认**不开** extended thinking。
- 未配置(无 key)时发送 → 提示去设置,**不**退回 lines.json 占位。
- 护栏默认常量:超时 `TIMEOUT_MS=60000`、预算 `MAX_OUTPUT_TOKENS=1024`、对话窗口 `WINDOW_TURNS=12`(均为常量,便于调)。
- 重试由底层 SDK 默认机制负责(429/5xx/连接错),agent 层**不**自研重试。
- 提交小而频;**中文** conventional-commit(`feat(scope): ...`)。
- 单测:`pnpm vitest run <file>`;类型:`pnpm typecheck`;构建:`pnpm build`。

---

## 文件结构

**新建:**
- `src/shared/llm.ts` — 跨进程纯类型 + 预设数据(ChatTurn/StreamChunk/ProviderKind/ProviderSettings/AppSettings/Preset/PRESETS/DEFAULT_SETTINGS)
- `src/main/providers/llmProvider.ts` — LlmProvider 接口
- `src/main/providers/fakeProvider.ts`(+ test)— 确定性流式假 provider
- `src/main/persona/personaLoader.ts`(+ test)— persona.md 分块解析 + 读取
- `src/main/agent/promptAssembler.ts`(+ test)— persona + 窗口 → {system, messages}
- `src/main/agent/agentLoop.ts`(+ test)— 编排 + 护栏(超时/取消/预算/失败即状态)
- `src/main/config/settings.ts`(+ test)— 设置读写(原子 + schemaVersion)
- `src/main/config/secrets.ts`(+ test)— safeStorage 密钥存储(可注入)
- `src/main/providers/anthropicProvider.ts` / `openaiCompatProvider.ts` / `createProvider.ts` — 真 provider + 工厂
- `src/main/agent/testConnection.ts` — 一次极简调用验证配置
- `src/main/shell/settingsWindow.ts` — 设置窗生命周期
- `src/renderer/settings.html` / `src/renderer/settings.ts` — 设置/首启 UI

**修改:**
- `src/shared/ipc.ts` — 新通道 + 类型 + chatApi/settingsApi
- `src/preload/index.ts` — 暴露 chatApi 流式方法 + settingsApi
- `src/main/shell/chat.ts` — 占位替换为 agent 循环 + 未配置降级 + 流式推送 + 取消
- `src/main/shell/index.ts` — 注册新 IPC + 托盘"设置" + 首启弹窗 + 装配 chat 依赖
- `src/renderer/dialog.ts` — 逐字流式渲染(CHAT_STREAM/DONE/ERROR)
- `electron.vite.config.ts` — settings.html 第三入口 + main/preload externalizeDepsPlugin
- `package.json` — 加 `@anthropic-ai/sdk`、`openai` 依赖

**任务顺序:** 1(类型+接口+Fake)→ 2(persona)→ 3(assembler)→ 4(agentLoop)→ 5(settings)→ 6(secrets)→ 7(真 provider+依赖+config)→ 8(IPC+preload)→ 9(chat 接线+shell IPC)→ 10(设置窗)→ 11(dialog 流式)→ 12(收尾)。1–6 纯 TDD 可先做;7 起需 typecheck/build;9/10/11 真机验收。

---

## Task 1: 共享类型 + Provider 接口 + FakeProvider

**Files:**
- Create: `src/shared/llm.ts`、`src/main/providers/llmProvider.ts`、`src/main/providers/fakeProvider.ts`
- Test: `src/main/providers/fakeProvider.test.ts`

**Interfaces:**
- Produces:
  - `type ProviderKind = 'fake'|'anthropic'|'openai-compat'`
  - `interface ChatTurn { role:'user'|'assistant'; content:string }`
  - `type StreamChunk = {type:'text';text:string} | {type:'done'} | {type:'error';message:string}`
  - `interface ProviderSettings { kind:ProviderKind; baseURL?:string; model:string }`
  - `interface AppSettings { schemaVersion:number; provider:ProviderSettings }`,`const SETTINGS_SCHEMA_VERSION=1`,`const DEFAULT_SETTINGS`
  - `interface Preset { id; label; kind; baseURL?; defaultModel }`,`const PRESETS: Preset[]`
  - `interface StreamChatRequest { system:string; messages:ChatTurn[]; maxOutputTokens:number; signal:AbortSignal }`
  - `interface LlmProvider { streamChat(req:StreamChatRequest):AsyncIterable<StreamChunk> }`
  - `interface FakeProviderOptions { reply?; chunkSize?; delayMs?; failWith?; sleep? }`,`function createFakeProvider(opts?):LlmProvider`

- [ ] **Step 1: 写共享类型**

Create `src/shared/llm.ts`:

```ts
export type ProviderKind = 'fake' | 'anthropic' | 'openai-compat'

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ProviderSettings { kind: ProviderKind; baseURL?: string; model: string }

export const SETTINGS_SCHEMA_VERSION = 1

export interface AppSettings { schemaVersion: number; provider: ProviderSettings }

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  provider: { kind: 'anthropic', model: 'claude-haiku-4-5' }
}

export interface Preset {
  id: string
  label: string
  kind: ProviderKind
  baseURL?: string
  defaultModel: string
}

/** 首启向导可选的预设;用户仍可改 baseURL/model。 */
export const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', kind: 'anthropic', defaultModel: 'claude-haiku-4-5' },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'qwen', label: '通义千问 (DashScope 兼容)', kind: 'openai-compat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai-compat', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  { id: 'ollama', label: '本地 Ollama', kind: 'openai-compat', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.1' }
]
```

- [ ] **Step 2: 写 Provider 接口**

Create `src/main/providers/llmProvider.ts`:

```ts
import type { ChatTurn, StreamChunk } from '@shared/llm'

export interface StreamChatRequest {
  system: string
  messages: ChatTurn[]
  maxOutputTokens: number
  signal: AbortSignal
}

export interface LlmProvider {
  streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk>
}
```

- [ ] **Step 3: 写失败测试(FakeProvider)**

Create `src/main/providers/fakeProvider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createFakeProvider } from './fakeProvider'
import type { StreamChunk } from '@shared/llm'

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

const req = (signal: AbortSignal) => ({ system: 's', messages: [], maxOutputTokens: 64, signal })

describe('fakeProvider', () => {
  it('streams the reply in order then done', async () => {
    const p = createFakeProvider({ reply: 'abcd', chunkSize: 2 })
    const chunks = await collect(p.streamChat(req(new AbortController().signal)))
    expect(chunks).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'text', text: 'cd' },
      { type: 'done' }
    ])
  })

  it('emits an error chunk when failWith is set', async () => {
    const p = createFakeProvider({ failWith: 'boom' })
    const chunks = await collect(p.streamChat(req(new AbortController().signal)))
    expect(chunks).toEqual([{ type: 'error', message: 'boom' }])
  })

  it('stops early when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = createFakeProvider({ reply: 'abcd', chunkSize: 1 })
    const chunks = await collect(p.streamChat(req(ctrl.signal)))
    expect(chunks).toEqual([]) // aborted before first yield
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run src/main/providers/fakeProvider.test.ts`
Expected: FAIL(`Cannot find module './fakeProvider'`)。

- [ ] **Step 5: 实现 FakeProvider**

Create `src/main/providers/fakeProvider.ts`:

```ts
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

export interface FakeProviderOptions {
  reply?: string
  chunkSize?: number
  delayMs?: number
  failWith?: string
  sleep?: (ms: number) => Promise<void>
}

export function createFakeProvider(opts: FakeProviderOptions = {}): LlmProvider {
  const reply = opts.reply ?? '你好,我在。'
  const chunkSize = opts.chunkSize ?? 2
  const delayMs = opts.delayMs ?? 0
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      if (opts.failWith) { yield { type: 'error', message: opts.failWith }; return }
      for (let i = 0; i < reply.length; i += chunkSize) {
        if (req.signal.aborted) return
        if (delayMs > 0) await sleep(delayMs)
        if (req.signal.aborted) return
        yield { type: 'text', text: reply.slice(i, i + chunkSize) }
      }
      yield { type: 'done' }
    }
  }
}
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `pnpm vitest run src/main/providers/fakeProvider.test.ts && pnpm typecheck`
Expected: 3 用例 PASS;typecheck 无错。

- [ ] **Step 7: 提交**

```bash
git add src/shared/llm.ts src/main/providers/llmProvider.ts src/main/providers/fakeProvider.ts src/main/providers/fakeProvider.test.ts
git commit -m "feat(llm): 共享 LLM 类型 + Provider 接口 + 确定性 FakeProvider(TDD)"
```

---

## Task 2: persona.md 分块解析 + 读取

**Files:**
- Create: `src/main/persona/personaLoader.ts`
- Test: `src/main/persona/personaLoader.test.ts`

**Interfaces:**
- Produces:
  - `interface PersonaBlocks { persona:string; voice:string; behavior:string; tools:string }`
  - `function parsePersona(md:string): PersonaBlocks`(纯)
  - `function loadPersona(petDir:string): PersonaBlocks`(读 `<petDir>/persona.md`,缺失/失败→空块,带缓存)

- [ ] **Step 1: 写失败测试**

Create `src/main/persona/personaLoader.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePersona } from './personaLoader'

const md = `# Persona(人设 / 角色)
你是露露卡。

# Voice(语气 / 说话风格)
惜字如金。

# Behavior(行为准则)
先把事办成。

# Tools(对工具的态度)
需要就去查。
`

describe('parsePersona', () => {
  it('splits markdown into the four known blocks by heading keyword', () => {
    const b = parsePersona(md)
    expect(b.persona).toBe('你是露露卡。')
    expect(b.voice).toBe('惜字如金。')
    expect(b.behavior).toBe('先把事办成。')
    expect(b.tools).toBe('需要就去查。')
  })

  it('returns empty strings for missing blocks', () => {
    const b = parsePersona('# Persona\n只有人设。')
    expect(b.persona).toBe('只有人设。')
    expect(b.voice).toBe('')
    expect(b.behavior).toBe('')
    expect(b.tools).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/persona/personaLoader.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

Create `src/main/persona/personaLoader.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/persona/personaLoader.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/persona/personaLoader.ts src/main/persona/personaLoader.test.ts
git commit -m "feat(persona): persona.md 分块解析 + 读取(缓存,缺失降级)"
```

---

## Task 3: Prompt 组装(纯函数 §5.4)

**Files:**
- Create: `src/main/agent/promptAssembler.ts`
- Test: `src/main/agent/promptAssembler.test.ts`

**Interfaces:**
- Consumes: `PersonaBlocks`(Task 2)、`ChatMessage`(`@shared/ipc`,`{role:'user'|'pet'; text:string}`)、`ChatTurn`(`@shared/llm`)。
- Produces:
  - `interface AssembledPrompt { system:string; messages:ChatTurn[] }`
  - `const WINDOW_TURNS = 12`
  - `function assemblePrompt(persona:PersonaBlocks, transcript:ChatMessage[]): AssembledPrompt`

- [ ] **Step 1: 写失败测试**

Create `src/main/agent/promptAssembler.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { assemblePrompt, WINDOW_TURNS } from './promptAssembler'
import type { ChatMessage } from '@shared/ipc'

const persona = { persona: 'P', voice: 'V', behavior: 'B', tools: 'T' }

describe('assemblePrompt', () => {
  it('joins persona blocks in order into system, with a memory placeholder', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system.startsWith('P\n\nV\n\nB\n\nT')).toBe(true)
    expect(system).toContain('MVP-05') // 记忆占位注释
  })

  it('maps pet->assistant / user->user and truncates to the window', () => {
    const transcript: ChatMessage[] = []
    for (let i = 0; i < WINDOW_TURNS + 4; i++) {
      transcript.push({ role: i % 2 === 0 ? 'user' : 'pet', text: `m${i}` })
    }
    const { messages } = assemblePrompt(persona, transcript)
    expect(messages.length).toBeLessThanOrEqual(WINDOW_TURNS)
    expect(messages[0].role).toBe('user') // 窗口首条必须是 user
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true)
  })

  it('drops a leading assistant turn so messages start with user', () => {
    const transcript: ChatMessage[] = [
      { role: 'pet', text: 'hi' },
      { role: 'user', text: 'hello' }
    ]
    const { messages } = assemblePrompt(persona, transcript)
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('skips empty persona blocks', () => {
    const { system } = assemblePrompt({ persona: 'P', voice: '', behavior: '', tools: '' }, [])
    expect(system.startsWith('P\n\n<!--')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

Create `src/main/agent/promptAssembler.ts`:

```ts
import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

export const WINDOW_TURNS = 12

const MEMORY_PLACEHOLDER = '<!-- 记忆召回:MVP-05 在此注入用户事实/工作记忆摘要 -->'

export function assemblePrompt(persona: PersonaBlocks, transcript: ChatMessage[]): AssembledPrompt {
  const system =
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    '\n\n' + MEMORY_PLACEHOLDER

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/agent/promptAssembler.ts src/main/agent/promptAssembler.test.ts
git commit -m "feat(agent): system prompt 组装(persona 分块 + 对话窗口,记忆位留空)"
```

---

## Task 4: Agent 循环 + 护栏(§5.6,TDD 用 FakeProvider)

**Files:**
- Create: `src/main/agent/agentLoop.ts`
- Test: `src/main/agent/agentLoop.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`(Task 1)、`ChatTurn`(`@shared/llm`)。
- Produces:
  - `interface AgentRunOptions { provider:LlmProvider; system:string; messages:ChatTurn[]; maxOutputTokens:number; timeoutMs:number; signal:AbortSignal; onText:(t:string)=>void }`
  - `interface AgentRunResult { text:string; error?:string; canceled?:boolean }`
  - `function runAgent(opts:AgentRunOptions): Promise<AgentRunResult>`
- 语义:逐 chunk 调 `onText`;provider 的 `error` chunk → `result.error`;外部 `signal` abort → `canceled:true`(丢弃);超时 → `error:'响应超时'`;正常结束返回累计 `text`。**不自研重试**(交 SDK)。

- [ ] **Step 1: 写失败测试**

Create `src/main/agent/agentLoop.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agentLoop'
import { createFakeProvider } from '../providers/fakeProvider'

const base = (over: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
  provider: createFakeProvider({ reply: 'abcd', chunkSize: 2 }),
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxOutputTokens: 64,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  onText: vi.fn(),
  ...over
})

describe('runAgent', () => {
  it('streams text via onText and returns the full accumulated text', async () => {
    const onText = vi.fn()
    const res = await runAgent(base({ onText }))
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['ab', 'cd'])
    expect(res).toEqual({ text: 'abcd' })
  })

  it('surfaces a provider error chunk as result.error', async () => {
    const res = await runAgent(base({ provider: createFakeProvider({ failWith: 'net down' }) }))
    expect(res.error).toBe('net down')
  })

  it('returns canceled when the signal is aborted before starting', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const onText = vi.fn()
    const res = await runAgent(base({ signal: ctrl.signal, onText }))
    expect(res.canceled).toBe(true)
    expect(onText).not.toHaveBeenCalled()
  })

  it('times out a hanging provider and reports 响应超时', async () => {
    // provider sleeps 1s between chunks (real), timeout 20ms → aborts
    const slow = createFakeProvider({ reply: 'abcd', chunkSize: 1, delayMs: 1000 })
    const res = await runAgent(base({ provider: slow, timeoutMs: 20 }))
    expect(res.error).toBe('响应超时')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/agent/agentLoop.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

Create `src/main/agent/agentLoop.ts`:

```ts
import type { LlmProvider } from '../providers/llmProvider'
import type { ChatTurn } from '@shared/llm'

export interface AgentRunOptions {
  provider: LlmProvider
  system: string
  messages: ChatTurn[]
  maxOutputTokens: number
  timeoutMs: number
  signal: AbortSignal
  onText: (text: string) => void
}

export interface AgentRunResult { text: string; error?: string; canceled?: boolean }

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.signal.aborted) return { text: '', canceled: true }

  const internal = new AbortController()
  const onExternalAbort = (): void => internal.abort()
  opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; internal.abort() }, opts.timeoutMs)

  let text = ''
  const finish = (partial: AgentRunResult): AgentRunResult => {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onExternalAbort)
    if (opts.signal.aborted && !timedOut) return { text, canceled: true }
    if (timedOut) return { text, error: partial.error ?? '响应超时' }
    return partial
  }

  try {
    for await (const chunk of opts.provider.streamChat({
      system: opts.system,
      messages: opts.messages,
      maxOutputTokens: opts.maxOutputTokens,
      signal: internal.signal
    })) {
      if (chunk.type === 'text') { text += chunk.text; opts.onText(chunk.text) }
      else if (chunk.type === 'error') return finish({ text, error: chunk.message })
      else if (chunk.type === 'done') return finish({ text })
    }
    return finish({ text })
  } catch (err) {
    return finish({ text, error: String((err as Error)?.message ?? err) })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/agent/agentLoop.test.ts`
Expected: 4 用例 PASS(超时用例约 ~20ms)。

- [ ] **Step 5: 提交**

```bash
git add src/main/agent/agentLoop.ts src/main/agent/agentLoop.test.ts
git commit -m "feat(agent): 对话循环 + 护栏(流式/取消/超时/失败即状态;重试交 SDK)"
```

---

## Task 5: 设置读写(原子 + schemaVersion)

**Files:**
- Create: `src/main/config/settings.ts`
- Test: `src/main/config/settings.test.ts`

**Interfaces:**
- Consumes: `AppSettings`/`DEFAULT_SETTINGS`/`SETTINGS_SCHEMA_VERSION`(`@shared/llm`)。
- Produces: `function loadSettings(file:string): AppSettings`、`function saveSettings(file:string, s:AppSettings): void`。

- [ ] **Step 1: 写失败测试**

Create `src/main/config/settings.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '@shared/llm'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pet-settings-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('settings', () => {
  it('returns defaults when the file is missing', () => {
    expect(loadSettings(join(tmp(), 'settings.json'))).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips save then load', () => {
    const file = join(tmp(), 'settings.json')
    const s = { schemaVersion: SETTINGS_SCHEMA_VERSION, provider: { kind: 'openai-compat' as const, baseURL: 'http://x/v1', model: 'gpt-4o-mini' } }
    saveSettings(file, s)
    expect(loadSettings(file)).toEqual(s)
  })

  it('fills missing provider fields and normalizes schemaVersion', () => {
    const file = join(tmp(), 'settings.json')
    saveSettings(file, { schemaVersion: 0, provider: { kind: 'anthropic', model: '' } } as never)
    const loaded = loadSettings(file)
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(loaded.provider.model).toBe(DEFAULT_SETTINGS.provider.model) // 空 model → 默认
  })

  it('returns defaults on malformed json', () => {
    const file = join(tmp(), 'settings.json')
    saveSettings(file, DEFAULT_SETTINGS)
    require('node:fs').writeFileSync(file, '{ not json', 'utf-8')
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

Create `src/main/config/settings.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, ProviderKind } from '@shared/llm'

const KINDS: ProviderKind[] = ['fake', 'anthropic', 'openai-compat']

function normalize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const p = (r.provider ?? {}) as Record<string, unknown>
  const kind = KINDS.includes(p.kind as ProviderKind) ? (p.kind as ProviderKind) : DEFAULT_SETTINGS.provider.kind
  const model = typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_SETTINGS.provider.model
  const baseURL = typeof p.baseURL === 'string' && p.baseURL.length > 0 ? p.baseURL : undefined
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, provider: { kind, model, baseURL } }
}

export function loadSettings(file: string): AppSettings {
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8')
  renameSync(tmp, file)
}
```

> 注:`normalize` 丢弃 `baseURL: undefined` 会让 round-trip 测试里带 `baseURL` 的对象一致(JSON 序列化省略 undefined);Anthropic 默认设置无 baseURL,`loadSettings` 返回的对象也不含 baseURL 键 —— 与 `DEFAULT_SETTINGS`(无 baseURL)`toEqual` 相等。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/settings.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/config/settings.ts src/main/config/settings.test.ts
git commit -m "feat(config): 设置读写(原子写 + schemaVersion + 校验/缺省)"
```

---

## Task 6: 密钥安全存储(safeStorage,可注入)

**Files:**
- Create: `src/main/config/secrets.ts`
- Test: `src/main/config/secrets.test.ts`

**Interfaces:**
- Produces:
  - `interface SafeStorageLike { isEncryptionAvailable():boolean; encryptString(s:string):Buffer; decryptString(b:Buffer):string }`
  - `interface SecretStore { hasKey():boolean; getKey():string|null; setKey(k:string):boolean; clear():void }`
  - `function createSecretStore(file:string, safe:SafeStorageLike): SecretStore`

- [ ] **Step 1: 写失败测试**

Create `src/main/config/secrets.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore, type SafeStorageLike } from './secrets'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pet-secrets-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

// 假 safeStorage:用 base64 当"加密"(仅测试)
const okSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf-8').toString('base64') as unknown as Buffer,
  // 上一行用 string 冒充 Buffer 便于比较;下方 decrypt 接受同物
  decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf-8')
}
const noSafe: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('unavailable') },
  decryptString: () => { throw new Error('unavailable') }
}

describe('secretStore', () => {
  it('stores and reads back a key when encryption is available', () => {
    const store = createSecretStore(join(tmp(), 'secrets.bin'), okSafe)
    expect(store.hasKey()).toBe(false)
    expect(store.setKey('sk-123')).toBe(true)
    expect(store.hasKey()).toBe(true)
    expect(store.getKey()).toBe('sk-123')
  })

  it('refuses to store (returns false, writes nothing) when encryption is unavailable', () => {
    const file = join(tmp(), 'secrets.bin')
    const store = createSecretStore(file, noSafe)
    expect(store.setKey('sk-123')).toBe(false)
    expect(store.hasKey()).toBe(false)
    expect(store.getKey()).toBe(null)
  })

  it('clear removes the stored key', () => {
    const store = createSecretStore(join(tmp(), 'secrets.bin'), okSafe)
    store.setKey('sk-1')
    store.clear()
    expect(store.hasKey()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/main/config/secrets.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

Create `src/main/config/secrets.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export interface SecretStore {
  hasKey(): boolean
  getKey(): string | null
  setKey(key: string): boolean
  clear(): void
}

export function createSecretStore(file: string, safe: SafeStorageLike): SecretStore {
  return {
    hasKey: () => existsSync(file),
    getKey: () => {
      if (!existsSync(file)) return null
      try { return safe.decryptString(readFileSync(file)) } catch { return null }
    },
    setKey: (key: string): boolean => {
      if (!safe.isEncryptionAvailable()) return false
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, safe.encryptString(key))
      renameSync(tmp, file)
      return true
    },
    clear: () => { try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ } }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/main/config/secrets.test.ts`
Expected: PASS。

> 生产接线(Task 9)用 Electron `safeStorage` 作 `SafeStorageLike` 传入 —— 其 `encryptString` 返回真 `Buffer`,`readFileSync` 返回 `Buffer`,类型契合。

- [ ] **Step 5: 提交**

```bash
git add src/main/config/secrets.ts src/main/config/secrets.test.ts
git commit -m "feat(config): API key 安全存储(safeStorage 加密,不可用则拒存,可注入以便测试)"
```

---

## Task 7: 真 Provider + 工厂 + 依赖 + 连接测试 + 构建配置

**Files:**
- Create: `src/main/providers/anthropicProvider.ts`、`src/main/providers/openaiCompatProvider.ts`、`src/main/providers/createProvider.ts`、`src/main/agent/testConnection.ts`
- Modify: `package.json`(加依赖)、`electron.vite.config.ts`(externalize)

**Interfaces:**
- Consumes: `LlmProvider`(Task 1)、`ProviderSettings`(`@shared/llm`)、`createFakeProvider`(Task 1)。
- Produces:
  - `function createAnthropicProvider(o:{apiKey;baseURL?;model}): LlmProvider`
  - `function createOpenAiCompatProvider(o:{apiKey;baseURL?;model}): LlmProvider`
  - `function createProvider(settings:ProviderSettings, apiKey:string): LlmProvider`
  - `function testConnection(settings:ProviderSettings, apiKey:string): Promise<{ok:boolean; error?:string}>`

- [ ] **Step 1: 装依赖**

Run:
```bash
pnpm add @anthropic-ai/sdk openai
```
Expected: 二者进入 `package.json` 的 `dependencies`;`pnpm install` 成功。

- [ ] **Step 2: externalize 主进程/preload 依赖**

Modify `electron.vite.config.ts` —— 顶部 import 加 `externalizeDepsPlugin`,给 `main` 与 `preload` 加 `plugins`:

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          dialog: resolve('src/renderer/dialog.html')
        }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
```

> `externalizeDepsPlugin` 让 `dependencies` 里的包(两个 SDK)不打进 bundle,运行时从 `node_modules` 加载 —— 主进程用官方 SDK 的正确方式。(settings.html 第三入口在 Task 10 加。)

- [ ] **Step 3: 实现 AnthropicProvider**

Create `src/main/providers/anthropicProvider.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

export function createAnthropicProvider(opts: { apiKey: string; baseURL?: string; model: string }): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      try {
        const stream = client.messages.stream(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
          },
          { signal: req.signal }
        )
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          }
        }
        yield { type: 'done' }
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
```

- [ ] **Step 4: 实现 OpenAiCompatProvider**

Create `src/main/providers/openaiCompatProvider.ts`:

```ts
import OpenAI from 'openai'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'

export function createOpenAiCompatProvider(opts: { apiKey: string; baseURL?: string; model: string }): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      try {
        const stream = await client.chat.completions.create(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            stream: true,
            messages: [
              { role: 'system', content: req.system },
              ...req.messages.map((m) => ({ role: m.role, content: m.content }))
            ]
          },
          { signal: req.signal }
        )
        for await (const part of stream) {
          const text = part.choices?.[0]?.delta?.content
          if (text) yield { type: 'text', text }
        }
        yield { type: 'done' }
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
```

- [ ] **Step 5: 实现工厂 + 连接测试**

Create `src/main/providers/createProvider.ts`:

```ts
import type { LlmProvider } from './llmProvider'
import type { ProviderSettings } from '@shared/llm'
import { createAnthropicProvider } from './anthropicProvider'
import { createOpenAiCompatProvider } from './openaiCompatProvider'
import { createFakeProvider } from './fakeProvider'

export function createProvider(settings: ProviderSettings, apiKey: string): LlmProvider {
  switch (settings.kind) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey, baseURL: settings.baseURL, model: settings.model })
    case 'openai-compat':
      return createOpenAiCompatProvider({ apiKey, baseURL: settings.baseURL, model: settings.model })
    case 'fake':
    default:
      return createFakeProvider({})
  }
}
```

Create `src/main/agent/testConnection.ts`:

```ts
import type { ProviderSettings } from '@shared/llm'
import { createProvider } from '../providers/createProvider'

/** 用给定配置发一条最短消息,消费到 done/error;成功返回 {ok:true}。 */
export async function testConnection(settings: ProviderSettings, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const provider = createProvider(settings, apiKey)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    for await (const chunk of provider.streamChat({
      system: '你是一个连接测试助手。',
      messages: [{ role: 'user', content: '回复"ok"即可。' }],
      maxOutputTokens: 16,
      signal: ctrl.signal
    })) {
      if (chunk.type === 'error') return { ok: false, error: chunk.message }
      if (chunk.type === 'done') return { ok: true }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均无错误(两个 SDK 类型解析正确;externalize 生效,bundle 不含 SDK 源码)。

> 若 SDK 的流式事件/字段类型名与本步代码不符(SDK 版本差异),以 `pnpm typecheck` 报错为准做最小调整(如 `content_block_delta`/`text_delta` 判别字段),保持"取文本增量"的语义不变。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml electron.vite.config.ts src/main/providers/anthropicProvider.ts src/main/providers/openaiCompatProvider.ts src/main/providers/createProvider.ts src/main/agent/testConnection.ts
git commit -m "feat(providers): Anthropic/OpenAI 兼容适配器 + 工厂 + 连接测试 + SDK 依赖/externalize"
```

---

## Task 8: IPC 契约 + preload 暴露

**Files:**
- Modify: `src/shared/ipc.ts`、`src/preload/index.ts`

**Interfaces:**
- Produces(新通道常量):`GET_SETTINGS`/`SET_SETTINGS`/`SET_API_KEY`/`HAS_KEY`/`TEST_CONNECTION`/`OPEN_SETTINGS`/`CHAT_STREAM`/`CHAT_DONE`/`CHAT_ERROR`/`CANCEL_CHAT`。
- Produces(类型):`interface SettingsSnapshot { settings:AppSettings; hasKey:boolean }`、`interface TestResult { ok:boolean; error?:string }`。
- Produces(preload):`chatApi` 增 `onStream/onDone/onError/cancel/openSettings`;新增 `settingsApi { getSettings; setSettings; setApiKey; testConnection }`。

- [ ] **Step 1: 扩 ipc.ts(通道 + 类型 + API 接口)**

Modify `src/shared/ipc.ts`:

顶部 import 增加:
```ts
import type { AppSettings, ProviderSettings } from './llm'
```

`IPC` 常量新增:
```ts
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  SET_API_KEY: 'settings:set-key',
  HAS_KEY: 'settings:has-key',
  TEST_CONNECTION: 'settings:test',
  OPEN_SETTINGS: 'settings:open',
  CHAT_STREAM: 'chat:stream',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',
  CANCEL_CHAT: 'chat:cancel',
```

新增类型:
```ts
export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean }
export interface TestResult { ok: boolean; error?: string }
```

`ChatApi` 扩展(在现有 send/onUpdate/setSize/close 基础上加):
```ts
export interface ChatApi {
  send(payload: ChatSendPayload): void
  onUpdate(cb: (messages: ChatMessage[]) => void): void
  onStream(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  cancel(): void
  setSize(collapsed: boolean): void
  close(): void
  openSettings(): void
}
```

新增 `SettingsApi` + 全局声明:
```ts
export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
}

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi }
}
```
(把原 `declare global` 的 `Window` 定义替换为上面这段,合并三者。)

- [ ] **Step 2: preload 暴露**

Modify `src/preload/index.ts` —— import 增加所需类型,`chatApi` 增方法,新增 `settingsApi`,并 `exposeInMainWorld`:

`chatApi` 增补(在对象内追加):
```ts
  onStream: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_STREAM)
    ipcRenderer.on(IPC.CHAT_STREAM, (_e, text: string) => cb(text))
  },
  onDone: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_DONE)
    ipcRenderer.on(IPC.CHAT_DONE, () => cb())
  },
  onError: (cb: (message: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_ERROR)
    ipcRenderer.on(IPC.CHAT_ERROR, (_e, message: string) => cb(message))
  },
  cancel: (): void => ipcRenderer.send(IPC.CANCEL_CHAT),
  openSettings: (): void => ipcRenderer.send(IPC.OPEN_SETTINGS),
```

新增(文件内,`contextBridge` 调用前):
```ts
import type { SettingsApi } from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'

const settingsApi: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (s: AppSettings) => ipcRenderer.invoke(IPC.SET_SETTINGS, s),
  setApiKey: (key: string) => ipcRenderer.invoke(IPC.SET_API_KEY, key),
  testConnection: (provider: ProviderSettings, key: string) => ipcRenderer.invoke(IPC.TEST_CONNECTION, { provider, key })
}
```
并在末尾:
```ts
contextBridge.exposeInMainWorld('settingsApi', settingsApi)
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 无错(此时无实现方,但类型自洽;`chatApi` 现有实现需补齐新方法 —— 见下)。

> 若 preload 里 `chatApi` 对象缺新方法会类型报错;确保 Step 2 已把 5 个新方法补进 `chatApi` 字面量。

- [ ] **Step 4: 提交**

```bash
git add src/shared/ipc.ts src/preload/index.ts
git commit -m "feat(ipc): 设置/流式/取消通道 + chatApi 流式方法 + settingsApi"
```

---

## Task 9: chat.ts 接 agent + shell/index.ts 注册 IPC + 未配置降级

**Files:**
- Modify: `src/main/shell/chat.ts`(重写)、`src/main/shell/index.ts`

**Interfaces:**
- Consumes: `loadSettings`(T5)、`createSecretStore`(T6)、`loadPersona`(T2)、`assemblePrompt`(T3)、`runAgent`(T4)、`createProvider`(T7)、`testConnection`(T7)、IPC 通道(T8)。
- Produces:`createChatStore(opts)` 新签名(见下);`chat.cancel()`。

- [ ] **Step 1: 重写 chat.ts(agent 循环 + 未配置降级 + 流式 + 取消)**

Replace `src/main/shell/chat.ts`:

```ts
import type { ChatMessage, ChatSendPayload } from '@shared/ipc'
import type { AppSettings } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { loadPersona } from '../persona/personaLoader'
import { assemblePrompt } from '../agent/promptAssembler'
import { runAgent } from '../agent/agentLoop'
import { createProvider } from '../providers/createProvider'

const TIMEOUT_MS = 60000
const MAX_OUTPUT_TOKENS = 1024
const UNCONFIGURED_REPLY = '(还没接上大脑)先在托盘「设置」里选好 Provider 并填 API Key 吧~我已帮你打开设置。'

export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
  cancel(): void
}

export function createChatStore(opts: {
  petDir: string
  loadSettings: () => AppSettings
  getKey: () => string | null
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
}): ChatStore {
  const transcript: ChatMessage[] = []
  let inFlight: AbortController | null = null

  function cancel(): void {
    if (inFlight) { inFlight.abort(); inFlight = null }
  }

  return {
    messages: () => transcript,
    cancel,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      if (!text) return
      cancel() // 新消息取消在途
      transcript.push({ role: 'user', text })
      opts.pushUpdate(transcript)
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        transcript.push({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(transcript)
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const { system, messages } = assemblePrompt(persona, transcript)
      const provider = createProvider(settings.provider, key)

      const ctrl = new AbortController()
      inFlight = ctrl
      let acc = ''
      void runAgent({
        provider,
        system,
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT_MS,
        signal: ctrl.signal,
        onText: (t) => { acc += t; opts.pushStream(t) }
      }).then((res) => {
        if (inFlight === ctrl) inFlight = null
        if (res.canceled) return // 静默丢弃
        if (res.error) {
          opts.pushError(res.error)
          opts.emitPetEvent('replyDone')
          return
        }
        transcript.push({ role: 'pet', text: acc })
        opts.pushUpdate(transcript)
        opts.pushDone()
        opts.emitPetEvent('replyDone')
      })
    }
  }
}
```

- [ ] **Step 2: shell/index.ts 装配 chat 依赖 + 注册新 IPC + 托盘设置**

Modify `src/main/shell/index.ts`:

顶部 import 增补:
```ts
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { IPC, type MoveDelta, type WindowBounds, type ChatSendPayload, type SettingsSnapshot, type TestResult } from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
import { loadSettings, saveSettings } from '../config/settings'
import { createSecretStore } from '../config/secrets'
import { testConnection } from '../agent/testConnection'
```
(与现有 import 合并去重;`safeStorage` 加进现有 `from 'electron'`。)

在 `startShell()` 内、`createChatStore` 之前,建立配置与密钥:
```ts
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  const secrets = createSecretStore(join(app.getPath('userData'), 'secrets.bin'), safeStorage)
```

把 `createChatStore` 的构造改为新签名(替换原 `{ petDir, emitPetEvent, pushUpdate }`):
```ts
  const chat = createChatStore({
    petDir,
    loadSettings: () => loadSettings(settingsFile),
    getKey: () => secrets.getKey(),
    emitPetEvent,
    pushUpdate: (msgs) => dialog.pushUpdate(msgs),
    pushStream: (t) => dialog.window()?.webContents.send(IPC.CHAT_STREAM, t),
    pushDone: () => dialog.window()?.webContents.send(IPC.CHAT_DONE),
    pushError: (m) => dialog.window()?.webContents.send(IPC.CHAT_ERROR, m),
    openSettings: () => openSettings()
  })
```

新增 `openSettings()`(Task 10 提供 `settingsWindow`;本任务先占位为空函数,Task 10 替换):
```ts
  function openSettings(): void { /* Task 10 接入 settingsWindow */ }
```

在 IPC 区新增 handler(放现有 `CHAT_SEND` 附近):
```ts
  ipcMain.on(IPC.CANCEL_CHAT, () => chat.cancel())
  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettings())
  ipcMain.handle(IPC.GET_SETTINGS, async (): Promise<SettingsSnapshot> => ({
    settings: loadSettings(settingsFile),
    hasKey: secrets.hasKey()
  }))
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, s: AppSettings) => { saveSettings(settingsFile, s) })
  ipcMain.handle(IPC.SET_API_KEY, async (_e, key: string): Promise<boolean> => secrets.setKey(String(key ?? '')))
  ipcMain.handle(IPC.TEST_CONNECTION, async (_e, arg: { provider: ProviderSettings; key: string }): Promise<TestResult> =>
    testConnection(arg.provider, arg.key)
  )
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/main/shell/chat.ts src/main/shell/index.ts
git commit -m "feat(chat): 对话走真 agent 循环 + 流式/取消 + 未配置降级到设置 + 设置 IPC"
```

---

## Task 10: 首启设置窗(第三渲染入口 + 托盘 + 首启弹出)

**Files:**
- Create: `src/main/shell/settingsWindow.ts`、`src/renderer/settings.html`、`src/renderer/settings.ts`
- Modify: `electron.vite.config.ts`(第三入口)、`src/main/shell/index.ts`(接 openSettings + 托盘 + 首启)、`src/main/shell/tray.ts`(加"设置"项 —— 见下改为回调式)

**Interfaces:**
- Produces: `createSettingsWindow(opts:{ preload; url?; settingsHtml }): { open():void }`。

- [ ] **Step 1: electron.vite.config renderer 加第三入口**

Modify `electron.vite.config.ts` renderer.rollupOptions.input,增加 `settings`:
```ts
        input: {
          index: resolve('src/renderer/index.html'),
          dialog: resolve('src/renderer/dialog.html'),
          settings: resolve('src/renderer/settings.html')
        }
```

- [ ] **Step 2: 写 settingsWindow.ts**

Create `src/main/shell/settingsWindow.ts`:

```ts
import { BrowserWindow } from 'electron'

export interface SettingsController { open(): void }

export function createSettingsWindow(opts: {
  preload: string
  url: string | undefined // dev: `${rendererUrl}/settings.html`
  settingsHtml: string
}): SettingsController {
  let win: BrowserWindow | null = null

  function build(): BrowserWindow {
    const w = new BrowserWindow({
      width: 460,
      height: 520,
      title: '设置',
      resizable: false,
      skipTaskbar: false,
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    if (opts.url) w.loadURL(opts.url)
    else w.loadFile(opts.settingsHtml)
    w.on('closed', () => { win = null })
    return w
  }

  return {
    open(): void {
      if (!win) win = build()
      win.show()
      win.focus()
    }
  }
}
```

- [ ] **Step 3: 写 settings.html**

Create `src/renderer/settings.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
    <style>
      html, body { margin: 0; font-family: system-ui, sans-serif; font-size: 13px; background: #1e1e28; color: #f0f0f4; }
      #app { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      h1 { font-size: 15px; margin: 0 0 4px; }
      label { display: flex; flex-direction: column; gap: 4px; }
      select, input { border: none; border-radius: 8px; padding: 8px; background: rgba(255,255,255,0.12); color: #f0f0f4; }
      .row { display: flex; gap: 8px; align-items: center; }
      button { border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; background: rgba(90,110,200,0.95); color: #fff; }
      button.secondary { background: rgba(255,255,255,0.16); }
      #status { min-height: 18px; opacity: 0.85; }
    </style>
  </head>
  <body>
    <div id="app">
      <h1>宠物大脑设置</h1>
      <label>Provider 预设
        <select id="preset"></select>
      </label>
      <label>Base URL(可留空用默认)
        <input id="baseURL" type="text" placeholder="https://..." />
      </label>
      <label>模型
        <input id="model" type="text" />
      </label>
      <label>API Key
        <input id="key" type="password" placeholder="仅本机加密存储,不外传" />
      </label>
      <div class="row">
        <button id="test" class="secondary">测试连接</button>
        <button id="save">保存</button>
      </div>
      <div id="status"></div>
    </div>
    <script type="module" src="./settings.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: 写 settings.ts**

Create `src/renderer/settings.ts`:

```ts
import { PRESETS, type ProviderSettings, type ProviderKind } from '@shared/llm'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const preset = $<HTMLSelectElement>('preset')
const baseURL = $<HTMLInputElement>('baseURL')
const model = $<HTMLInputElement>('model')
const key = $<HTMLInputElement>('key')
const status = $<HTMLElement>('status')

for (const p of PRESETS) {
  const opt = document.createElement('option')
  opt.value = p.id
  opt.textContent = p.label
  preset.appendChild(opt)
}

function kindOf(presetId: string): ProviderKind {
  return PRESETS.find((p) => p.id === presetId)?.kind ?? 'anthropic'
}

function applyPreset(presetId: string): void {
  const p = PRESETS.find((x) => x.id === presetId)
  if (!p) return
  baseURL.value = p.baseURL ?? ''
  model.value = p.defaultModel
}

function currentProvider(): ProviderSettings {
  return {
    kind: kindOf(preset.value),
    baseURL: baseURL.value.trim() || undefined,
    model: model.value.trim()
  }
}

preset.addEventListener('change', () => applyPreset(preset.value))

$<HTMLButtonElement>('test').addEventListener('click', async () => {
  status.textContent = '测试中…'
  const res = await window.settingsApi.testConnection(currentProvider(), key.value)
  status.textContent = res.ok ? '✓ 连接成功' : `✗ ${res.error ?? '连接失败'}`
})

$<HTMLButtonElement>('save').addEventListener('click', async () => {
  const provider = currentProvider()
  if (key.value) {
    const ok = await window.settingsApi.setApiKey(key.value)
    if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Key'; return }
  }
  await window.settingsApi.setSettings({ schemaVersion: 1, provider })
  status.textContent = '✓ 已保存'
})

// 初始化:回填已存设置
void (async () => {
  const snap = await window.settingsApi.getSettings()
  const kind = snap.settings.provider.kind
  const match = PRESETS.find((p) => p.kind === kind && (p.baseURL ?? '') === (snap.settings.provider.baseURL ?? ''))
  preset.value = match?.id ?? PRESETS[0].id
  applyPreset(preset.value)
  if (snap.settings.provider.baseURL) baseURL.value = snap.settings.provider.baseURL
  if (snap.settings.provider.model) model.value = snap.settings.provider.model
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
})()
```

- [ ] **Step 5: shell/index.ts 接入 settingsWindow + 托盘"设置" + 首启弹出**

Modify `src/main/shell/index.ts`:

import 增补:
```ts
import { createSettingsWindow } from './settingsWindow'
```

在 `startShell()` 内构造(用现有 `preload`/`rendererUrl`/`dirname`):
```ts
  const settings = createSettingsWindow({
    preload,
    url: rendererUrl ? `${rendererUrl}/settings.html` : undefined,
    settingsHtml: join(dirname, '../renderer/settings.html')
  })
```

把之前的占位 `function openSettings(){}` 改为:
```ts
  function openSettings(): void { settings.open() }
```

托盘加"设置"项 —— 把 `createTray` 改为接受菜单回调。Modify `src/main/shell/tray.ts`:
```ts
import { Tray, Menu, nativeImage, app } from 'electron'

export function createTray(iconPath: string, onSettings: () => void): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Pet Agent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置', click: () => onSettings() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  return tray
}
```
在 `index.ts` 里把 `tray = createTray(join(appRoot, 'resources/tray.png'))` 改为:
```ts
  tray = createTray(join(appRoot, 'resources/tray.png'), openSettings)
```

首启弹出(在 `registerHotkeys` 附近):
```ts
  if (!secrets.hasKey()) openSettings()
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误;`out/renderer/settings.html` 产出。

- [ ] **Step 7: 提交**

```bash
git add electron.vite.config.ts src/main/shell/settingsWindow.ts src/renderer/settings.html src/renderer/settings.ts src/main/shell/tray.ts src/main/shell/index.ts
git commit -m "feat(settings): 首启设置窗(预设/baseURL/model/key + 测试连接)+ 托盘设置 + 首启弹出"
```

---

## Task 11: 对话框逐字流式渲染

**Files:**
- Modify: `src/renderer/dialog.ts`

**Interfaces:**
- Consumes: `chatApi.onStream/onDone/onError/cancel/openSettings`(T8)。

- [ ] **Step 1: dialog.ts 接流式**

Modify `src/renderer/dialog.ts` —— 在现有 `window.chatApi.onUpdate(render)` 附近,加流式处理与"进行中气泡"。完整替换文件(在 MVP-02 双态逻辑基础上加流式):

> 先 Read 现有 `src/renderer/dialog.ts` 确认结构,再做以下增补:保留 `render`/`setCollapsed`/`submit`/`showBubble`,新增一个"进行中 pet 文本"缓冲与流式渲染。

在文件顶部常量后加流式状态:
```ts
let streaming = '' // 进行中的 pet 回复(逐字累积)
```

在 `window.chatApi.onUpdate(render)` 之后追加:
```ts
window.chatApi.onStream((text) => {
  streaming += text
  showBubble(streaming)           // 常态气泡实时增长
  renderStreaming()               // 展开态历史底部显示进行中气泡
})
window.chatApi.onDone(() => { streaming = '' /* onUpdate 已带最终 transcript */ })
window.chatApi.onError((message) => {
  streaming = ''
  showBubble(`⚠ ${message}`)
  const el = document.createElement('div')
  el.className = 'msg pet'
  el.textContent = `⚠ ${message}`
  history.appendChild(el)
  history.scrollTop = history.scrollHeight
})
```

新增 `renderStreaming`(在展开态历史底部追加/更新一条临时气泡):
```ts
function renderStreaming(): void {
  let temp = document.getElementById('streaming-msg')
  if (!temp) {
    temp = document.createElement('div')
    temp.id = 'streaming-msg'
    temp.className = 'msg pet'
    history.appendChild(temp)
  }
  temp.textContent = streaming
  history.scrollTop = history.scrollHeight
}
```

并在 `render(messages)`(onUpdate)开头清掉临时流式气泡(最终 transcript 到达时):
```ts
  const temp = document.getElementById('streaming-msg')
  if (temp) temp.remove()
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/dialog.ts
git commit -m "feat(dialog): 逐字流式渲染(进行中气泡 + 完成清理 + 错误气泡)"
```

---

## Task 12: 真机全量验收 + 清理 + PROGRESS

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 全绿(petBrain/spritePlayer/petLoader + 新增 fakeProvider/personaLoader/promptAssembler/agentLoop/settings/secrets)。

- [ ] **Step 2: 构建 + 真机验收(人工,填真 key)**

Run: `pnpm build && pnpm preview`
Expected(肉眼,分两种 Provider 各验一次):
1. 首次启动(无 key)→ 自动弹设置窗;托盘"设置"可再开。
2. 选 **Claude** 预设(默认 `claude-haiku-4-5`)填 key → "测试连接"成功 → 保存。
3. 单击宠物开对话框,发消息 → 宠物 thinking,回复**逐字流式**出现,结束宠物 talk→idle;历史保留。
4. 再选一个 **OpenAI 兼容**端点(如 DeepSeek/通义,填对应 base_url+key+model)→ 测试连接 + 对话流式正常。
5. 流式中**再次发送**或**关对话框** → 旧回复被取消,不串台。
6. 未配置时发消息 → 提示去设置 + 自动开设置窗(不出现 lines.json 占位)。
7. 错误(如填错 key)→ 对话框显错误气泡,宠物回 idle 不卡 thinking。
8. MVP-02 行为不回归:自主游走/睡、拖拽自由、双态对话框、气泡淡出、透明穿透、托盘退出。

> 若某 Provider 的流式事件字段与 Task 7 代码不符,按 `CHAT_ERROR` 现象定位,回到对应 provider 文件做最小修正。

- [ ] **Step 3: 更新 PROGRESS.md**

Modify `PROGRESS.md`:
- 顶部状态与 §1:MVP-03 已完成,下一步 MVP-04。
- §6 路线图:`✅ MVP-03`。
- §4 代码地图:补 `src/main/providers/*`、`agent/*`、`config/*`、`persona/*`、`src/renderer/settings.*`。
- 更新时间为完成当日。

- [ ] **Step 4: 提交**

```bash
git add PROGRESS.md
git commit -m "chore(mvp-03): 全量验收 + 更新 PROGRESS(MVP-03 完成)"
```

---

## 完成后

`superpowers:finishing-a-development-branch` 收尾(合并/PR 由用户定)。

---

## Self-Review(计划自检)

**Spec 覆盖:**
- §1 Provider 抽象 + 三实现 → Task 1(接口+Fake)、Task 7(Anthropic/OpenAI 兼容+工厂)✅
- §6 密钥 safeStorage + §5 settings 原子写/schemaVersion → Task 5/6 ✅
- §7 首启设置窗 + 未配置降级 → Task 10 + Task 9(降级到设置)✅
- §8 agent 循环 + prompt 组装(§5.4 记忆位空)+ §5.6 护栏 → Task 3/4/9 ✅
- §9 流式 IPC + 动画联动(thinking 全程 / talk 收尾)→ Task 8/9/11 ✅
- §10 依赖 @anthropic-ai/sdk + openai + externalize → Task 7 ✅
- §11 测试(fake-first TDD)→ Task 1–6 单测 + Task 12 真机 ✅
- §12 安全(key 不外泄/主进程/CSP)→ Task 6/9/10 ✅
- §13 识图/记忆接缝(attachments 已在;记忆位注释)→ promptAssembler 占位 ✅
- 拍板:默认 haiku-4-5(llm.ts DEFAULT_SETTINGS + presets)、未配置→设置(chat.ts)、装两个 SDK(Task 7)✅

**Placeholder 扫描:** 无 TBD;每个改码步骤给了完整代码。两处显式"实现期按 SDK 报错微调字段"(Task 7 Step 6、Task 12 Step 2)是对第三方 SDK 版本差异的合理留口,非占位。Task 11 Step 1 要求先 Read 现有 dialog.ts 再增补(已注明)。

**类型一致性:** `LlmProvider`/`StreamChatRequest`/`StreamChunk`/`ChatTurn`/`ProviderSettings`/`AppSettings`/`Preset` 全程一致;`AgentRunOptions/Result` 在 Task 4 定义、Task 9 使用一致;IPC 通道全用 `IPC.*`;`createChatStore` 新签名在 Task 9 定义并由 shell/index.ts 装配;`createSecretStore(file, safe)`/`loadSettings(file)`/`createProvider(settings, key)`/`assemblePrompt(persona, transcript)`/`runAgent(opts)` 签名前后一致。
