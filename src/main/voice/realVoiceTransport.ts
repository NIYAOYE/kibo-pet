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
function spawnAndWaitForReady(pythonExe: string, args: string[], earlyExitLabel: string, spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; onStdout?: (chunk: string) => void } = {}): { kill(): void; waitReady(): Promise<void> } {
  const { stdin, onStdout, ...nodeOpts } = spawnOpts
  const child = spawn(pythonExe, args, { windowsHide: true, ...nodeOpts })
  if (stdin !== undefined) { child.stdin?.end(stdin) }
  if (onStdout) { child.stdout?.on('data', (buf: Buffer) => onStdout(buf.toString('utf-8'))) }
  let stderrTail = ''
  child.stderr?.on('data', (buf: Buffer) => { stderrTail = (stderrTail + buf.toString('utf-8')).slice(-8000) })

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
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData'), PYTHONIOENCODING: 'utf-8', HF_HUB_DOWNLOAD_TIMEOUT: '30' }
  })
}

/** spawn translate_server.py 处理真实翻译请求。翻译 sidecar 与宠物身份无关,不需要 voice/installDir 这类每个宠物不同的参数。 */
export function realSpawnTranslateProcess(opts: {
  pythonExe: string
  scriptPath: string
  port: number
  modelDir: string
}): { kill(): void; waitReady(): Promise<void> } {
  const args = [opts.scriptPath, '--port', String(opts.port), '--model-dir', opts.modelDir]
  return spawnAndWaitForReady(opts.pythonExe, args, '本地翻译 sidecar')
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
 *  控制台编码下会直接 UnicodeEncodeError 崩溃(也已在真实环境复现验证)。
 *  rmSync 预清空同理必须:genie_tts 自己没有断点续传/重试逻辑,一旦上次尝试被中途杀掉(比如用户
 *  等得不耐烦直接关了 App),GenieData 会以"目录存在但文件不全"的状态永久留在磁盘上——下次重试时
 *  同一个 `os.path.exists(GENIE_DATA_DIR)` 检查会判真,同样跳过自动下载分支,摔在后面某个
 *  `ensure_exists()` 上,且每次重试都会 100% 复现同一个报错、永远不会自愈(真实用户报告复现)。
 *  所以每次进这个函数都要先无条件删干净整个目录,保证 genie_tts 看到的永远是"不存在",触发方式与
 *  上面全新安装的场景完全一致。
 *  不设 HF_ENDPOINT 镜像:曾经尝试过 HF_ENDPOINT=https://hf-mirror.com 来缓解"直连 huggingface.co
 *  慢"的猜测,但实测(真实环境复现)发现这个镜像本身跟当前 huggingface_hub 版本的 HEAD 元数据校验
 *  不兼容,必现 FileMetadataError/LocalEntryNotFoundError——是这个"修复"本身在制造后续三轮真机报错,
 *  不是在解决问题。直连 huggingface.co 本身是能成功下载的(实测约 2-3 分钟),配合下面的 onProgress
 *  实时进度转发,不需要镜像也能让用户看到下载确实在推进,不会再被误以为卡死。
 *  HF_HUB_DOWNLOAD_TIMEOUT 仍保留调到 30 秒(默认 10 秒):即使不走镜像,直连也可能遇到偏慢的单个
 *  HEAD 请求,调大超时是纯粹的容错缓冲,与上面镜像不兼容的问题相互独立,不冲突;
 *  真正的"单次失败整批崩"问题由 genie_server.py --download-data 分支自身的重试循环处理(见该文件)。
 *  opts.onProgress 把子进程 stdout 实时转发出去(而不是只在最终失败时靠有限长度的 stderr 尾巴拼凑),
 *  解决了重试期间早期尝试的失败提示被后续更长的最终 traceback 挤出 stderr 截断窗口、导致完全看不出
 *  重试到底跑没跑的可观测性问题(真实用户报告触发)。 */
export function realDownloadGenieData(opts: {
  pythonExe: string
  scriptPath: string
  installDir: string
  onProgress: (message: string) => void
}): Promise<void> {
  rmSync(join(opts.installDir, 'GenieData'), { recursive: true, force: true })
  const child = spawnAndWaitForReady(opts.pythonExe, [opts.scriptPath, '--download-data'], 'Genie-TTS 数据下载', {
    cwd: opts.installDir,
    env: { ...process.env, GENIE_DATA_DIR: join(opts.installDir, 'GenieData'), PYTHONIOENCODING: 'utf-8', HF_HUB_DOWNLOAD_TIMEOUT: '30' },
    stdin: 'y\n',
    onStdout: (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed && trimmed !== 'READY') opts.onProgress(trimmed)
      }
    }
  })
  return child.waitReady()
}

export const NLLB_MODEL_REPO = 'JustFrederik/nllb-200-distilled-600M-ct2-int8'
/** shared_vocabulary.txt 是 ctranslate2.Translator() 加载"目标词表"必需的文件,当初设计时
 *  漏看了它——真机报错验证:缺这个文件会在构造 Translator 时直接抛
 *  "Cannot load the target vocabulary from the model directory"。 */
const NLLB_MODEL_FILES = ['config.json', 'model.bin', 'sentencepiece.bpe.model', 'shared_vocabulary.txt']

/** 直接从 huggingface.co 下载推理必需的 3 个文件,不引入 huggingface_hub(Node 侧直接 HTTP GET,
 *  复用 downloadToFile)。不设 HF_ENDPOINT 镜像——参考 realDownloadGenieData 上方注释记录的教训,
 *  镜像曾经跟 huggingface_hub 的元数据校验不兼容、反而制造了后续几轮真机报错,直连 huggingface.co
 *  本身是能成功下载的。这里是纯文件 GET,不经过 huggingface_hub 库,不受那个特定不兼容问题影响,
 *  但同样不主动加镜像,保持跟已验证过的直连路径一致。 */
export async function realDownloadNllbModel(destDir: string, onProgress: (message: string) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  for (let i = 0; i < NLLB_MODEL_FILES.length; i++) {
    const file = NLLB_MODEL_FILES[i]
    onProgress(`下载翻译模型(${i + 1}/${NLLB_MODEL_FILES.length}):${file}`)
    await downloadToFile(`https://huggingface.co/${NLLB_MODEL_REPO}/resolve/main/${file}`, join(destDir, file), fetchImpl)
  }
}

/** 发 POST + 手动解析 text/event-stream 响应体(纯文本协议,不引入 ws 包)。 */
export function realPostSse(port: number, path: string, body: unknown, onFrame: (f: SseFrame) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('TTS request cancelled'))
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

/** 发 POST + 收完整 JSON 响应体(非流式,供本地翻译 sidecar 用——它是同步返回,不是 SSE)。 */
export function realPostJson(port: number, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error('翻译请求已取消'))
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { raw += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}')
          if (res.statusCode !== 200) {
            reject(new Error(typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.statusCode}`))
            return
          }
          resolve(parsed)
        } catch (e) {
          reject(e)
        }
      })
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
export async function downloadToFile(url: string, destPath: string, fetchImpl: typeof fetch): Promise<void> {
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
