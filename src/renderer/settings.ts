import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind } from '@shared/llm'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const preset = $<HTMLSelectElement>('preset')
const baseURL = $<HTMLInputElement>('baseURL')
const model = $<HTMLInputElement>('model')
const key = $<HTMLInputElement>('key')
const status = $<HTMLElement>('status')

for (const p of PRESETS) {
  const opt = document.createElement('option')
  opt.value = p.id
  opt.textContent = p.label
  preset.appendChild(opt)
}

function kindOf(presetId: string): ProviderKind {
  return PRESETS.find((p) => p.id === presetId)?.kind ?? 'anthropic'
}

function applyPreset(presetId: string): void {
  const p = PRESETS.find((x) => x.id === presetId)
  if (!p) return
  baseURL.value = p.baseURL ?? ''
  model.value = p.defaultModel
}

function currentProvider(): ProviderSettings {
  return {
    kind: kindOf(preset.value),
    baseURL: baseURL.value.trim() || undefined,
    model: model.value.trim()
  }
}

preset.addEventListener('change', () => applyPreset(preset.value))

$<HTMLButtonElement>('test').addEventListener('click', async () => {
  status.textContent = '测试中…'
  try {
    const res = await window.settingsApi.testConnection(currentProvider(), key.value)
    status.textContent = res.ok ? '✓ 连接成功' : `✗ ${res.error ?? '连接失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

$<HTMLButtonElement>('save').addEventListener('click', async () => {
  const provider = currentProvider()
  try {
    if (key.value) {
      const ok = await window.settingsApi.setApiKey(key.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Key'; return }
    }
    await window.settingsApi.setSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, provider })
    status.textContent = '✓ 已保存'
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

// 初始化:回填已存设置
void (async () => {
  const snap = await window.settingsApi.getSettings()
  preset.value = resolvePresetId(snap.settings.provider.kind, snap.settings.provider.baseURL)
  applyPreset(preset.value)
  if (snap.settings.provider.baseURL) baseURL.value = snap.settings.provider.baseURL
  if (snap.settings.provider.model) model.value = snap.settings.provider.model
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
})()
