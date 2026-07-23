export type TranslateInstallStage = 'download-python' | 'enable-pip' | 'install-translate-deps' | 'download-nllb-model' | 'done'

export interface TranslateInstallProgress { stage: TranslateInstallStage; message: string }

export interface TranslateInstallStepRunner {
  downloadEmbeddablePython(destDir: string): Promise<void>
  enablePip(destDir: string, onProgress: (message: string) => void): Promise<void>
  installTranslateDeps(destDir: string, onProgress: (message: string) => void): Promise<void>
  downloadNllbModel(destDir: string, onProgress: (message: string) => void): Promise<void>
}

export async function runTranslateRuntimeInstall(opts: {
  destDir: string
  steps: TranslateInstallStepRunner
  onProgress: (p: TranslateInstallProgress) => void
}): Promise<{ ok: true } | { ok: false; error: string; stage: TranslateInstallStage }> {
  let stage: TranslateInstallStage = 'download-python'
  try {
    opts.onProgress({ stage, message: '下载 Python 运行时…' })
    await opts.steps.downloadEmbeddablePython(opts.destDir)

    stage = 'enable-pip'
    opts.onProgress({ stage, message: '启用 pip…' })
    await opts.steps.enablePip(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'install-translate-deps'
    opts.onProgress({ stage, message: '安装 ctranslate2/sentencepiece…' })
    await opts.steps.installTranslateDeps(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'download-nllb-model'
    opts.onProgress({ stage, message: '下载翻译模型(约 630MB)…' })
    await opts.steps.downloadNllbModel(opts.destDir, (message) => opts.onProgress({ stage, message }))

    stage = 'done'
    opts.onProgress({ stage, message: '安装完成' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), stage }
  }
}
