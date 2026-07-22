import type { PetVoice, PetRenderSource } from './petPackage'
import type { PetEvent, Bounds } from './petBrain'
import type { AppSettings, ProviderSettings } from './llm'
import type { TodoItem } from './todo'
import type { ReactionCategory } from './reactionPlanner'

export const IPC = {
  GET_PET: 'pet:get',
  UPDATE_LIVE2D_TRANSFORM: 'pet:updateLive2DTransform',
  MOVE_WINDOW: 'window:move',
  DRAG_START: 'window:drag-start',
  DRAG_END: 'window:drag-end',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  TOGGLE_DIALOG: 'dialog:toggle',
  DIALOG_SET_SIZE: 'dialog:set-size',
  DIALOG_REPORT_COLLAPSED_HEIGHT: 'dialog:report-collapsed-height',
  CHAT_SEND: 'chat:send',
  CHAT_UPDATE: 'chat:update',
  PET_EVENT: 'pet:event',
  QUIT: 'app:quit',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  SET_API_KEY: 'settings:set-key',
  HAS_KEY: 'settings:has-key',
  TEST_CONNECTION: 'settings:test',
  OPEN_SETTINGS: 'settings:open',
  CHAT_STREAM: 'chat:stream',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',
  CANCEL_CHAT: 'chat:cancel',
  CHAT_STATUS: 'chat:status',
  SET_SEARCH_KEY: 'settings:set-search-key',
  SET_EMBEDDING_KEY: 'settings:set-embedding-key',
  SET_FIRECRAWL_KEY: 'settings:set-firecrawl-key',
  CONFIRM_DESKTOP_CONTROL: 'settings:confirm-desktop-control',
  CONFIRM_BROWSER_CONTROL: 'settings:confirm-browser-control',
  CONFIRM_CDP_MODE: 'settings:confirm-cdp-mode',
  OPEN_MEMORY_DIR: 'settings:open-memory-dir',
  MEDIA_PICK_IMAGE: 'media:pick-image',
  MEDIA_CAPTURE_REGION: 'media:capture-region',
  OVERLAY_INIT: 'overlay:init',
  OVERLAY_SUBMIT: 'overlay:submit',
  OVERLAY_CANCEL: 'overlay:cancel',
  LIST_PETS: 'pets:list',
  STAGE_IMPORT_PET: 'pets:stage-import',
  COMMIT_STAGED_IMPORT: 'pets:commit-staged-import',
  DISCARD_STAGED_IMPORT: 'pets:discard-staged-import',
  RELAUNCH_APP: 'app:relaunch',
  LIST_TODOS: 'todos:list',
  ADD_TODO: 'todos:add',
  TOGGLE_TODO: 'todos:toggle',
  REMOVE_TODO: 'todos:remove',
  TODO_UPDATE: 'todos:update',
  TODO_FIRED: 'todos:fired',
  OPEN_TODO_PANEL: 'todos:open-panel',
  BUBBLE_STREAM: 'bubble:stream',
  BUBBLE_STATUS: 'bubble:status',
  BUBBLE_DONE: 'bubble:done',
  BUBBLE_ERROR: 'bubble:error',
  BUBBLE_CLEAR: 'bubble:clear',
  BUBBLE_PLACE: 'bubble:place',
  BUBBLE_LINE: 'bubble:line',
  BUBBLE_RESIZE: 'bubble:resize',
  PET_SPEAK: 'pet:speak',
  CONTEXT_SIGNAL: 'context:signal',
  VOICE_GET_STATE: 'voice:get-state',
  VOICE_PICK_INSTALL_PATH: 'voice:pick-install-path',
  VOICE_START_INSTALL: 'voice:start-install',
  VOICE_INSTALL_PROGRESS: 'voice:install-progress',
  VOICE_IMPORT_ARCHIVE: 'voice:import-archive',
  VOICE_EXPORT_ARCHIVE: 'voice:export-archive',
  VOICE_AUDIO_CHUNK: 'voice:audio-chunk',
  VOICE_AUDIO_DONE: 'voice:audio-done',
  VOICE_AUDIO_ERROR: 'voice:audio-error',
  VOICE_STOP: 'voice:stop',
  VOICE_PLAYBACK_STOP: 'voice:playback-stop',
  GENIE_GET_STATE: 'genie:get-state',
  GENIE_PICK_INSTALL_PATH: 'genie:pick-install-path',
  GENIE_START_INSTALL: 'genie:start-install',
  GENIE_INSTALL_PROGRESS: 'genie:install-progress',
  GENIE_IMPORT_ARCHIVE: 'genie:import-archive',
  GENIE_EXPORT_ARCHIVE: 'genie:export-archive',
  CHAT_LIST_PETS: 'chat:list-pets',
  SWITCH_PET: 'chat:switch-pet',
  PET_SWITCHED: 'chat:pet-switched',
  PET_PREPARE: 'pet:prepare',
  PET_PREPARE_RESULT: 'pet:prepare-result',
  PET_COMMIT: 'pet:commit',
  PET_DISCARD: 'pet:discard',
  WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed',
  MOUSE_FOCUS: 'pet:mouse-focus'
} as const

