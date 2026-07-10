import { spawn, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createWriteStream, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createSseParser, type SseFrame } from './sseParser'

const execFileP = promisify(execFileCb)

/** spawn gsv_server.py,监听 stdout 直到看到 "READY" 才算就绪;进程提前退出则拒绝。 */
export function realSpawnProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
  device: 'auto' | 'cuda' | 'cpu'
  useFlashAttn: boolean
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--gpt-model', opts.voice.gptModel,
    '--sovits-model', opts.voice.sovitsModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText
  ]
  if (opts.device !== 'auto') args.push('--device', opts.device)
  if (opts.useFlashAttn) args.push('--use-flash-attn')

  const child = spawn(opts.pythonExe, args, { windowsHide: true })

  return {
    kill(): void { child.kill() },
    waitReady(): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false
        child.stdout?.on('data', (buf: Buffer) => {
          if (!settled && buf.toString('utf-8').includes('READY')) { settled = true; resolve() }
        })
        child.once('exit', (code) => {
          if (!settled) { settled = true; reject(new Error(`语音 sidecar 提前退出(code=${code})`)) }
        })
        child.once('error', (err) => {
          if (!settled) { settled = true; reject(err) }
        })
      })
    }
  }
}

/** 发 POST + 手动解析 text/event-stream 响应体(纯文本协议,不引入 ws 包)。 */
export function realPostSse(port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      const parser = createSseParser()
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { for (const f of parser.push(chunk)) onFrame(f) })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')))
    req.write(payload)
    req.end()
  })
}

export async function realDownloadEmbeddablePython(destDir: string, downloadUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const res = await fetchImpl(downloadUrl)
  if (!res.ok || !res.body) throw new Error(`下载失败:HTTP ${res.status}`)
  const zipPath = join(destDir, 'python-embed.zip')
  // Node 18+ 的 fetch body 是 web ReadableStream,转成 node stream 再落盘
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath))
}

export async function realDetectGpu(): Promise<boolean> {
  try {
    await execFileP('nvidia-smi', [])
    return true
  } catch {
    return false
  }
}

export interface PipInstallOptions {
  /** 传入时通过 `-i <url>` 指定镜像索引;不传则用 pip 默认(官方 PyPI 索引)。 */
  indexUrl?: string
  /** 是否加 `--timeout 20 --retries 1` 快速判定失败;镜像源应为 true,官方/最后兜底源应为 false(即便该兜底源仍需显式 indexUrl,如 CUDA 官方 wheel 源)。 */
  fastFail?: boolean
  /** 收到 pip 的实时输出行(已按 1 秒节流)或心跳提示("仍在安装中…")。 */
  onOutput?: (line: string) => void
}

export function realPipInstall(pythonDir: string, args: string[], opts: PipInstallOptions = {}): Promise<void> {
  const pythonExe = join(pythonDir, 'python.exe')
  const fullArgs = ['-m', 'pip', 'install', ...args]
  if (opts.indexUrl) fullArgs.push('-i', opts.indexUrl)
  if (opts.fastFail) fullArgs.push('--timeout', '20', '--retries', '1')

  const onOutput = opts.onOutput ?? ((): void => {})
  const startedAt = Date.now()
  let lastForwardedAt = 0
  let lastLine = ''
  let stderrTail = ''
  let sawOutputSinceHeartbeat = false

  const handleChunk = (raw: string, isStderr: boolean): void => {
    if (isStderr) stderrTail = (stderrTail + raw).slice(-2000)
    const lines = raw.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) return
    lastLine = lines[lines.length - 1]
    sawOutputSinceHeartbeat = true
    const now = Date.now()
    if (now - lastForwardedAt >= 1000) {
      lastForwardedAt = now
      onOutput(lastLine)
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExe, fullArgs, { windowsHide: true })
    child.stdout?.on('data', (buf: Buffer) => handleChunk(buf.toString('utf-8'), false))
    child.stderr?.on('data', (buf: Buffer) => handleChunk(buf.toString('utf-8'), true))

    const heartbeat = setInterval(() => {
      if (!sawOutputSinceHeartbeat) {
        onOutput(`仍在安装中(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s,暂无新输出)…`)
      }
      sawOutputSinceHeartbeat = false
    }, 5000)

    child.once('exit', (code) => {
      clearInterval(heartbeat)
      if (code === 0) resolve()
      else reject(new Error(`pip install 失败(code=${code}): ${stderrTail.trim().slice(-500) || lastLine}`))
    })
    child.once('error', (err) => {
      clearInterval(heartbeat)
      reject(err)
    })
  })
}
