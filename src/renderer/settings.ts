import { PRESETS, SETTINGS_SCHEMA_VERSION, resolvePresetId, type ProviderSettings, type ProviderKind, type SearchBackendKind } from '@shared/llm'

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
const desktopControlEnabled = $<HTMLInputElement>('desktopControlEnabled')
const petSelect = $<HTMLSelectElement>('petSelect')
const importPetBtn = $<HTMLButtonElement>('importPet')
const relaunchBtn = $<HTMLButtonElement>('relaunch')
let savedActivePetId = 'luluka' // 保存前的值,用于判断是否需要重启

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
    opt.textContent = p.displayName
    petSelect.appendChild(opt)
  }
  // 选中项:优先目标 id;若不在列表(如坏包)则回落列表首项
  petSelect.value = selectId
  if (petSelect.value !== selectId && pets.length > 0) petSelect.value = pets[0].id
}

importPetBtn.addEventListener('click', async () => {
  try {
    const res = await window.settingsApi.importPet()
    if (!res) return // 用户取消,静默
    if (res.ok) {
      await refreshPets(res.pet.id)
      status.textContent = `✓ 已导入:${res.pet.displayName}(选它并保存后重启生效)`
    } else {
      status.textContent = `✗ ${res.message}`
    }
  } catch (err) {
    status.textContent = `✗ ${(err as Error)?.message ?? '出错了'}`
  }
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
      }
    })
    if (petSelect.value !== savedActivePetId) {
      savedActivePetId = petSelect.value
      relaunchBtn.style.display = ''
      status.textContent = '✓ 已保存 · 宠物切换将在重启后生效'
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
  browserControlEnabled.checked = snap.settings.browserControl.enabled
  browserControlMode.value = snap.settings.browserControl.mode
  browserControlChromePath.value = snap.settings.browserControl.chromePath ?? ''
  cdpModeConfirmedThisSession = false // 从快照恢复的值(哪怕是 cdp)不算"本会话已确认过"
  syncBrowserControlModeRow()
  status.textContent = snap.hasKey ? '(已配置 Key,如需更换请重新填写)' : '首次使用:选 Provider、填 Key 即可。'
  showPage('model') // 默认落地页:模型 · API
})()
