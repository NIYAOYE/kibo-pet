import type { ChatMessage, ChatSendPayload, ChatSendAttachment } from '@shared/ipc'
import type { AppSettings, ProviderSettings, ImagePart } from '@shared/llm'
import type { PetEvent } from '@shared/petBrain'
import { createReplyPresenter, type ReplyPresenter, type VoiceReplyGate } from './replyPresenter'
import { loadPersona } from '../persona/personaLoader'
import { assemblePrompt } from '../agent/promptAssembler'
import { runAgent } from '../agent/agentLoop'
import { createProvider } from '../providers/createProvider'
import type { LlmProvider } from '../providers/llmProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import { createWebSearchTool } from '../tools/webSearch'
import { createReadSkillTool } from '../tools/readSkill'
import { createSaveMemoryTool } from '../tools/saveMemory'
import { createDuckDuckGoBackend } from '../tools/searchBackends/duckduckgo'
import { createTavilyBackend } from '../tools/searchBackends/tavily'
import { createReadClipboardTool, createWriteClipboardTool } from '../tools/clipboardTools'
import { createTodoTools } from '../tools/todoTools'
import { createWeatherTool, createOpenMeteoClient } from '../tools/weather'
import { createFirecrawlClient } from '../tools/firecrawl/firecrawlClient'
import { createReadUrlTool } from '../tools/firecrawl/readUrl'
import { createExtractFromUrlTool } from '../tools/firecrawl/extractFromUrl'
import { createLive2DPerformanceTool } from '../tools/live2dPerformance'
import type { SkillIndex } from '../skills/skillLoader'
import type { MemoryManager } from '../memory/memoryManager'
import type { TodoStore } from '../todos/todoStore'

const TIMEOUT_MS = 60000
const MAX_OUTPUT_TOKENS = 1024
// 桌面控制开启时提高单轮输出 token 上限:宠物人设旁白 + 工具调用参数(尤其
// take_screenshot 之后的分析文字、type_text 的长文本)容易一起挤爆默认的 1024,
// 真机验证复现过:回复被截断导致工具调用的 JSON 参数不完整,模型"有输入的意图
// 但从未真正调用成功"——见 messageMapping/agentLoop 对截断的兜底(该兜底防止静默
// 失败,但更大的预算能从源头降低触发概率)。推理模型(如 gpt-5.5)的内部思考也计入
// 输出预算,4096 偏紧、容易在生成可见内容前就被截断,调到 8192。
const DESKTOP_CONTROL_MAX_OUTPUT_TOKENS = 8192
const UNCONFIGURED_REPLY = '(还没接上大脑)先在托盘「设置」里选好 Provider 并填 API Key 吧~我已帮你打开设置。'
export interface ChatStore {
  messages(): ChatMessage[]
  handleSend(payload: ChatSendPayload): void
  cancel(): void
}

