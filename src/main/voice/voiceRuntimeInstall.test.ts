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
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true)
    expect(progress.map((p) => p.stage)).toEqual([
      'download-python', 'enable-pip', 'detect-gpu', 'install-torch', 'install-gsv-tts-lite', 'warm-start-models', 'done'
    ])
  })

  it('device=cpu → 不调用 detectGpu,installTorch 收到 useCuda:false', async () => {
    const steps = fakeSteps()
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: true })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', false)
  })

  it('device=cuda → 不调用 detectGpu,installTorch 收到 useCuda:true', async () => {
    const steps = fakeSteps()
    await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cuda', steps, onProgress: () => {} })
    expect(steps.detectGpu).not.toHaveBeenCalled()
    expect(steps.installTorch).toHaveBeenCalledWith('D:/vr', true)
  })

  it('某一步失败 → 立即停止,返回失败阶段与错误信息,不跑后续步骤', async () => {
    const steps = fakeSteps({ installTorch: vi.fn(async () => { throw new Error('网络中断') }) })
    const r = await runVoiceRuntimeInstall({ destDir: 'D:/vr', device: 'cpu', steps, onProgress: () => {} })
    expect(r).toEqual({ ok: false, error: '网络中断', stage: 'install-torch' })
    expect(steps.installGsvTtsLite).not.toHaveBeenCalled()
  })
})
