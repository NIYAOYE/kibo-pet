import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind, type SearchBackendKind, type TtsSettings, type TtsDevice, type TtsTargetLanguage, type TtsPlaybackTrigger, type TtsSynthesisChunking, type TtsTextSplit, type TtsBackend } from '@shared/llm'
import type { VoiceRuntimeState, StageImportOutcome } from '@shared/ipc'
import { Live2DPetRenderer } from './live2dRenderer'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const preset = $<HTMLSelectElement>('preset')
const baseURL = $<HTMLInputElement>('baseURL')
const model = $<HTMLInputElement>('model')
const key = $<HTMLInputElement>('key')
const status = $<HTMLElement>('status')
const searchBackend = $<HTMLSelectElement>('searchBackend')
const searchKeyRow = $<HTMLElement>('searchKeyRow')
const searchKey = $<HTMLInputElement>('searchKey')
const embBaseURL = $<HTMLInputElement>('embBaseURL')
const embModel = $<HTMLInputElement>('embModel')
const embKey = $<HTMLInputElement>('embKey')
const autoCopyResult = $<HTMLInputElement>('autoCopyResult')
const firecrawlEnabled = $<HTMLInputElement>('firecrawlEnabled')
const firecrawlKey = $<HTMLInputElement>('firecrawlKey')
const firecrawlBaseURL = $<HTMLInputElement>('firecrawlBaseURL')
const firecrawlKeyRow = $<HTMLElement>('firecrawlKeyRow')
const firecrawlBaseRow = $<HTMLElement>('firecrawlBaseRow')
const appFocusLlmOpenerEnabled = $<HTMLInputElement>('appFocusLlmOpenerEnabled')
const desktopControlEnabled = $<HTMLInputElement>('desktopControlEnabled')
const gpuAccelerationExperimental = $<HTMLInputElement>('gpuAccelerationExperimental')
const live2dMouseTrackingEnabled = $<HTMLInputElement>('live2dMouseTrackingEnabled')
const petSelect = $<HTMLSelectElement>('petSelect')
const importPetBtn = $<HTMLButtonElement>('importPet')
const importDetail = $<HTMLElement>('importDetail')
const importPreview = $<HTMLElement>('importPreview')
const importPreviewCanvas = $<HTMLCanvasElement>('importPreviewCanvas')
const importPreviewName = $<HTMLElement>('importPreviewName')
const importPreviewWarnings = $<HTMLElement>('importPreviewWarnings')
const importPreviewConfirm = $<HTMLButtonElement>('importPreviewConfirm')
const importPreviewCancel = $<HTMLButtonElement>('importPreviewCancel')
const relaunchBtn = $<HTMLButtonElement>('relaunch')
const noPetBanner = $<HTMLElement>('noPetBanner')
const closeBtn = $<HTMLButtonElement>('closeBtn')
closeBtn.addEventListener('click', () => window.close())

// 设置窗口是独立的 BrowserWindow(独立 JS 全局),这里覆盖 window.petApi.updateLive2DTransform
// 只影响本窗口——不会影响宠物窗口里真实的 window.petApi。Live2DPetRenderer.load() 首次
// 自动对齐模型尺寸时会无条件调用这个方法持久化结果;预览的是尚未提交的 staging 包,
// 绝不能借这个调用误写当前激活宠物的 pet.json,所以在本窗口里整体 stub 掉。
window.petApi.updateLive2DTransform = async () => ({ ok: true })

let pendingStaging: { stagingId: string; manifestId: string } | null = null
let previewRenderer: Live2DPetRenderer | null = null

function appendWarnings(target: HTMLElement, warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return
  target.style.display = 'block'
  for (const w of warnings) {
    const line = document.createElement('div')
    line.textContent = `· ${w}`
    target.appendChild(line)
  }
}

async function closeImportPreview(): Promise<void> {
  if (previewRenderer) {
    await previewRenderer.destroy()
    previewRenderer = null
  }
  importPreview.style.display = 'none'
  importPreviewWarnings.innerHTML = ''
  importPreviewWarnings.style.display = 'none'
  importPreviewName.textContent = ''
  pendingStaging = null
}
let savedActivePetId = 'luluka' // 保存前的值,用于判断是否需要重启
// 本页是否是在"引导模式(无任何已装宠物包)"下打开的——见 save 按钮处理里的用法:
// 这种情况下即便用户选中的宠物 id 恰好等于 savedActivePetId 的默认值(比如重新导入了
// 一个同样叫 luluka 的包),应用本身也还没正常启动,任何一次成功保存都需要重启才能生效。
let startedWithNoPet = false

