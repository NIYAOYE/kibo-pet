import { describe, it, expect, vi } from 'vitest'
import { runGenieRuntimeInstall, type GenieInstallStepRunner, type GenieInstallProgress } from './genieRuntimeInstall'

function fakeSteps(overrides?: Partial<GenieInstallStepRunner>): GenieInstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    installGenieTts: vi.fn(async () => {}),
    downloadGenieData: vi.fn(async (_dir: string, _onProgress: (message: string) => void) => {}),
    ...overrides
  }
}

describe('runGenieRuntimeInstall', () => {
  it('按顺序跑完全部步骤', async () => {
    const steps = fakeSteps()
    const progress: GenieInstallProgress[] = []
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'install-genie-tts', 'download-genie-data', 'done'
    ])
    expect(steps.downloadEmbeddablePython).toHaveBeenCalledWith('D:/gr')
    expect(steps.downloadGenieData).toHaveBeenCalledWith('D:/gr', expect.any(Function))
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installGenieTts: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-genie-tts' })
    expect(steps.downloadGenieData).not.toHaveBeenCalled()
  })

  it('enablePip/installGenieTts/downloadGenieData 收到的 onProgress 回调,会以当前 stage 转发给顶层 onProgress', async () => {
    const progress: GenieInstallProgress[] = []
    const steps = fakeSteps({
      enablePip: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('使用清华源安装…') }),
      installGenieTts: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('安装完成') }),
      downloadGenieData: vi.fn(async (_dir: string, onProgress: (m: string) => void) => { onProgress('第 1 次尝试失败,2 秒后重试') })
    })
    const r = await runGenieRuntimeInstall({ destDir: 'D:/gr', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(progress).toContainEqual({ stage: 'enable-pip', message: '使用清华源安装…' })
    expect(progress).toContainEqual({ stage: 'install-genie-tts', message: '安装完成' })
    expect(progress).toContainEqual({ stage: 'download-genie-data', message: '第 1 次尝试失败,2 秒后重试' })
  })
})