/** 主进程情境信号(main→renderer 推送):AFK 离开 / 久坐提醒 / 应用焦点感知，均为一次性边沿事件 */
export type ContextSignalKind = 'afk_leave' | 'break_reminder' | 'app_focus'

/** clamp:true keeps the window inside the display work area (autonomous walk);
 *  omitted/false lets it move freely (manual drag), matching MVP-01. */
export interface MoveDelta { dx: number; dy: number; clamp?: boolean }

export interface WindowBounds { workArea: Bounds; window: Bounds }

/** 持久化/展示用:仅标记"这轮有图",绝不携带字节 */
export interface ChatAttachment { kind: 'image' }
/** 发送用(瞬态):携带降采样后的图像字节,不落盘 */
export interface ChatSendAttachment { kind: 'image'; mimeType: string; dataBase64: string }
/** actions:该回合调用过的工具名(按执行顺序,可重复);只供后续回合的提示词拼装感知"上回合做过什么",渲染层不展示 */
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[]; timestamp?: number; actions?: string[] }
export interface ChatSendPayload { text: string; attachments?: ChatSendAttachment[] }

export interface OverlayInit { screenshotDataUrl: string; width: number; height: number }
export interface OverlayRect { x: number; y: number; width: number; height: number }

export interface MediaApi {
  pickImage(): Promise<ChatSendAttachment[]>
  captureRegion(): Promise<ChatSendAttachment | null>
}
export interface OverlayApi {
  onInit(cb: (d: OverlayInit) => void): void
  submit(rect: OverlayRect): void
  cancel(): void
}

export interface Live2DTransformPatch {
  scale: number
  offsetX: number
  offsetY: number
  /** true=这次写入代表最终对齐值(自动测算完成,或人工核对后通过调试挂钩确认),
   *  Live2DPetRenderer.load() 之后不会再重新计算。 */
  autoFitted: boolean
}

export interface PetApi {
  getPet(): Promise<PetRenderSource>
  /** Resolves with the real post-move window/workArea bounds, so callers that
   *  track position (autonomous walk) can stay authoritative instead of
   *  predicting — main always applies clamping against the live display. */
  moveWindow(delta: MoveDelta): Promise<WindowBounds>
  /** Manual drag lifecycle: lets main anchor the drag to a cursor position it
   *  reads itself (via the `screen` module), instead of trusting the
   *  renderer's `MouseEvent.screenX/Y` — those two coordinate spaces can
   *  disagree on a scaled/mixed-DPI multi-monitor setup, and accumulating a
   *  per-event mismatch compounds over the length of the drag. */
  dragStart(): void
  dragEnd(): void
  /** Toggle click-through: when true, mouse events pass through to windows below. */
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  toggleDialog(): void
  onPetEvent(cb: (event: PetEvent) => void): void
  /** 自主/触碰反应：请求主进程按 category 选一句台词，用瞬态气泡显示 */
  petSpeak(category: ReactionCategory): void
  /** 主进程情境信号(AFK 离开/久坐提醒):main→renderer 推送 */
  onContextSignal(cb: (kind: ContextSignalKind) => void): void
  quit(): void
  /** 主进程要求渲染层后台准备一个新宠物(不影响当前画面);渲染层准备完成/失败后必须调用
   *  reportPrepareResult()。见 Phase 5 设计文档 §3。 */
  onPetPrepare(cb: (payload: PetPreparePayload) => void): void
  /** 渲染层向主进程回报 onPetPrepare 的准备结果 */
  reportPrepareResult(requestId: string, ok: boolean, error?: string): void
  /** 主进程确认可以提交:渲染层原子切到已准备好的新宠物 */
  onPetCommit(cb: (payload: PetCommitPayload) => void): void
  /** 主进程确认要丢弃:渲染层销毁已准备但未提交的半成品,当前画面不受影响 */
  onPetDiscard(cb: (payload: PetDiscardPayload) => void): void
  /** 主进程窗口可见性变化(最小化/恢复/锁屏/解锁)推送,驱动 Live2D 场景帧率节流 */
  onWindowVisibilityChanged(cb: (payload: WindowVisibilityPayload) => void): void
  /** 主进程推送的鼠标追踪目标([-1,1] 方向;(0,0) 表示回正),仅当当前宠物是 live2d 且
   *  设置里开启追踪时才会收到非空推送——见 §2 主进程轮询循环。 */
  onMouseFocus(cb: (payload: { x: number; y: number }) => void): void
  /** 把 scale/offsetX/offsetY/autoFitted 写回当前宠物的 pet.json(只覆盖这四个字段,
   *  anchorX/anchorY/bubbleAnchorX/bubbleAnchorY 不变)。两个调用方:Live2DPetRenderer.load()
   *  首次加载时的自动对齐,以及 window.__kiboLive2D 调试挂钩的人工核对/覆盖。
   *  只有当前宠物是 live2d 包时才会成功。 */
  updateLive2DTransform(patch: Live2DTransformPatch): Promise<{ ok: boolean; message?: string }>
}

