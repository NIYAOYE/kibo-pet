# 配音相关 pip 包安装:国内镜像优先 + 官方源降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 语音运行时现场安装流程里的三处 pip 安装(升级 pip、torch 全家桶、gsv-tts-lite)改为优先走国内镜像、失败自动降级官方源,并把 pip 的实时输出/心跳转发到安装界面,让用户能区分"正在下载"和"卡住了"。

**Architecture:** 新增一个纯逻辑模块 `pipMirrorInstall.ts` 负责"按顺序尝试镜像候选、失败报告并降级"的编排,不含任何真实网络/进程调用,可完整单测。`voiceRuntimeInstall.ts` 的 `InstallStepRunner` 里做 pip 安装的三个方法签名增加一个 `onProgress` 回调参数,用于把编排过程中的每条消息(使用哪个源/降级/pip 实时输出/心跳)转发回顶层安装进度日志。真实的 pip 调用(`realVoiceTransport.ts` 的 `realPipInstall`)从 `execFile`(整体阻塞、跑完才有输出)改成 `spawn` 流式读取 stdout/stderr,按节流转发 + 5 秒心跳。最后在 `shell/index.ts` 里把三处 pip 步骤接上镜像候选列表(通用包用清华 TUNA → 官方源;CUDA 版 torch 用阿里云 pytorch-wheels 镜像 → 官方 `download.pytorch.org`)。

**Tech Stack:** TypeScript(既有 electron-vite/Vitest 工具链),`node:child_process` 的 `spawn`(替代原来的 `execFile`)。不引入新依赖。

## Global Constraints

- 只改 pip 包安装这一环;不碰内嵌 Python 解释器 zip 下载、也不碰 `gsv-tts-lite` 自己的模型预热下载(库内部已有 ModelScope/HuggingFace 延迟探测,不读环境变量、无覆盖接口)。
- 镜像地址硬编码,不加 Settings 界面配置项(YAGNI)。
- 通用 PyPI 包(pip 自身、`gsv-tts-lite`、CPU 版 torch)镜像候选:`[清华 TUNA(`https://pypi.tuna.tsinghua.edu.cn/simple`), 官方源(不传 `-i`)]`。
- CUDA 版 torch 镜像候选:`[阿里云 pytorch-wheels(`https://mirrors.aliyun.com/pytorch-wheels/cu128/`), 官方源(`https://download.pytorch.org/whl/cu128`)]`。
- 镜像候选的 pip 调用带 `--timeout 20 --retries 1`(快速判定失败,不长时间卡住);官方源(最后一个候选)不加这些 flag,走 pip 默认的耐心重试。
- 纯逻辑(`pipMirrorInstall.ts`、`voiceRuntimeInstall.ts`)先写失败测试(TDD);`realVoiceTransport.ts` 的 `realPipInstall`/`shell/index.ts` 是真实 I/O 与 Electron 接线,项目既有惯例是不写 Vitest、靠真机验证(参见 `realSpawnProcess`/`realPostSse` 等同目录下其它 `real*` 函数均无对应测试文件)。
- 每个任务一次提交;conventional commit 风格,消息用中文。

---

## Task 1: 镜像降级编排(`src/main/voice/pipMirrorInstall.ts`)

纯逻辑:按顺序尝试镜像候选,某个失败就上报并试下一个,全部失败抛出最后一个错误。不含任何真实网络/进程调用,`attempt` 由调用方注入。

**Files:**
- Create: `src/main/voice/pipMirrorInstall.ts`
- Test: `src/main/voice/pipMirrorInstall.test.ts`

**Interfaces:**
- Produces: `export interface MirrorCandidate { indexUrl?: string; label: string }`、`export async function installWithMirrorFallback(candidates: MirrorCandidate[], attempt: (candidate: MirrorCandidate) => Promise<void>, onProgress: (message: string) => void): Promise<void>`(Task 4 的 `shell/index.ts` 接线会用这两个名字)

- [ ] **Step 1: 写失败测试**