// 语音(TTS)分节控件
const ttsEnabled = $<HTMLInputElement>('ttsEnabled')
const ttsBackend = $<HTMLSelectElement>('ttsBackend')
const ttsBackendUnavailable = $<HTMLElement>('ttsBackendUnavailable')
const ttsRuntimeStatus = $<HTMLElement>('ttsRuntimeStatus')
const ttsInstallPath = $<HTMLInputElement>('ttsInstallPath')
const ttsPickPath = $<HTMLButtonElement>('ttsPickPath')
const ttsInstall = $<HTMLButtonElement>('ttsInstall')
const ttsImport = $<HTMLButtonElement>('ttsImport')
const ttsExport = $<HTMLButtonElement>('ttsExport')
const ttsInstallLog = $<HTMLPreElement>('ttsInstallLog')
const ttsDevice = $<HTMLSelectElement>('ttsDevice')
const ttsUseFlashAttn = $<HTMLInputElement>('ttsUseFlashAttn')
const ttsTargetLanguage = $<HTMLSelectElement>('ttsTargetLanguage')
const ttsPlaybackTrigger = $<HTMLSelectElement>('ttsPlaybackTrigger')
const ttsSynthesisChunking = $<HTMLSelectElement>('ttsSynthesisChunking')
const ttsTextSplit = $<HTMLSelectElement>('ttsTextSplit')
const ttsSpeed = $<HTMLInputElement>('ttsSpeed')
const ttsNoiseScale = $<HTMLInputElement>('ttsNoiseScale')
const ttsTemperature = $<HTMLInputElement>('ttsTemperature')
const ttsTopK = $<HTMLInputElement>('ttsTopK')
const ttsTopP = $<HTMLInputElement>('ttsTopP')
const ttsRepetitionPenalty = $<HTMLInputElement>('ttsRepetitionPenalty')
const ttsIsCutText = $<HTMLInputElement>('ttsIsCutText')
const ttsCutMinLen = $<HTMLInputElement>('ttsCutMinLen')
const ttsCutMute = $<HTMLInputElement>('ttsCutMute')
const ttsAdvancedParams = $<HTMLElement>('ttsAdvancedParams')
const genieRuntimeStatus = $<HTMLElement>('genieRuntimeStatus')
const genieInstallPath = $<HTMLInputElement>('genieInstallPath')
const geniePickPath = $<HTMLButtonElement>('geniePickPath')
const genieInstall = $<HTMLButtonElement>('genieInstall')
const genieImport = $<HTMLButtonElement>('genieImport')
const genieExport = $<HTMLButtonElement>('genieExport')
const genieInstallLog = $<HTMLPreElement>('genieInstallLog')

function formatRuntimeState(s: VoiceRuntimeState): string {
  if (!s.installed) return '运行时状态:未安装'
  const ver = s.gsvTtsLiteVersion ? ` · ${s.gsvTtsLiteVersion}` : ''
  const dev = s.device ? ` · ${s.device}` : ''
  return `运行时状态:已安装${ver}${dev}`
}

function formatGenieRuntimeState(s: { installed: boolean; genieTtsVersion?: string }): string {
  if (!s.installed) return '运行时状态:未安装'
  const ver = s.genieTtsVersion ? ` · ${s.genieTtsVersion}` : ''
  return `运行时状态:已安装${ver}`
}

function appendInstallLog(line: string): void {
  ttsInstallLog.style.display = ''
  ttsInstallLog.textContent += `${line}\n`
  ttsInstallLog.scrollTop = ttsInstallLog.scrollHeight
}

function appendGenieInstallLog(line: string): void {
  genieInstallLog.style.display = ''
  genieInstallLog.textContent += `${line}\n`
  genieInstallLog.scrollTop = genieInstallLog.scrollHeight
}