export interface ChatApi {
  send(payload: ChatSendPayload): void
  onUpdate(cb: (messages: ChatMessage[]) => void): void
  onStream(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  onStatus(cb: (text: string) => void): void
  cancel(): void
  setSize(collapsed: boolean): void
  /** 折叠态渲染层测量到内容自然高度后上报,主进程夹取范围后重设折叠窗口高度 */
  reportCollapsedHeight(height: number): void
  close(): void
  openSettings(): void
  /** 展开态左栏用:头像 + 名字 + 末条消息预览 + 活跃标记(与 SettingsApi.listPets 返回形不同,专供聊天面板) */
  listPetsForChat(): Promise<PetChatListItem[]>
  /** 点头像热切换宠物;返回是否切换成功 */
  switchPet(id: string): Promise<boolean>
  /** 切换完成后主进程通知,渲染层据此刷新右栏头部 + 左栏高亮 */
  onSwitched(cb: (p: PetSwitchedPayload) => void): void
}

export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean; noPetInstalled: boolean; activePetVoice: PetVoice | undefined }
export interface TestResult { ok: boolean; error?: string }

export interface PetSummary {
  id: string; displayName: string; description: string
  renderType: 'sprite' | 'live2d'
  /** sprite 恒 true;live2d 在 Phase 2 恒 false——渲染引擎(Phase 3/4)还不存在。 */
  renderReady: boolean
}
export type ImportReason =
  | 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists' | 'copy-failed'
  | 'path-traversal' | 'symlink-rejected' | 'forbidden-file-type'
  | 'dir-too-large' | 'too-many-files' | 'json-too-large'
  | 'texture-too-large' | 'too-many-textures' | 'missing-model-refs'
export type ImportResult =
  | { ok: true; pet: PetSummary; warnings?: string[] }
  | { ok: false; reason: ImportReason; message: string }

/** STAGE_IMPORT_PET 的返回形状:sprite 包一步提交(committed:true,与 ImportResult 的成功分支
 *  同形);live2d 包停在预览阶段(committed:false),附带渲染预览要用的 previewSource——
 *  复用现有 PetRenderSource,设置窗口拿到后可以直接喂给 Live2DPetRenderer.load()。 */
export type StageImportOutcome =
  | { ok: true; committed: true; pet: PetSummary; warnings?: string[] }
  | { ok: true; committed: false; stagingId: string; manifestId: string; displayName: string; warnings: string[]; previewSource: PetRenderSource }
  | { ok: false; reason: ImportReason; message: string }

export type CommitStagedImportResult = { ok: true; pet: PetSummary } | { ok: false; message: string }