创建 `src/main/voice/pipMirrorInstall.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { installWithMirrorFallback, type MirrorCandidate } from './pipMirrorInstall'

describe('installWithMirrorFallback', () => {
  it('第一个候选成功 → 只调用一次 attempt,onProgress 只收到一条"使用中"提示', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn(async () => {})
    const progress: string[] = []
    await installWithMirrorFallback(candidates, attempt, (m) => progress.push(m))
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(candidates[0])
    expect(progress).toEqual(['使用清华源安装…'])
  })

  it('第一个候选失败、第二个成功 → 依次调用两次 attempt,onProgress 含失败提示与降级提示', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(undefined)
    const progress: string[] = []
    await installWithMirrorFallback(candidates, attempt, (m) => progress.push(m))
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenNthCalledWith(1, candidates[0])
    expect(attempt).toHaveBeenNthCalledWith(2, candidates[1])
    expect(progress).toEqual([
      '使用清华源安装…',
      '清华源安装失败(网络中断),改用下一个源重试…',
      '使用官方源安装…'
    ])
  })

  it('全部候选都失败 → 抛出最后一个错误,attempt 调用次数等于候选数,最后一个候选失败不再输出"改用下一个源"', async () => {
    const candidates: MirrorCandidate[] = [
      { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华源' },
      { indexUrl: undefined, label: '官方源' }
    ]
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('镜像 404'))
      .mockRejectedValueOnce(new Error('官方源也超时'))
    const progress: string[] = []
    await expect(installWithMirrorFallback(candidates, attempt, (m) => progress.push(m)))
      .rejects.toThrow('官方源也超时')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(['使用清华源安装…', '清华源安装失败(镜像 404),改用下一个源重试…', '使用官方源安装…'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/voice/pipMirrorInstall.test.ts`
Expected: FAIL(`./pipMirrorInstall` 模块不存在)

- [ ] **Step 3: 实现**

创建 `src/main/voice/pipMirrorInstall.ts`:

```ts
export interface MirrorCandidate {
  indexUrl?: string
  label: string
}

export async function installWithMirrorFallback(
  candidates: MirrorCandidate[],
  attempt: (candidate: MirrorCandidate) => Promise<void>,
  onProgress: (message: string) => void
): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    onProgress(`使用${candidate.label}安装…`)
    try {
      await attempt(candidate)
      return
    } catch (e) {
      lastError = e
      const isLast = i === candidates.length - 1
      if (!isLast) {
        onProgress(`${candidate.label}安装失败(${String((e as Error)?.message ?? e)}),改用下一个源重试…`)
      }
    }
  }
  throw lastError
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/voice/pipMirrorInstall.test.ts`
Expected: 全部 3 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/pipMirrorInstall.ts src/main/voice/pipMirrorInstall.test.ts
git commit -m "feat(voice): 新增 pip 镜像降级编排逻辑(installWithMirrorFallback)"
```

---

## Task 2: `InstallStepRunner` 的 pip 步骤加 onProgress 参数(`src/main/voice/voiceRuntimeInstall.ts`)

让 `enablePip`/`installTorch`/`installGsvTtsLite` 能把 Task 1 里产生的逐条进度消息转发回顶层 `onProgress`(复用当前所在的 `stage`)。

**Files:**
- Modify: `src/main/voice/voiceRuntimeInstall.ts`
- Modify: `src/main/voice/voiceRuntimeInstall.test.ts`(追加用例,已有的 4 个用例不用改)

**Interfaces:**
- Consumes: 无新依赖
- Produces: `InstallStepRunner.enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>`、`InstallStepRunner.installTorch(destDir: string, useCuda: boolean, onProgress: (message: string) => void): Promise<void>`、`InstallStepRunner.installGsvTtsLite(destDir: string, onProgress: (message: string) => void): Promise<void>`(Task 4 的 `shell/index.ts` 实现这三个方法时依赖这个签名;`downloadEmbeddablePython`/`detectGpu`/`warmStartModels` 签名不变)

- [ ] **Step 1: 追加失败测试**

在 `src/main/voice/voiceRuntimeInstall.test.ts` 末尾(`describe('runVoiceRuntimeInstall', ...)` 内、最后一个 `it` 之后)追加:

```ts
  it('enablePip/installTorch/installGsvTtsLite 收到的 onProgress 回调,会以当前 stage 转发给顶层 onProgress', async () => {
    const progress: InstallProgress[] = []
    const steps = fakeSteps({
      enablePip: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('使用清华源安装…') }),
      installTorch: vi.fn(async (_dir: string, _useCuda: boolean, onProgress: (m: string) => void) => { onProgress('下载中 10%…') }),
      installGsvTtsLite: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('安装完成') })
    })
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress).toContainEqual({ stage: 'enable-pip', message: '使用清华源安装…' })
    expect(progress).toContainEqual({ stage: 'install-torch', message: '下载中 10%…' })
    expect(progress).toContainEqual({ stage: 'install-gsv-tts-lite', message: '安装完成' })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/voice/voiceRuntimeInstall.test.ts`
Expected: FAIL(新用例里 `steps.enablePip` 等的第二/第三个参数在当前实现里永远不会被调用,`progress` 里找不到期望的条目;也可能因为 `fakeSteps` 默认 mock 的类型与新测试用例里手写的 mock 函数类型不完全一致而报 TS 类型错误——两者都算预期失败)

- [ ] **Step 3: 实现**

修改 `src/main/voice/voiceRuntimeInstall.ts`,把 `InstallStepRunner` 接口改成:

```ts
export interface InstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
  detectGpu(): Promise<boolean>
  installTorch(destDir: string, useCuda: boolean, onProgress: (message: string) => void): Promise<void>
  installGsvTtsLite(destDir: string, onProgress: (message: string) => void): Promise<void>
  warmStartModels(destDir: string): Promise<void>
}
```

再把 `runVoiceRuntimeInstall` 函数体里对应三行 `await opts.steps.xxx(...)` 改成:

```ts
    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir, (message) => opts.onProgress({ stage, message }))
