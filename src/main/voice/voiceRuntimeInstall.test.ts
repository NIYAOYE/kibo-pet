import { describe, it, expect, vi } from 'vitest'
import { runVoiceRuntimeInstall, type InstallStepRunner, type InstallProgress } from './voiceRuntimeInstall'

function fakeSteps(overrides?: Partial<InstallStepRunner>): InstallStepRunner {
  return {
    downloadEmbeddablePython: vi.fn(async () => {}),
    enablePip: vi.fn(async () => {}),
    detectGpu: vi.fn(async () => true),
    installTorch: vi.fn(async () => {}),
    installGsvTtsLite: vi.fn(async () => {}),
    warmStartModels: vi.fn(async () => {}),
    ...overrides
  }
}

describe('runVoiceRuntimeInstall', () => {
  it('device=auto 且检测到 GPU → 按顺序跑完全部步骤,installTorch 收到 useCuda:true', async () => {
    const steps = fakeSteps()
    const progress: InstallProgress[] = []
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'auto', steps, onProgress: (p) => progress.push(p) })
    expect(r).toEqual({ ok: true })
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true, expect.any(Function))
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'detect-gpu', 'install-torch', 'install-gsv-tts-lite', 'warm-start-models', 'done'
    ])
  })

  it('device=cpu → 不调用 detectGpu,installTorch 收到 useCuda:false', async () => {
    const steps = fakeSteps()
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: true })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', false, expect.any(Function))
  })

  it('device=cuda → 不调用 detectGpu,installTorch 收到 useCuda:true', async () => {
    const steps = fakeSteps()
    await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cuda', steps, onProgress: () => {} })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true, expect.any(Function))
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installTorch: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-torch' })
    expect(steps.installGsvTtsLite).not.toHaveBeenCalled()
  })

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
})
