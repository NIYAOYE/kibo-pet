export type InstallStage =
  | 'download-python' | 'enable-pip' | 'detect-gpu'
  | 'install-torch' | 'install-gsv-tts-lite' | 'warm-start-models' | 'done'

export interface InstallProgress { stage: InstallStage; message: string }

export interface InstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string): Promise<void>
  detectGpu(): Promise<boolean>
  installTorch(destDir: string, useCuda: boolean): Promise<void>
  installGsvTtsLite(destDir: string): Promise<void>
  warmStartModels(destDir: string): Promise<void>
}

export async function runVoiceRuntimeInstall(opts: {
  destDir: string
  device: 'auto' | 'cuda' | 'cpu'
  steps: InstallStepRunner
  onProgress: (p: InstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: InstallStage }> {
  let stage: InstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir)

    let useCuda = opts.device === 'cuda'
    if (opts.device === 'auto') {
      stage = 'detect-gpu'
      opts.onProgress({ stage, message: '检测 GPU…' })
      useCuda = await opts.steps.detectGpu()
    }

    stage = 'install-torch'
    opts.onProgress({ stage, message: useCuda ? '安装 PyTorch (CUDA)…' : '安装 PyTorch (CPU)…' })
    await opts.steps.installTorch(opts.destDir, useCuda)

    stage = 'install-gsv-tts-lite'
    opts.onProgress({ stage, message: '安装 GSV-TTS-Lite…' })
    await opts.steps.installGsvTtsLite(opts.destDir)

    stage = 'warm-start-models'
    opts.onProgress({ stage, message: '下载基础模型(首次)…' })
    await opts.steps.warmStartModels(opts.destDir)

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