```

```ts
    stage = 'install-torch'
    opts.onProgress({ stage, message: useCuda ? '安装 PyTorch (CUDA)…' : '安装 PyTorch (CPU)…' })
    await opts.steps.installTorch(opts.destDir, useCuda, (message) => opts.onProgress({ stage, message }))
```

```ts
    stage = 'install-gsv-tts-lite'
    opts.onProgress({ stage, message: '安装 GSV-TTS-Lite…' })
    await opts.steps.installGsvTtsLite(opts.destDir, (message) => opts.onProgress({ stage, message }))
```

`downloadEmbeddablePython`/`detectGpu`/`warmStartModels` 的调用与其余代码不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/voice/voiceRuntimeInstall.test.ts`
Expected: 全部 5 个用例(原有 4 个 + 新增 1 个)PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/voiceRuntimeInstall.ts src/main/voice/voiceRuntimeInstall.test.ts
git commit -m "feat(voice): InstallStepRunner 的 pip 步骤支持逐条进度回调"
```

---

## Task 3: `realPipInstall` 改为流式输出 + 镜像 index-url(`src/main/voice/realVoiceTransport.ts`)

真实 I/O 实现:从阻塞式 `execFile` 换成 `spawn` 流式读取 stdout/stderr,按 1 秒节流转发 + 5 秒心跳;支持可选 `indexUrl`(镜像候选传入时追加 `-i <url> --timeout 20 --retries 1`,不传则维持 pip 默认行为)。这是真实进程/网络代码,项目里同类的 `realSpawnProcess`/`realPostSse`/`realDetectGpu` 都没有对应 Vitest,靠真机验证——这里保持一致,不写测试。

**Files:**
- Modify: `src/main/voice/realVoiceTransport.ts:92-95`(替换 `realPipInstall` 全部实现)

**Interfaces:**
- Consumes: 无新依赖(`spawn` 已在文件顶部 `import { spawn, execFile as execFileCb } from 'node:child_process'` 引入)
- Produces: `export interface PipInstallOptions { indexUrl?: string; onOutput?: (line: string) => void }`、`export function realPipInstall(pythonDir: string, args: string[], opts?: PipInstallOptions): Promise<void>`(Task 4 的 `shell/index.ts` 接线依赖这个新签名;`opts` 可选,省略时行为等价于"不指定镜像、不转发输出",向后兼容旧的两参数调用形式)

- [ ] **Step 1: 替换实现**

把 `src/main/voice/realVoiceTransport.ts` 里现有的:

```ts
export async function realPipInstall(pythonDir: string, args: string[]): Promise<void> {
  const pythonExe = join(pythonDir, 'python.exe')
  await execFileP(pythonExe, ['-m', 'pip', 'install', ...args], { maxBuffer: 1024 * 1024 * 64 })
}
```

整段替换为:

```ts
export interface PipInstallOptions {
  /** 传入时通过 `-i <url>` 指定镜像索引,并加 `--timeout 20 --retries 1` 快速判定失败;不传则用 pip 默认(官方源),不加这些 flag。 */
  indexUrl?: string
  /** 收到 pip 的实时输出行(已按 1 秒节流)或心跳提示("仍在安装中…")。 */
  onOutput?: (line: string) => void
}