function currentTts(): TtsSettings {
  return {
    enabled: ttsEnabled.checked,
    backend: ttsBackend.value as TtsBackend,
    runtimeInstallPath: ttsInstallPath.value.trim(),
    device: ttsDevice.value as TtsDevice,
    useFlashAttn: ttsUseFlashAttn.checked,
    targetLanguage: ttsTargetLanguage.value as TtsTargetLanguage,
    playbackTrigger: ttsPlaybackTrigger.value as TtsPlaybackTrigger,
    synthesisChunking: ttsSynthesisChunking.value as TtsSynthesisChunking,
    textSplit: ttsTextSplit.value as TtsTextSplit,
    isCutText: ttsIsCutText.checked,
    cutMinLen: parseInt(ttsCutMinLen.value, 10) || 0,
    cutMute: parseFloat(ttsCutMute.value) || 0,
    speed: parseFloat(ttsSpeed.value) || 1,
    noiseScale: parseFloat(ttsNoiseScale.value) || 0,
    temperature: parseFloat(ttsTemperature.value) || 1,
    topK: parseInt(ttsTopK.value, 10) || 1,
    topP: parseFloat(ttsTopP.value) || 1,
    repetitionPenalty: parseFloat(ttsRepetitionPenalty.value) || 1
  }
}

function applyTts(t: TtsSettings): void {
  ttsEnabled.checked = t.enabled
  ttsBackend.value = t.backend
  ttsInstallPath.value = t.runtimeInstallPath
  ttsDevice.value = t.device
  ttsUseFlashAttn.checked = t.useFlashAttn
  ttsTargetLanguage.value = t.targetLanguage
  ttsPlaybackTrigger.value = t.playbackTrigger
  ttsSynthesisChunking.value = t.synthesisChunking
  ttsTextSplit.value = t.textSplit
  ttsIsCutText.checked = t.isCutText
  ttsCutMinLen.value = String(t.cutMinLen)
  ttsCutMute.value = String(t.cutMute)
  ttsSpeed.value = String(t.speed)
  ttsNoiseScale.value = String(t.noiseScale)
  ttsTemperature.value = String(t.temperature)
  ttsTopK.value = String(t.topK)
  ttsTopP.value = String(t.topP)
  ttsRepetitionPenalty.value = String(t.repetitionPenalty)
}

function currentTtsGenie(): { runtimeInstallPath: string } {
  return { runtimeInstallPath: genieInstallPath.value.trim() }
}

function applyTtsGenie(t: { runtimeInstallPath: string }): void {
  genieInstallPath.value = t.runtimeInstallPath
}

let activePetVoice: import('@shared/petPackage').PetVoice | undefined

function refreshBackendAvailability(): void {
  const v = activePetVoice
  const supportsGenie = !!v?.onnxModel
  const supportsGsv = !!(v?.gptModel && v?.sovitsModel)
  const selected = ttsBackend.value as TtsBackend
  const unavailable = selected === 'genie-tts' ? !supportsGenie : !supportsGsv
  ttsBackendUnavailable.style.display = unavailable ? '' : 'none'
  // 生成参数(speed/noiseScale/temperature/topK/topP/repetitionPenalty/切分相关)只有 GSV-TTS-Lite
  // 支持——Genie-TTS 的 tts_async() 没有这些旋钮,genie_server.py 收到也会直接忽略,选中 Genie-TTS
  // 时这块 UI 对用户没有意义,隐藏掉避免误导。
  ttsAdvancedParams.style.display = selected === 'genie-tts' ? 'none' : ''
}

ttsBackend.addEventListener('change', refreshBackendAvailability)

ttsPickPath.addEventListener('click', async () => {
  const p = await window.voiceApi.pickInstallPath()
  if (p) ttsInstallPath.value = p
})

ttsInstall.addEventListener('click', () => {
  if (!ttsInstallPath.value.trim()) {
    status.textContent = '✗ 请先选择安装位置'
    return
  }
  ttsInstallLog.textContent = ''
  appendInstallLog('开始安装…')
  window.voiceApi.startInstall()
})

window.voiceApi.onInstallProgress((p) => {
  appendInstallLog(`[${p.stage}] ${p.message}`)
})

