# 配音相关 pip 包安装 —— 国内镜像优先 + 官方源降级 — 设计

> 2026-07-10 与用户 brainstorming 定下。承接 `docs/superpowers/plans/2026-07-10-gsv-tts-lite-voice-integration.md`
> 计划里的语音运行时现场安装流程(`src/main/shell/index.ts` 的 `runVoiceRuntimeInstall` 接线)。用户反馈:国内
> 网络环境下直连 PyPI / download.pytorch.org 经常很慢或失败,希望优先走国内镜像,失败再自动降级到官方源。

## 1. 背景与范围

现场安装流程(`runVoiceRuntimeInstall`,详见 `src/main/voice/voiceRuntimeInstall.ts`)有三类下载/安装:

1. 内嵌 Python 解释器(从 `python.org` 下载 zip)
2. **pip 包**:`pip install --upgrade pip`、`torch`/`torchvision`/`torchaudio`(CPU 或 CUDA 版)、
   `gsv-tts-lite`
3. `gsv-tts-lite` 首次运行时自己触发的基础预训练模型下载(`chinese-hubert`/`chinese-roberta` 等,
   "warm-start")

调研确认(读了 `gsv-tts-lite` 的 PyPI 元数据与其 GitHub 源码 `gsv_tts/Download.py`):第 3 类已经在库内部
自己实现了 ModelScope(国内)与 HuggingFace 的延迟探测、自动选更快的一个,不读环境变量、也没有暴露给
调用方覆盖的接口——**这部分不需要也无法从本项目侧介入**。

因此本设计的范围只是**第 2 类:pip 包安装**。第 1 类(Python 解释器下载)本次不动。

## 2. 镜像选择

- 通用 PyPI 包(`pip` 自身升级、`gsv-tts-lite`、CPU 版 `torch`):优先 **清华 TUNA**
  (`https://pypi.tuna.tsinghua.edu.cn/simple`),失败降级到官方默认源(不传 `-i`,pip 自己解析,即
  `pypi.org`)。
- CUDA 版 `torch`/`torchvision`/`torchaudio`(不在标准 PyPI 索引上,现状是硬编码
  `--index-url https://download.pytorch.org/whl/cu128`):实测清华 TUNA **没有** pytorch-wheels 镜像
  (`mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/` 404),但**阿里云有**
  (`mirrors.aliyun.com/pytorch-wheels/cu128/` 等目录存在)。优先阿里云镜像的对应 CUDA 版本目录,失败
  降级到官方 `download.pytorch.org/whl/cu128`。
- 若阿里云镜像没有同步某个新 CUDA 版本(如未来升级到更新的 cu13x 而镜像还没跟上),pip 会很快报"找不到
  匹配版本"而不是长时间卡住,天然触发降级到官方源,不需要额外探测逻辑。

## 3. 核心机制:纯逻辑 + 可注入的重试编排

新增 `src/main/voice/pipMirrorInstall.ts`(纯逻辑,TDD 覆盖):

```ts
export interface MirrorCandidate { indexUrl?: string; label: string }

export async function installWithMirrorFallback(
  candidates: MirrorCandidate[],
  attempt: (candidate: MirrorCandidate) => Promise<void>,
  onProgress: (message: string) => void
): Promise<void>
```

按顺序尝试每个候选:对每个候选先 `onProgress('使用<label>安装…')`,调用 `attempt(candidate)`;失败则
`onProgress('<label>安装失败(<错误信息>),改用下一个源重试…')` 并试下一个;全部候选都失败则抛出最后一个
错误。`attempt` 由调用方注入(真实实现里是包了 index-url 的 `realPipInstall` 调用),因此这个函数本身
不含任何真实网络/进程调用,可以用假的 `attempt` 完整单测三种情况:第一个候选成功、第一个失败第二个成功
全部失败。

`indexUrl: undefined` 的候选代表"不传 `-i`,用 pip/系统默认(即官方源)"。

## 4. 实时进度显示(下载中 vs 卡住)

现状 `realPipInstall` 用 `execFile`(整个命令跑完才拿到输出),安装界面在一个 pip 步骤执行期间只有安装
前的一条静态提示(比如"安装 PyTorch (CPU)…"),用户在这期间无法区分"正常下载中"还是"卡死了"。

调整为:

- `realPipInstall` 改用 `spawn` 实时流式读取 pip 的 stdout/stderr,按行(含 `\r` 覆写的进度行)转发给
  调用方传入的 `onOutput` 回调。
- **节流**:实际收到新输出时,离上次转发不足 1 秒的更新会被跳过(只保留最新一行下次转发),避免大文件
  (torch wheel 几百 MB)下载时刷屏。
- **心跳**:超过 5 秒没有任何新输出(网络卡顿或真正卡住)时,定时器每 5 秒补发一条
  "仍在安装中(已等待 Ns,暂无新输出)…",证明进程还活着、没有静默挂起;一旦有真实输出到达,心跳计时器
  重置。
- 这些消息都通过现有的 `onProgress({ stage, message })` 管道送到渲染层,复用安装界面已有的滚动日志
  (`ttsInstallLog` / `appendInstallLog`,见 `src/renderer/settings.ts:120`),每条消息独立追加一行,
  不需要改 `VoiceInstallProgress`/`InstallProgress` 的类型形状。
- `InstallStepRunner` 里做 pip 安装的三个方法(`enablePip`/`installTorch`/`installGsvTtsLite`)签名各
  增加一个 `onProgress: (message: string) => void` 参数,`runVoiceRuntimeInstall` 调用时用当前
  `stage` 包一层传下去;`downloadEmbeddablePython`/`detectGpu`/`warmStartModels` 签名不变(本次不动)。

## 5. 改动文件清单

- `src/main/voice/pipMirrorInstall.ts`(新增)+ 单测:纯重试编排逻辑。
- `src/main/voice/realVoiceTransport.ts`:`realPipInstall` 改签名
  `(pythonDir, args, opts?: { indexUrl?: string; onOutput?: (line: string) => void })`,内部换
  `spawn` 流式读取 + 节流 + 心跳;`indexUrl` 提供时追加 `-i <url> --timeout 20 --retries 1`(镜像
  候选要快速判定失败),不提供时不加这些 flag(官方源走 pip 默认的耐心重试策略)。
- `src/main/voice/voiceRuntimeInstall.ts`:`InstallStepRunner` 的 `enablePip`/`installTorch`/
  `installGsvTtsLite` 签名加 `onProgress` 参数;`runVoiceRuntimeInstall` 相应传入。
- `src/main/shell/index.ts`:三处调用改成走 `installWithMirrorFallback` + 镜像候选列表(通用包用
  TUNA→官方,CUDA torch 用阿里云→官方)。

## 6. 不做的事

- 不做 Settings 界面的镜像地址配置项(硬编码这两个镜像,YAGNI;真要换源属于小改动,不值得为此加一整块
  UI)。
- 不碰第 1 类(内嵌 Python 解释器 zip 下载)和第 3 类(`gsv-tts-lite` 自己的模型预热下载)。
- 不加安装过程中的"取消"按钮(现状就没有,超出本次范围)。

## 7. 真机验收

`pnpm typecheck`/`pnpm vitest` 只能验证纯逻辑(`pipMirrorInstall.ts`)和既有回归;真实的网络降级行为
(镜像连不上时是否真的降级、torch CUDA 版本在阿里云缺失时的报错与降级、心跳消息在真实慢网络下的观感)
需要用户在真实机器上跑一次现场安装验证。