export function realPipInstall(pythonDir: string, args: string[], opts: PipInstallOptions = {}): Promise<void> {
  const pythonExe = join(pythonDir, 'python.exe')
  const fullArgs = ['-m', 'pip', 'install', ...args]
  if (opts.indexUrl) fullArgs.push('-i', opts.indexUrl, '--timeout', '20', '--retries', '1')

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
```

- [ ] **Step 2: 全量 typecheck 确认没有破坏既有调用方**

Run: `pnpm typecheck`
Expected: 此时 `src/main/shell/index.ts` 里旧的三处 `realPipInstall(dir, [...])` 两参数调用仍然类型兼容(第三个参数可选),应该 PASS,不应有新增报错。

- [ ] **Step 3: Commit**

```bash
git add src/main/voice/realVoiceTransport.ts
git commit -m "feat(voice): realPipInstall 改为流式转发 pip 输出+心跳,支持镜像 index-url"
```

---

## Task 4: 接线镜像候选到三处 pip 安装步骤(`src/main/shell/index.ts`)

把 Task 1-3 的能力接起来:`enablePip`/`installTorch`/`installGsvTtsLite` 改成走 `installWithMirrorFallback` + 镜像候选列表,`onOutput`/`onProgress` 都转发到同一个回调。

**Files:**
- Modify: `src/main/shell/index.ts:14`(import 里补 `realPipInstall` 的调用点不变,新增 `installWithMirrorFallback`、`MirrorCandidate` 的 import)
- Modify: `src/main/shell/index.ts:262-265`(常量区追加镜像地址常量)
- Modify: `src/main/shell/index.ts:692-701`(`enablePip`/`installTorch`/`installGsvTtsLite` 三处实现)

**Interfaces:**
- Consumes: `installWithMirrorFallback`、`MirrorCandidate`(Task 1)、`realPipInstall` 新签名(Task 3)、`InstallStepRunner` 新签名(Task 2)

- [ ] **Step 1: 补 import**

在 `src/main/shell/index.ts:11` 附近(`import { runVoiceRuntimeInstall } from '../voice/voiceRuntimeInstall'` 那一行)之后插入:

```ts
import { installWithMirrorFallback, type MirrorCandidate } from '../voice/pipMirrorInstall'
```

- [ ] **Step 2: 补镜像地址常量**

找到 `src/main/shell/index.ts` 里这几行(约第 262-265 行):

```ts
  const VOICE_PORT = 8850
  const voiceScriptPath = join(appRoot, 'resources/voice/gsv_server.py')
  const voiceMarkerFile = (installPath: string): string => join(installPath, 'voice-runtime-marker.json')
  const voicePythonExe = (installPath: string): string => join(installPath, 'python.exe')
```

在其后追加:

```ts
  const PYPI_MIRROR_TUNA = 'https://pypi.tuna.tsinghua.edu.cn/simple'
  const PYTORCH_CUDA_MIRROR_ALIYUN = 'https://mirrors.aliyun.com/pytorch-wheels/cu128/'
  const PYTORCH_CUDA_OFFICIAL = 'https://download.pytorch.org/whl/cu128'
```

- [ ] **Step 3: 替换三处 pip 步骤实现**

把 `src/main/shell/index.ts` 里(约第 692-701 行)这一段:

```ts
        enablePip: async (dir) => { await realPipInstall(dir, ['--upgrade', 'pip']) },
        detectGpu: realDetectGpu,
        installTorch: async (dir, useCuda) => {
          await realPipInstall(dir, useCuda
            ? ['torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128']
            : ['torch', 'torchvision', 'torchaudio'])
        },
        installGsvTtsLite: async (dir) => { await realPipInstall(dir, ['gsv-tts-lite']) },
```

替换为:

```ts
        enablePip: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源' },
            { indexUrl: undefined, label: '官方源' }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['--upgrade', 'pip'], { indexUrl: c.indexUrl, onOutput: onProgress }),
            onProgress
          )
        },
        detectGpu: realDetectGpu,
        installTorch: async (dir, useCuda, onProgress) => {
          const candidates: MirrorCandidate[] = useCuda
            ? [
                { indexUrl: PYTORCH_CUDA_MIRROR_ALIYUN, label: '阿里云镜像' },
                { indexUrl: PYTORCH_CUDA_OFFICIAL, label: '官方源' }
              ]
            : [
                { indexUrl: PYPI_MIRROR_TUNA, label: '清华源' },
                { indexUrl: undefined, label: '官方源' }
              ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['torch', 'torchvision', 'torchaudio'], { indexUrl: c.indexUrl, onOutput: onProgress }),
            onProgress
          )
        },
        installGsvTtsLite: async (dir, onProgress) => {
          const candidates: MirrorCandidate[] = [
            { indexUrl: PYPI_MIRROR_TUNA, label: '清华源' },
            { indexUrl: undefined, label: '官方源' }
          ]
          await installWithMirrorFallback(
            candidates,
            (c) => realPipInstall(dir, ['gsv-tts-lite'], { indexUrl: c.indexUrl, onOutput: onProgress }),
            onProgress
          )
        },