export interface PetChatListItem {
  id: string
  displayName: string
  avatarDataUrl: string        // 主进程裁好的小头像;裁不出为 '',渲染层退回色块占位
  lastMessage?: string
  lastMessageTime?: number
  active: boolean
  /** false → 该宠物渲染引擎未就绪(live2d 包在 Phase 2 恒为 false),UI 应禁用点击。 */
  renderReady: boolean
}
export interface PetSwitchedPayload { petId: string; displayName: string }

export interface PetPreparePayload { requestId: string; source: PetRenderSource }
export interface PetPrepareResultPayload { requestId: string; ok: boolean; error?: string }
export interface PetCommitPayload { requestId: string }
export interface PetDiscardPayload { requestId: string }
export interface WindowVisibilityPayload { visible: boolean }

export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  setFirecrawlKey(key: string): Promise<boolean>
  confirmDesktopControl(): Promise<boolean>
  confirmBrowserControl(): Promise<boolean>
  confirmCdpMode(): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
  listPets(): Promise<PetSummary[]>
  /** 弹文件夹选择器 → 校验 → 复制到 .staging。sprite 包在这一步内部就直接提交完了
   *  (committed:true);live2d 包停在预览阶段(committed:false),需要接着调
   *  commitStagedImport()/discardStagedImport() 决定去留。用户取消选择返回 null。 */
  stageImportPet(): Promise<StageImportOutcome | null>
  commitStagedImport(stagingId: string, manifestId: string): Promise<CommitStagedImportResult>
  discardStagedImport(stagingId: string): Promise<void>
  relaunch(): void
}

export interface TodoApi {
  list(): Promise<TodoItem[]>
  add(input: { title: string; dueAt: number | null }): Promise<TodoItem[]>
  toggle(id: string): Promise<TodoItem[]>
  remove(id: string): Promise<TodoItem[]>
  onUpdate(cb: (items: TodoItem[]) => void): void
  onFired(cb: (id: string) => void): void
  openPanel(): void
}

export interface BubblePlace { tailSide: 'top' | 'bottom'; tailOffsetX: number }

export interface BubbleApi {
  onStream(cb: (text: string) => void): void
  onStatus(cb: (text: string) => void): void
  onDone(cb: () => void): void
  onError(cb: (message: string) => void): void
  onClear(cb: () => void): void
  onPlace(cb: (p: BubblePlace) => void): void
  onLine(cb: (text: string) => void): void
  /** 渲染层测量到内容自然高度后上报，主进程据此夹取范围并重新摆位 */
  reportSize(height: number): void
}

export interface VoiceRuntimeState { installed: boolean; installPath: string; gsvTtsLiteVersion?: string; device?: 'cuda' | 'cpu' }
export interface VoiceInstallProgress { stage: string; message: string }
export interface VoiceArchiveResult { ok: boolean; error?: string }
export interface VoicePcmChunk { audioBase64: string; sampleRate: number }

export interface VoiceApi {
  getState(): Promise<VoiceRuntimeState>
  pickInstallPath(): Promise<string | null>
  startInstall(): void
  onInstallProgress(cb: (p: VoiceInstallProgress) => void): void
  importArchive(): Promise<VoiceArchiveResult>
  exportArchive(): Promise<VoiceArchiveResult>
  onAudioChunk(cb: (c: VoicePcmChunk) => void): void
  onAudioDone(cb: () => void): void
  onAudioError(cb: (message: string) => void): void
  /** main→renderer 推送:立即停止渲染层已在播放的语音(用户显式取消/发送新消息触发),
   *  不携带任何 petBrain 状态含义——与 onAudioDone(正常播放完毕)、onAudioError(出错)语义不同 */
  onPlaybackStop(cb: () => void): void
  stop(): void
}

export interface GenieRuntimeState { installed: boolean; installPath: string; genieTtsVersion?: string }
export interface GenieInstallProgress { stage: string; message: string }

export interface GenieVoiceApi {
  getState(): Promise<GenieRuntimeState>
  pickInstallPath(): Promise<string | null>
  startInstall(): void
  onInstallProgress(cb: (p: GenieInstallProgress) => void): void
  importArchive(): Promise<VoiceArchiveResult>
  exportArchive(): Promise<VoiceArchiveResult>
}

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi; voiceApi: VoiceApi; genieVoiceApi: GenieVoiceApi }
}

export type { PetEvent, Bounds }
export type { TodoItem } from './todo'
export type { ReactionCategory } from './reactionPlanner'
