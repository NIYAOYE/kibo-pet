import { describe, it, expect, vi } from 'vitest'
import { createTtsClient, type SpawnedProcess, type MinimalWebSocket } from './ttsClient'
import type { ServerEvent } from './protocol'

function fakeChild(): SpawnedProcess & { emitStdout: (line: string) => void; emitExit: (code: number | null) => void; emitError: (e: Error) => void } {
  const stdoutHandlers: Array<(chunk: string) => void> = []
  const exitHandlers: Array<(code: number | null) => void> = []
  const errorHandlers: Array<(e: Error) => void> = []
  return {
    stdout: { setEncoding: () => {}, on: (_e, cb) => { stdoutHandlers.push(cb) } },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: (event, cb) => { if (event === 'exit') exitHandlers.push(cb as (code: number | null) => void); if (event === 'error') errorHandlers.push(cb as (e: Error) => void) },
    kill: vi.fn(),
    emitStdout(line: string) { for (const h of stdoutHandlers) h(line) },
    emitExit(code) { for (const h of exitHandlers) h(code) },
    emitError(e) { for (const h of errorHandlers) h(e) }
  }
}

function fakeWebSocket(): MinimalWebSocket & { emitMessage: (data: unknown) => void; sent: string[] } {
  const sent: string[] = []
  const ws: MinimalWebSocket & { emitMessage: (data: unknown) => void; sent: string[] } = {
    readyState: 1,
    send: (data: string) => { sent.push(data) },
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    sent,
    emitMessage(data: unknown) { ws.onmessage?.({ data }) }
  }
  return ws
}

const readyLine = JSON.stringify({ type: 'ready', protocol: 1, host: '127.0.0.1', port: 49152, token: 'tok', device: 'cpu', precision: 'fp32' }) + '\n'

describe('createTtsClient', () => {
  it('start():解析 ready 行、建立 WebSocket 连接后 resolve', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe',
      packageRoot: 'C:\\pkg',
      spawn: () => child,
      createWebSocket: () => ws
    })
    const startPromise = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    const ready = await startPromise
    expect(ready.port).toBe(49152)
    expect(ready.token).toBe('tok')
  })

  it('start() 前 kill 掉的进程 / 无 ready 行直接 exit → reject', async () => {
    const child = fakeChild()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => fakeWebSocket()
    })
    const p = client.start()
    child.emitExit(1)
    await expect(p).rejects.toThrow('TTS sidecar exited before ready')
  })

  it('begin/pushToken/finish 按顺序发送 start → enqueue(累计 sequence)→ finish 消息', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p

    client.begin('r1', 'zh')
    client.pushToken('你好。')  // 强标点立即切出一个 segment
    client.finish()

    const msgs = ws.sent.map((s) => JSON.parse(s))
    expect(msgs[0]).toEqual({ type: 'start', id: 'r1', language: 'zh' })
    expect(msgs[1]).toEqual({ type: 'enqueue', id: 'r1', sequence: 0, text: '你好。' })
    expect(msgs[2]).toEqual({ type: 'finish', id: 'r1' })
  })

  it('cancel() 发送 cancel 消息并清空缓冲(cancel 后 pushToken 不会补发遗留内容)', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p

    client.begin('r1', 'zh')
    client.pushToken('没说完') // 无标点,停在 buffer 里
    client.cancel()
    const msgs = ws.sent.map((s) => JSON.parse(s))
    expect(msgs[msgs.length - 1]).toEqual({ type: 'cancel', id: 'r1' })
    client.finish() // cancel 后 activeId 已清空,finish 不应再发消息
    expect(ws.sent.length).toBe(msgs.length)
  })

  it('onAudio 收到二进制帧,onEvent 收到 JSON 事件(按 audio_start 记录采样率)', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const audioCalls: Array<{ id: string; sampleRate: number }> = []
    const events: ServerEvent[] = []
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws,
      onAudio: (id, _pcm, sampleRate) => audioCalls.push({ id, sampleRate }),
      onEvent: (e) => events.push(e)
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p
    client.begin('r1', 'zh')
    ws.emitMessage(JSON.stringify({ type: 'audio_start', id: 'r1', sampleRate: 32000, channels: 1, format: 'pcm_s16le' }))
    ws.emitMessage(new ArrayBuffer(8))
    ws.emitMessage(JSON.stringify({ type: 'done', id: 'r1' }))
    expect(events.map((e) => e.type)).toEqual(['audio_start', 'done'])
    expect(audioCalls).toEqual([{ id: 'r1', sampleRate: 32000 }])
  })

  it('onAudio 收到 Buffer 二进制帧(模拟真实 ws 默认 binaryType=nodebuffer 时的交付类型,不应被静默丢弃)', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const audioCalls: Array<{ id: string; sampleRate: number; bytes: number[] }> = []
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws,
      onAudio: (id, pcm, sampleRate) => audioCalls.push({ id, sampleRate, bytes: Array.from(new Uint8Array(pcm)) })
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p
    client.begin('r1', 'zh')
    ws.emitMessage(JSON.stringify({ type: 'audio_start', id: 'r1', sampleRate: 32000, channels: 1, format: 'pcm_s16le' }))
    ws.emitMessage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(audioCalls).toEqual([{ id: 'r1', sampleRate: 32000, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }])
  })

  it('close():关闭 WebSocket 并 kill 子进程', async () => {
    const child = fakeChild()
    const ws = fakeWebSocket()
    const client = createTtsClient({
      pythonExe: 'python.exe', packageRoot: 'C:\\pkg',
      spawn: () => child, createWebSocket: () => ws
    })
    const p = client.start()
    child.emitStdout(readyLine)
    queueMicrotask(() => ws.onopen?.())
    await p
    await client.close()
    expect(ws.close).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