export function createChatStore(opts: {
  petDir: string
  skills: SkillIndex
  memory: MemoryManager
  todoStore: TodoStore
  loadSettings: () => AppSettings
  getKey: () => string | null
  getSearchKey: () => string | null
  getFirecrawlKey: () => string | null
  /** 桌面控制六个工具的真实构造器;未注入(如多数既有测试)则该能力永不出现,与 settings 开关无关 */
  buildDesktopTools?: () => import('../tools/toolSpec').ToolSpec[]
  /** 给桌面控制工具套上指示器显隐等生命周期钩子;省略则原样返回 */
  wrapDesktopTools?: (tools: import('../tools/toolSpec').ToolSpec[]) => import('../tools/toolSpec').ToolSpec[]
  /** 桌面控制工具挂载时(每次 handleSend)调用一次,取得本轮 token;与 endDesktopControlTurn 配对包住整轮多步任务 */
  beginDesktopControlTurn?: () => number
  /** 整轮(含所有工具调用轮次)结束时调用一次,无论成功/取消/出错 */
  endDesktopControlTurn?: (token: number) => void
  /** 浏览器自动化工具的真实构造器;未注入则该能力永不出现,与 settings 开关无关 */
  buildBrowserTools?: () => import('../tools/toolSpec').ToolSpec[]
  /** Current renderer-reported Live2D capabilities. Omitted for sprite pets or before report. */
  getLive2DCapabilitySnapshot?: () => import('@shared/live2dPerformance').Live2DCapabilitySnapshot | null
  /** Dispatches a validated performance only if the active pet is still current. */
  dispatchLive2DPerformance?: (instruction: import('@shared/live2dPerformance').Live2DPerformanceInstruction) => boolean
  /** 测试注入缝;生产默认 createProvider */
  makeProvider?: (provider: ProviderSettings, key: string) => LlmProvider
  /** 主进程注入的图像预处理(chat.ts 不 import electron;测试注入直通实现) */
  prepareImages: (attachments: ChatSendAttachment[]) => ImagePart[]
  /** 注入的剪贴板门面(chat.ts 不 import electron;测试注入假实现) */
  clipboard: { readText: () => string; writeText: (t: string) => void }
  emitPetEvent: (event: PetEvent) => void
  pushUpdate: (messages: ChatMessage[]) => void
  pushStream: (text: string) => void
  pushStatus: (text: string) => void
  pushDone: () => void
  pushError: (message: string) => void
  openSettings: () => void
  /** 语音(GSV-TTS-Lite)朗读接线;未注入则该功能整体不存在,与 settings.tts.enabled 无关(同 desktopControl 的注入式惯例) */
  voice?: VoiceReplyGate & { stop: () => void }
}): ChatStore {
  const make = opts.makeProvider ?? createProvider
  let inFlight: AbortController | null = null
  let activePresenter: ReplyPresenter | null = null
  let generation = 0

  interface ActiveReply {
    ctrl: AbortController
    presenter: ReplyPresenter
    generation: number
  }

  function beginReply(): ActiveReply {
    const ctrl = new AbortController()
    const presenter = createReplyPresenter({ voice: opts.voice, pushStream: opts.pushStream })
    const reply = { ctrl, presenter, generation: ++generation }
    inFlight = ctrl
    activePresenter = presenter
    return reply
  }

  function isActive(reply: ActiveReply): boolean {
    return reply.generation === generation && inFlight === reply.ctrl && activePresenter === reply.presenter && !reply.ctrl.signal.aborted
  }

  function clearReply(reply: ActiveReply): void {
    if (!isActive(reply)) return
    inFlight = null
    activePresenter = null
  }

  function cancel(): void {
    generation++
    activePresenter?.cancel()
    activePresenter = null
    if (inFlight) { inFlight.abort(); inFlight = null }
    opts.voice?.stop()
  }

  return {
    messages: () => opts.memory.messages(),
    cancel,
    handleSend(payload: ChatSendPayload): void {
      const text = (payload?.text ?? '').trim()
      const rawAtts = payload?.attachments ?? []
      const hasImages = rawAtts.length > 0
      if (!text && !hasImages) return
      cancel() // 新消息取消在途

      // 单一预处理点:注入的 prepareImages 产出最终 ImagePart(图片永不落盘)
      const images: ImagePart[] = hasImages ? opts.prepareImages(rawAtts) : []
      // transcript 只存文本占位 + 标记;带图时前缀 [图片],让后续文本窗口知道这轮有图
      const storedText = hasImages ? (text ? `[图片] ${text}` : '[图片]') : text
      opts.memory.appendMessage(
        hasImages
          ? { role: 'user', text: storedText, attachments: rawAtts.map(() => ({ kind: 'image' as const })) }
          : { role: 'user', text: storedText }
      )
      opts.pushUpdate(opts.memory.messages())
      opts.emitPetEvent('messageSent')

      const key = opts.getKey()
      if (!key) {
        opts.memory.appendMessage({ role: 'pet', text: UNCONFIGURED_REPLY })
        opts.pushUpdate(opts.memory.messages())
        opts.emitPetEvent('replyDone')
        opts.openSettings()
        return
      }

      const settings = opts.loadSettings()
      const persona = loadPersona(opts.petDir)
      const provider = make(settings.provider, key)
      // 每次发送按当前设置构建后端与工具(设置可能在两次发送之间变更)
      const backend = settings.search.backend === 'tavily'
        ? createTavilyBackend(() => opts.getSearchKey())
        : createDuckDuckGoBackend()
      const tools = [
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t)),
        createReadClipboardTool({ readText: () => opts.clipboard.readText() }),
        createWriteClipboardTool({ writeText: (t) => opts.clipboard.writeText(t) }),
        ...createTodoTools({ store: opts.todoStore, now: () => Date.now() }),
        createWeatherTool(createOpenMeteoClient())
      ]
      if (settings.firecrawl.enabled && opts.getFirecrawlKey()) {
        const fc = createFirecrawlClient({ getKey: opts.getFirecrawlKey, baseURL: settings.firecrawl.baseURL })
        tools.push(createReadUrlTool(fc), createExtractFromUrlTool(fc))
      }
      // 桌面控制人工接管安全网(manualOverrideWatch)以"整轮多步任务"为边界启动/停止,
      // 而不是每次单个工具调用——否则两次工具调用之间(模型思考的几秒)会失去监控。
      // token 非 null 才需要在下面收尾时调用 endDesktopControlTurn,与 beginDesktopControlTurn 配对。
      let desktopControlTurnToken: number | null = null
      if (settings.desktopControl.enabled && opts.buildDesktopTools) {
        const wrap = opts.wrapDesktopTools ?? ((t: typeof tools) => t)
        tools.push(...wrap(opts.buildDesktopTools()))
        desktopControlTurnToken = opts.beginDesktopControlTurn?.() ?? null
      }
      if (settings.browserControl.enabled && opts.buildBrowserTools) {
        tools.push(...opts.buildBrowserTools())
      }
      const live2dSnapshot = opts.getLive2DCapabilitySnapshot?.()
      if (live2dSnapshot && opts.dispatchLive2DPerformance) {
        tools.push(createLive2DPerformanceTool({
          snapshot: live2dSnapshot,
          dispatch: opts.dispatchLive2DPerformance
        }))
      }
      const registry = createToolRegistry(tools)

      const reply = beginReply()
      void (async () => {
        try {
          // 召回在 runAgent 之前;recall 永不抛(内部退化),取消则直接放弃
          const recalled = await opts.memory.recall(text, reply.ctrl.signal)
          if (!isActive(reply)) return
          const { system, messages } = assemblePrompt(
            persona,
            opts.memory.messages(),
            opts.skills.list(),
            recalled,
            Date.now(),
            tools.length > 0
          )
          // 图挂当前回合:窗口末条即刚追加的 user 消息(assemblePrompt 已裁到 user 起头)
          const lastUser = messages[messages.length - 1]
          if (images.length > 0 && lastUser && lastUser.role === 'user') lastUser.images = images
          const needsBiggerBudget = settings.desktopControl.enabled || settings.browserControl.enabled
          // 浏览器任务比桌面点击任务更容易多耗轮次(每次页面跳转/被弹窗挡住都要多试几次才能
          // 绕开),真机验收撞过 20 轮上限——20 轮改成两档:仅 desktopControl 时维持 20(未观察到
          // 问题,不动它),browserControl 开启时给 40(即便同时也开了 desktopControl)。
          const maxToolRounds = settings.browserControl.enabled ? 40 : settings.desktopControl.enabled ? 20 : undefined
          const res = await runAgent({
            provider,
            system,
            messages,
            registry,
            maxToolRounds,
            maxOutputTokens: needsBiggerBudget ? DESKTOP_CONTROL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
            timeoutMs: TIMEOUT_MS,
            signal: reply.ctrl.signal,
            onText: (t) => { if (isActive(reply)) reply.presenter.append(t) },
            onStatus: (t) => { if (isActive(reply)) opts.pushStatus(t) }
          })
          if (!isActive(reply) || res.canceled) { clearReply(reply); return }
          await reply.presenter.finish()
          if (!isActive(reply)) return
          const replyText = reply.presenter.getText()
          // 该回合用过的工具名落进 pet 消息(工具往返本身不落盘,这是跨回合感知的唯一线索)
          const actions = res.toolsUsed && res.toolsUsed.length > 0 ? { actions: res.toolsUsed } : {}
          if (res.error) {
            // 有部分文本(如轮数上限)时先落 transcript,再报错
            if (replyText) opts.memory.appendMessage({ role: 'pet', text: replyText, ...actions })
            opts.pushUpdate(opts.memory.messages())
            opts.pushError(res.error)
            opts.emitPetEvent('replyDone')
          } else {
            opts.memory.appendMessage({ role: 'pet', text: replyText, ...actions })
            opts.pushUpdate(opts.memory.messages())
            opts.pushDone()
            opts.emitPetEvent('replyDone')
          }
          clearReply(reply)
          // 回复收尾后检查滚动摘要(异步后台,不阻塞下一条)
          opts.memory.maybeSummarize(() => {
            const k = opts.getKey()
            return k ? make(settings.provider, k) : null
          })
        } finally {
          // 无论正常结束/取消/出错,整轮任务收尾时都要关闭人工接管安全网——
          // 与上面 beginDesktopControlTurn 配对,token 校验见 toolIndicatorGate。
          if (desktopControlTurnToken !== null) opts.endDesktopControlTurn?.(desktopControlTurnToken)
        }
      })()
    }
  }
}
