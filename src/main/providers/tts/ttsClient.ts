/** minimal_tts sidecar 客户端,移植自 minimal_tts/electron/AliceTts.ts,依赖全部注入
 *  (spawn/WebSocket/clock),供测试用假实现替换,也解决主进程 Node 20 上下文没有
 *  全局 WebSocket 的问题(由调用方注入一个真实 ws 实例的构造函数)。 */
import type { TtsLanguage } from '@shared/llm'
import {
  type ClientMessage, type ReadyEvent, type ServerEvent,
  isBinaryMessage, parseServerEvent, toArrayBuffer
} from './protocol'
import { createSentenceBuffer, type SentenceBuffer } from './sentenceBuffer'

export interface SpawnedProcess {
  stdout: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void } | null
  stderr: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void } | null
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'exit', cb: (code: number | null) => void): void
  kill(signal?: string): void
}

export interface MinimalWebSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  /** 可选:真实 ws 实例上存在,默认 'nodebuffer'。调用方应在构造时把它设为
   *  'arraybuffer',否则二进制帧会以 Node Buffer 形式交付,见 protocol.ts 的
   *  isBinaryMessage/toArrayBuffer 注释。仅用于文档化该字段,创建处仍在真实
   *  WebSocket 类型上赋值。 */
  binaryType?: string
}

const WS_OPEN = 1

export interface TtsClockLike {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(h: ReturnType<typeof setTimeout>): void
}

export interface TtsClientOptions {
  pythonExe: string
  packageRoot: string
  startupTimeoutMs?: number
  spawn: (exe: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProcess
  createWebSocket: (url: string) => MinimalWebSocket
  clock?: TtsClockLike
  onAudio?: (id: string, pcm: ArrayBuffer, sampleRate: number) => void
  onEvent?: (event: ServerEvent) => void
}

export interface TtsClient {
  start(): Promise<ReadyEvent>
  begin(id: string, language: TtsLanguage): void
  pushToken(token: string): void
  finish(): void
  cancel(): void
  close(): Promise<void>
}

export function createTtsClient(opts: TtsClientOptions): TtsClient {
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30000
  const clock: TtsClockLike = opts.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h)
  }

  let child: SpawnedProcess | null = null
  let ws: MinimalWebSocket | null = null
  let ready: ReadyEvent | null = null
  let sequence = 0
  let activeId: string | null = null
  let currentSampleRate = 0
  const buffer: SentenceBuffer = createSentenceBuffer({ onIdle: () => flushBuffer() })

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg))
  }

  function enqueueSegment(text: string): void {
    if (!activeId) return
    send({ type: 'enqueue', id: activeId, sequence: sequence++, text })
  }

  function flushBuffer(): void {
    const remaining = buffer.flush()
    if (remaining) enqueueSegment(remaining)
  }

  function handleMessage(data: unknown): void {
    if (isBinaryMessage(data)) {
      if (activeId) opts.onAudio?.(activeId, toArrayBuffer(data), currentSampleRate)
      return
    }
    if (typeof data !== 'string') return
    let event: ServerEvent
    try { event = parseServerEvent(data) } catch { return }
    if (event.type === 'audio_start') currentSampleRate = event.sampleRate
    if (event.type === 'done' || event.type === 'cancelled') activeId = null
    opts.onEvent?.(event)
  }

  function spawnAndReadReady(): Promise<ReadyEvent> {
    return new Promise<ReadyEvent>((resolve, reject) => {
      const proc = opts.spawn(opts.pythonExe, ['-B', '-m', 'service'], {
        cwd: opts.packageRoot,
        env: { ...process.env, PYTHONPATH: opts.packageRoot, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
      })
      child = proc

      let stdoutBuf = ''
      let resolved = false
      const timer = clock.setTimeout(() => {
        if (resolved) return
        resolved = true
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error('TTS sidecar startup timed out'))
      }, startupTimeoutMs)

      proc.stdout?.setEncoding('utf-8')
      proc.stdout?.on('data', (chunk: string) => {
        if (resolved) return
        stdoutBuf += chunk
        const newlineIdx = stdoutBuf.indexOf('\n')
        if (newlineIdx === -1) return
        const line = stdoutBuf.substring(0, newlineIdx).trim()
        stdoutBuf = stdoutBuf.substring(newlineIdx + 1)
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj['type'] === 'ready') {
            resolved = true
            clock.clearTimeout(timer)
            resolve(obj as unknown as ReadyEvent)
          }
        } catch { /* not a JSON ready line yet */ }
      })
      proc.stderr?.setEncoding('utf-8')
      proc.stderr?.on('data', () => { /* main 进程可按需接管日志,MVP 不做 */ })
      proc.on('error', (err: Error) => {
        if (resolved) return
        resolved = true
        clock.clearTimeout(timer)
        reject(new Error(`Failed to spawn TTS sidecar: ${err.message}`))
      })
      proc.on('exit', (code: number | null) => {
        if (resolved) return
        resolved = true
        clock.clearTimeout(timer)
        reject(new Error(`TTS sidecar exited before ready (code ${code})`))
      })
    })
  }

  function connectWebSocket(url: string): Promise<MinimalWebSocket> {
    return new Promise<MinimalWebSocket>((resolve, reject) => {
      const socket = opts.createWebSocket(url)
      const timer = clock.setTimeout(() => {
        try { socket.close() } catch { /* ignore */ }
        reject(new Error('WebSocket connection timed out'))
      }, 5000)
      socket.onopen = () => { clock.clearTimeout(timer); resolve(socket) }
      socket.onerror = () => {
        if (socket.readyState !== WS_OPEN) { clock.clearTimeout(timer); reject(new Error('WebSocket connection failed')) }
      }
    })
  }

  return {
    async start(): Promise<ReadyEvent> {
      if (ready) return ready
      const r = await spawnAndReadReady()
      const socket = await connectWebSocket(`ws://${r.host}:${r.port}/?token=${r.token}`)
      socket.onmessage = (ev) => handleMessage(ev.data)
      socket.onerror = () => {}
      socket.onclose = () => {}
      ws = socket
      ready = r
      return r
    },
    begin(id, language): void {
      activeId = id
      sequence = 0
      buffer.clear()
      send({ type: 'start', id, language })
    },
    pushToken(token): void {
      for (const segment of buffer.push(token)) enqueueSegment(segment)
    },
    finish(): void {
      flushBuffer()
      if (activeId) send({ type: 'finish', id: activeId })
    },
    cancel(): void {
      if (activeId) send({ type: 'cancel', id: activeId })
      buffer.clear()
      activeId = null
    },
    async close(): Promise<void> {
      buffer.clear()
      if (ws) { try { ws.close() } catch { /* ignore */ } ws = null }
      if (child) { try { child.kill('SIGTERM') } catch { /* ignore */ } child = null }
      ready = null
      activeId = null
    }
  }
}
