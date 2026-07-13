export type GenieInstallStage = 'download-python' | 'enable-pip' | 'install-genie-tts' | 'download-genie-data' | 'done'

export interface GenieInstallProgress { stage: GenieInstallStage; message: string }

export interface GenieInstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
  installGenieTts(destDir: string, onProgress: (message: string) => void): Promise<void>
  downloadGenieData(destDir: string): Promise<void>
}

export async function runGenieRuntimeInstall(opts: {
  destDir: string
  steps: GenieInstallStepRunner
  onProgress: (p: GenieInstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: GenieInstallStage }> {
  let stage: GenieInstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'install-genie-tts'
    opts.onProgress({ stage, message: '安装 Genie-TTS…' })
    await opts.steps.installGenieTts(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'download-genie-data'
    opts.onProgress({ stage, message: '下载基础模型(首次,约 391MB)…' })
    await opts.steps.downloadGenieData(opts.destDir)

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