```

- [ ] **Step 4: 全量 typecheck 与既有测试套件确认无回归**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck 无报错;全部既有 Vitest 用例(含 Task 1/2 新增的)PASS,数量应为改动前基础上 +3(Task 1)+1(Task 2)。

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/index.ts
git commit -m "feat(voice): 语音运行时安装接上国内镜像优先+官方源降级(pip 三步)"
```

- [ ] **Step 6: 真机验证(不可由 Vitest 覆盖,需用户在真实机器上走一次)**

由于要实际联网装 pip 包(几百 MB 的 torch wheel、真实的镜像可用性),这一步无法在当前会话里验证,需要用户之后手动确认:

1. 跑 `pnpm dev` 或 `pnpm preview`,打开设置窗口的"语音"页,选一个安装位置,点击"安装"。
2. 观察安装日志:是否出现"使用清华源安装…"/"使用阿里云镜像安装…"等提示;如果清华源或阿里云连不上,是否能看到"…安装失败(...),改用下一个源重试…"并自动继续,而不是直接卡死或安装失败退出。
3. 安装 torch 时,观察日志是否有持续的进度行或(网络慢时)"仍在安装中(已等待 Ns,暂无新输出)…"心跳提示,而不是长时间静默无输出。
4. 全流程走完后确认 `voice-runtime-marker.json` 正常写入、安装状态显示"已安装"。

---

## Self-Review Notes

- Spec §2(镜像选择)→ Task 4 的常量与候选列表覆盖;§3(核心机制)→ Task 1;§4(实时进度)→ Task 2 + Task 3;§5(改动文件清单)与本计划四个任务一一对应;§6(不做的事)本计划未触碰对应范围;§7(真机验收)→ Task 4 Step 6。
- 类型一致性检查:`MirrorCandidate`、`installWithMirrorFallback`、`PipInstallOptions`、`realPipInstall` 新签名、`InstallStepRunner` 新签名在 Task 1/2/3/4 之间的引用名字与参数顺序一致。
- 无占位符;每个 Step 都给了完整代码/命令。
