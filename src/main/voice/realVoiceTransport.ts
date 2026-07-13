import { spawn, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { createWriteStream, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'
import { createSseParser, type SseFrame } from './sseParser'

const execFileP = promisify(execFileCb)

/** spawn 一个子进程,监听 stdout 直到看到 "READY" 才算就绪;进程提前退出则拒绝,错误信息里带上 earlyExitLabel 与 Python 侧的 stderr 尾巴(通常是 traceback)。 */
function spawnAndWaitForReady(pythonExe: string, args: string[], earlyExitLabel: string, spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}): { kill(): void; waitReady(): Promise<void> } {
  const { stdin, ...nodeOpts } = spawnOpts
  const child = spawn(pythonExe, args, { windowsHide: true, ...nodeOpts })
  if (stdin !== undefined) { child.stdin?.end(stdin) }
  let stderrTail = ''
  child.stderr?.on('data', (buf: Buffer) => { stderrTail = (stderrTail + buf.toString('utf-8')).slice(-2000) })

  return {
    kill(): void { child.kill() },
    waitReady(): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false
        child.stdout?.on('data', (buf: Buffer) => {
          if (!settled && buf.toString('utf-8').includes('READY')) { settled = true; resolve() }
        })
        child.once('exit', (code) => {
          if (!settled) {
            settled = true
            const detail = stderrTail.trim()
            reject(new Error(`${earlyExitLabel}提前退出(code=${code})${detail ? `: ${detail}` : ''}`))
          }
        })
        child.once('error', (err) => {
          if (!settled) { settled = true; reject(err) }
        })
      })
    }
  }
}

/** spawn gsv_server.py 处理真实语音请求,绑定具体宠物的 GPT/SoVITS 模型与参考音频/文本。 */
export function realSpawnProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { gptModel: string; sovitsModel: string; refAudio: string; refText: string }
  device: 'auto' | 'cuda' | 'cpu'
  useFlashAttn: boolean
  modelsDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--gpt-model', opts.voice.gptModel,
    '--sovits-model', opts.voice.sovitsModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText,
    '--models-dir', opts.modelsDir
  ]
  if (opts.device !== 'auto') args.push('--device', opts.device)
  if (opts.useFlashAttn) args.push('--use-flash-attn')

  return spawnAndWaitForReady(opts.pythonExe, args, '语音 sidecar')
}

/** spawn gsv_server.py 的 `--warm-start` 模式:只触发基础预训练模型下载,不需要真实的 GPT/SoVITS/参考音频文本。 */
export function realSpawnWarmStart(opts: {
  pythonExe: string
  scriptPath: string
  device: 'auto' | 'cuda' | 'cpu'
  useFlashAttn: boolean
  modelsDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [opts.scriptPath, '--warm-start', '--models-dir', opts.modelsDir]
  if (opts.device !== 'auto') args.push('--device', opts.device)
  if (opts.useFlashAttn) args.push('--use-flash-attn')

  return spawnAndWaitForReady(opts.pythonExe, args, '语音运行时预热探针')
}

/** spawn genie_server.py 处理真实语音请求,绑定具体宠物的 ONNX 模型与参考音频/文本。
 *  cwd 必须是安装目录本身:genie_tts 的资源下载/查找默认相对于进程 cwd 拼 "./GenieData",
 *  同时也显式设 GENIE_DATA_DIR 环境变量指向同一绝对路径,双重保险(见本文件顶部 Task 5 说明)。 */
export function realSpawnGenieProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  voice: { onnxModel: string; refAudio: string; refText: string; language: 'zh' | 'ja' | 'en' }
  installDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [
    opts.scriptPath,
    '--port', String(opts.port),
    '--onnx-model-dir', opts.voice.onnxModel,
    '--ref-audio', opts.voice.refAudio,
    '--ref-text-file', opts.voice.refText,
    '--language', opts.voice.language
  ]
  return spawnAndWaitForReady(opts.pythonExe, args, 'Genie-TTS 语音 sidecar', {
    cwd: opts.installDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData'), PYTHONIOENCODING: 'utf-8' }
  })
}

/** spawn genie_server.py 的 `--download-data` 模式:只触发基础预训练模型下载(首次约 391MB)后退出。
 *
 *  不能提前在 Node 侧创建 <installDir>/GenieData 目录——genie_tts 的 Core/Resources.py 只在
 *  "目录不存在"这一个分支里才会触发自动下载(`if not os.path.exists(GENIE_DATA_DIR): ... input(...)
 *  -> download_genie_data()`);提前建好空目录会让这个存在性检查判真、跳过整个自动下载分支,
 *  紧接着摔在 `ensure_exists(HUBERT_MODEL_DIR,...)` 的硬性 FileNotFoundError 上(已在真实环境复现
 *  验证)。正确做法是让目录保持不存在,转而向子进程 stdin 喂 "y\n",顶替掉那个交互式 input() 的
 *  人工输入,复用 genie_tts 自己"确认下载"分支里内联调用 download_genie_data() 的逻辑——同样已在
 *  真实环境验证过,能触发完整下载(17 个资源文件)。
 *  PYTHONIOENCODING=utf-8 同样是必须的:genie_tts 下载过程中打印的 emoji 日志在 Windows 默认 GBK
 *  控制台编码下会直接 UnicodeEncodeError 崩溃(也已在真实环境复现验证)。 */
export function realDownloadGenieData(opts: {
  pythonExe: string
  scriptPath: string
  installDir: string
}): Promise<void> {
  const child = spawnAndWaitForReady(opts.pythonExe, [opts.scriptPath, '--download-data'], 'Genie-TTS 数据下载', {
    cwd: opts.installDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData'), PYTHONIOENCODING: 'utf-8' },
    stdin: 'y\n'
  })
  return child.waitReady()
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

const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

/** Node 18+ 的 fetch body 是 web ReadableStream,转成 node stream 落盘到 destPath;非 2xx 抛错。 */
async function downloadToFile(url: string, destPath: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`下载失败(${url}):HTTP ${res.status}`)
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath))
}

export async function realDownloadEmbeddablePython(destDir: string, downloadUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })

  const zipPath = join(destDir, 'python-embed.zip')
  await downloadToFile(downloadUrl, zipPath, fetchImpl)
  new AdmZip(zipPath).extractAllTo(destDir, true)
  rmSync(zipPath)

  // 内嵌(embeddable)发行版默认注释掉了 `import site`,关闭了 site-packages 查找,
  // 关掉的话装好 pip 也 import 不到——必须先打开它,pip 才可能被找到。
  const pthFile = readdirSync(destDir).find((f) => f.endsWith('._pth'))
  if (pthFile) {
    const pthPath = join(destDir, pthFile)
    const content = readFileSync(pthPath, 'utf-8').replace(/^#\s*import site\s*$/m, 'import site')
    writeFileSync(pthPath, content)
  }

  // 内嵌发行版不带 ensurepip,也没有 pip——用官方的 get-pip.py 引导安装。
  const getPipPath = join(destDir, 'get-pip.py')
  await downloadToFile(GET_PIP_URL, getPipPath, fetchImpl)
  await execFileP(join(destDir, 'python.exe'), [getPipPath], { maxBuffer: 1024 * 1024 * 64 })
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