ttsImport.addEventListener('click', async () => {
  try {
    const res = await window.voiceApi.importArchive()
    status.textContent = res.ok ? '✓ 导入成功' : `✗ ${res.error ?? '导入失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

ttsExport.addEventListener('click', async () => {
  try {
    const res = await window.voiceApi.exportArchive()
    status.textContent = res.ok ? '✓ 导出成功' : `✗ ${res.error ?? '导出失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

geniePickPath.addEventListener('click', async () => {
  const p = await window.genieVoiceApi.pickInstallPath()
  if (p) genieInstallPath.value = p
})

genieInstall.addEventListener('click', () => {
  if (!genieInstallPath.value.trim()) {
    status.textContent = '✗ 请先选择安装位置'
    return
  }
  genieInstallLog.textContent = ''
  appendGenieInstallLog('开始安装…')
  window.genieVoiceApi.startInstall()
})

window.genieVoiceApi.onInstallProgress((p) => {
  appendGenieInstallLog(`[${p.stage}] ${p.message}`)
})

genieImport.addEventListener('click', async () => {
  try {
    const res = await window.genieVoiceApi.importArchive()
    status.textContent = res.ok ? '✓ 导入成功' : `✗ ${res.error ?? '导入失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

genieExport.addEventListener('click', async () => {
  try {
    const res = await window.genieVoiceApi.exportArchive()
    status.textContent = res.ok ? '✓ 导出成功' : `✗ ${res.error ?? '导出失败'}`
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

// 侧边栏分页:点击 navitem → 显示对应 .page,高亮当前项
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('#sidenav .navitem'))
const pages = Array.from(document.querySelectorAll<HTMLElement>('#pages .page'))

function showPage(page: string): void {
  for (const s of pages) s.classList.toggle('active', s.dataset.page === page)
  for (const n of navItems) n.classList.toggle('active', n.dataset.page === page)
}

for (const n of navItems) {
  n.addEventListener('click', () => showPage(n.dataset.page ?? 'model'))
}

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
searchBackend.addEventListener('change', () => {
  searchKeyRow.style.display = searchBackend.value === 'tavily' ? '' : 'none'
})
function syncFirecrawlRows(): void {
  const show = firecrawlEnabled.checked ? '' : 'none'
  firecrawlKeyRow.style.display = show
  firecrawlBaseRow.style.display = show
}
firecrawlEnabled.addEventListener('change', syncFirecrawlRows)
desktopControlEnabled.addEventListener('change', () => {
  if (!desktopControlEnabled.checked) return
  void (async () => {
    const confirmed = await window.settingsApi.confirmDesktopControl()
    if (!confirmed) desktopControlEnabled.checked = false
  })()
})

const browserControlEnabled = $<HTMLInputElement>('browserControlEnabled')
const browserControlMode = $<HTMLSelectElement>('browserControlMode')
const browserControlModeRow = $<HTMLLabelElement>('browserControlModeRow')
const browserControlChromePath = $<HTMLInputElement>('browserControlChromePath')
const browserControlChromePathRow = $<HTMLLabelElement>('browserControlChromePathRow')
const browserControlChromePathHint = $<HTMLDivElement>('browserControlChromePathHint')
// CDP 模式的强确认是否已在"本次渲染进程会话"内出现过——见 Save 处的兜底守卫注释。
let cdpModeConfirmedThisSession = false

function syncBrowserControlModeRow(): void {
  const show = browserControlEnabled.checked ? '' : 'none'
  browserControlModeRow.style.display = show
  browserControlChromePathRow.style.display = show
  browserControlChromePathHint.style.display = show
}
browserControlEnabled.addEventListener('change', () => {
  syncBrowserControlModeRow()
  if (!browserControlEnabled.checked) return
  void (async () => {
    const confirmed = await window.settingsApi.confirmBrowserControl()
    if (!confirmed) { browserControlEnabled.checked = false; syncBrowserControlModeRow(); return }
  })()
})
browserControlMode.addEventListener('change', () => {
  if (browserControlMode.value !== 'cdp') { cdpModeConfirmedThisSession = false; return }
  void (async () => {
    const confirmed = await window.settingsApi.confirmCdpMode()
    if (!confirmed) { browserControlMode.value = 'isolated'; return }
    cdpModeConfirmedThisSession = true
  })()
})
$<HTMLButtonElement>('openMemoryDir').addEventListener('click', () => window.settingsApi.openMemoryDir())

async function refreshPets(selectId: string): Promise<void> {
  const pets = await window.settingsApi.listPets()
  petSelect.innerHTML = ''
  for (const p of pets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.renderReady ? p.displayName : `${p.displayName}(渲染引擎未就绪)`
    if (!p.renderReady) opt.disabled = true
    petSelect.appendChild(opt)
  }
  // 选中项:优先目标 id;若不可选(不在列表/坏包/渲染未就绪)则回落第一个可选宠物。
  // 注意:disabled 的 <option> 仍然可以被 JS 赋值选中(HTML 规范只挡用户交互式选择),
  // 所以"目标 id 在列表里但 renderReady:false"这个情况必须单独判断,不能只看
  // petSelect.value !== selectId 这一条(赋值本身会"成功",走不到这个分支)。
  const selectable = pets.filter((p) => p.renderReady)
  petSelect.value = selectId
  const target = pets.find((p) => p.id === selectId)
  if ((!target || !target.renderReady) && selectable.length > 0) petSelect.value = selectable[0].id
}

importPetBtn.addEventListener('click', async () => {
  importDetail.style.display = 'none'
  importDetail.innerHTML = ''
  await closeImportPreview()
  try {
    const res: StageImportOutcome | null = await window.settingsApi.stageImportPet()
    if (!res) return // 用户取消,静默
    if (!res.ok) {
      status.textContent = `✗ ${res.message}`
      return
    }
    if (res.committed) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
      appendWarnings(importDetail, res.warnings)
      return
    }
    pendingStaging = { stagingId: res.stagingId, manifestId: res.manifestId }
    importPreviewName.textContent = res.displayName
    appendWarnings(importPreviewWarnings, res.warnings)
    importPreview.style.display = 'block'
    previewRenderer = new Live2DPetRenderer(importPreviewCanvas)
    try {
      await previewRenderer.load(res.previewSource)
    } catch (loadErr) {
      // 预览渲染失败(损坏的 moc3/贴图、WebGL 问题等)——staging 通过了结构性检查,
      // 但实际渲染不出来。绝不能让确认按钮留在可点状态去提交一个自己都没渲染成功的包,
      // 所以这里必须像用户主动取消一样,立刻丢弃 staging + 关闭预览面板,而不是只在
      // status 里报错(那样 pendingStaging/预览面板都还在,用户仍能点"确认导入")。
      await window.settingsApi.discardStagedImport(res.stagingId)
      await closeImportPreview()
      status.textContent = `✗ 预览渲染失败,已自动放弃本次导入:${(loadErr as Error)?.message ?? '未知错误'}`
      return
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

importPreviewConfirm.addEventListener('click', async () => {
  if (!pendingStaging) return
  const { stagingId, manifestId } = pendingStaging
  try {
    const res = await window.settingsApi.commitStagedImport(stagingId, manifestId)
    await closeImportPreview()
    if (res.ok) {
      await refreshPets(res.pet.id)
      noPetBanner.style.display = 'none'
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

importPreviewCancel.addEventListener('click', async () => {
  if (pendingStaging) await window.settingsApi.discardStagedImport(pendingStaging.stagingId)
  await closeImportPreview()
})

relaunchBtn.addEventListener('click', () => window.settingsApi.relaunch())

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
    // 兜底:某次会话内曾经"设置开关关闭时把 mode 之前存的 cdp 原样带回来又直接重新勾选主开关"
    // 这类路径能跳过上面 change 事件里的 CDP 强确认(见分支最终审查发现)——保存前按"即将写入
    // 的最终状态"重新判定一次,而不是只信任事件历史。
    if (browserControlEnabled.checked && browserControlMode.value === 'cdp' && !cdpModeConfirmedThisSession) {
      const confirmed = await window.settingsApi.confirmCdpMode()
      if (!confirmed) { status.textContent = '✗ 已取消保存(未确认接管真实浏览器风险)'; return }
      cdpModeConfirmedThisSession = true
    }
    if (key.value) {
      const ok = await window.settingsApi.setApiKey(key.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Key'; return }
    }
    if (searchBackend.value === 'tavily' && searchKey.value) {
      const ok = await window.settingsApi.setSearchKey(searchKey.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存搜索 Key'; return }
    }
    if (embKey.value) {
      const ok = await window.settingsApi.setEmbeddingKey(embKey.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Embedding Key'; return }
    }
    if (firecrawlEnabled.checked && firecrawlKey.value) {
      const ok = await window.settingsApi.setFirecrawlKey(firecrawlKey.value)
      if (!ok) { status.textContent = '✗ 当前系统不支持安全存储,无法保存 Firecrawl Key'; return }
    }
    const embedding =
      embBaseURL.value.trim() && embModel.value.trim()
        ? { baseURL: embBaseURL.value.trim(), model: embModel.value.trim() }
        : null
    await window.settingsApi.setSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activePetId: petSelect.value,
      provider,
      search: { backend: searchBackend.value as SearchBackendKind },
      memory: { embedding },
      textTools: { autoCopyResult: autoCopyResult.checked },
      firecrawl: {
        enabled: firecrawlEnabled.checked,
        baseURL: firecrawlBaseURL.value.trim() || undefined
      },
      desktopControl: { enabled: desktopControlEnabled.checked },
      browserControl: {
        enabled: browserControlEnabled.checked,
        mode: browserControlMode.value as 'isolated' | 'cdp',
        chromePath: browserControlChromePath.value.trim() || undefined
      },
      appFocusLlmOpener: { enabled: appFocusLlmOpenerEnabled.checked },
      gpuAcceleration: { experimental: gpuAccelerationExperimental.checked },
      tts: currentTts(),
      ttsGenie: currentTtsGenie(),
      live2d: { mouseTrackingEnabled: live2dMouseTrackingEnabled.checked }
    })
    if (petSelect.value !== savedActivePetId || startedWithNoPet) {
      savedActivePetId = petSelect.value
      relaunchBtn.style.display = ''
      status.textContent = '✓ 已保存 · 需要重启才能生效'
    } else {
      status.textContent = '✓ 已保存'
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
})

// 初始化:回填已存设置
void (async () => {
  const snap = await window.settingsApi.getSettings()
  savedActivePetId = snap.settings.activePetId
  appFocusLlmOpenerEnabled.checked = snap.settings.appFocusLlmOpener.enabled
  applyTts(snap.settings.tts)
  applyTtsGenie(snap.settings.ttsGenie)
  activePetVoice = snap.activePetVoice
  refreshBackendAvailability()
  await refreshPets(snap.settings.activePetId)
  preset.value = resolvePresetId(snap.settings.provider.kind, snap.settings.provider.baseURL)
  applyPreset(preset.value)
  if (snap.settings.provider.baseURL) baseURL.value = snap.settings.provider.baseURL
  if (snap.settings.provider.model) model.value = snap.settings.provider.model
  searchBackend.value = snap.settings.search.backend
  searchKeyRow.style.display = snap.settings.search.backend === 'tavily' ? '' : 'none'
  if (snap.hasSearchKey) searchKey.placeholder = '(已配置,如需更换请重新填写)'
  if (snap.settings.memory.embedding) {
    embBaseURL.value = snap.settings.memory.embedding.baseURL
    embModel.value = snap.settings.memory.embedding.model
  }
  if (snap.hasEmbeddingKey) embKey.placeholder = '(已配置,如需更换请重新填写)'
  autoCopyResult.checked = snap.settings.textTools.autoCopyResult
  firecrawlEnabled.checked = snap.settings.firecrawl.enabled
  if (snap.settings.firecrawl.baseURL) firecrawlBaseURL.value = snap.settings.firecrawl.baseURL
  if (snap.hasFirecrawlKey) firecrawlKey.placeholder = '(已配置,如需更换请重新填写)'
  syncFirecrawlRows()
  desktopControlEnabled.checked = snap.settings.desktopControl.enabled
  gpuAccelerationExperimental.checked = snap.settings.gpuAcceleration.experimental
  live2dMouseTrackingEnabled.checked = snap.settings.live2d.mouseTrackingEnabled
  browserControlEnabled.checked = snap.settings.browserControl.enabled
  browserControlMode.value = snap.settings.browserControl.mode
  browserControlChromePath.value = snap.settings.browserControl.chromePath ?? ''
  cdpModeConfirmedThisSession = false // 从快照恢复的值(哪怕是 cdp)不算"本会话已确认过"
  syncBrowserControlModeRow()
  noPetBanner.style.display = snap.noPetInstalled ? '' : 'none'
  startedWithNoPet = snap.noPetInstalled
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
  showPage(snap.noPetInstalled ? 'pet' : 'model') // 没有宠物包时直接落地到"宠物"页,引导导入
})()

void (async () => {
  try {
    ttsRuntimeStatus.textContent = formatRuntimeState(await window.voiceApi.getState())
  } catch {
    // 无宠物包引导模式下语音子系统未接线(见 startOnboarding),这里静默即可
  }
})()

void (async () => {
  try {
    genieRuntimeStatus.textContent = formatGenieRuntimeState(await window.genieVoiceApi.getState())
  } catch {
    // 无宠物包引导模式下语音子系统未接线,这里静默即可
  }
})()
