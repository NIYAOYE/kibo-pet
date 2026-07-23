import { describe, it, expect, vi } from 'vitest'
import { runTranslateRuntimeInstall, type TranslateInstallStepRunner, type TranslateInstallProgress } from './translateRuntimeInstall'

function fakeSteps(overrides?: Partial<TranslateInstallStepRunner>): TranslateInstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    installTranslateDeps: vi.fn(async () => {}),
    downloadNllbModel: vi.fn(async (_dir: string, _onProgress: (message: string) => void) => {}),
    ...overrides
  }
}

describe('runTranslateRuntimeInstall', () => {
  it('按顺序跑完全部步骤', async () => {
    const steps = fakeSteps()
    const progress: TranslateInstallProgress[] = []
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'install-translate-deps', 'download-nllb-model', 'done'
    ])
    expect(steps.downloadEmbeddablePython).toHaveBeenCalledWith('D:/tr')
    expect(steps.downloadNllbModel).toHaveBeenCalledWith('D:/tr', expect.any(Function))
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installTranslateDeps: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-translate-deps' })
    expect(steps.downloadNllbModel).not.toHaveBeenCalled()
  })

  it('子步骤的 onProgress 回调,以当前 stage 转发给顶层 onProgress', async () => {
    const progress: TranslateInstallProgress[] = []
    const steps = fakeSteps({
      downloadNllbModel: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('下载翻译模型(1/3):config.json') })
    })
    const r = await runTranslateRuntimeInstall({ destDir: 'D:/tr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress).toContainEqual({ stage: 'download-nllb-model', message: '下载翻译模型(1/3):config.json' })
  })
})
