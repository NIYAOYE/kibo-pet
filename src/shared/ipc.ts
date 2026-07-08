import type { PetManifest } from './petPackage'
import type { PetEvent, Bounds } from './petBrain'
import type { AppSettings, ProviderSettings } from './llm'
import type { TodoItem } from './todo'
import type { ReactionCategory } from './reactionPlanner'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  DRAG_START: 'window:drag-start',
  DRAG_END: 'window:drag-end',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  TOGGLE_DIALOG: 'dialog:toggle',
  DIALOG_SET_SIZE: 'dialog:set-size',
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
  OPEN_MEMORY_DIR: 'settings:open-memory-dir',
  MEDIA_PICK_IMAGE: 'media:pick-image',
  MEDIA_CAPTURE_REGION: 'media:capture-region',
  OVERLAY_INIT: 'overlay:init',
  OVERLAY_SUBMIT: 'overlay:submit',
  OVERLAY_CANCEL: 'overlay:cancel',
  LIST_PETS: 'pets:list',
  IMPORT_PET: 'pets:import',
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
  CONTEXT_SIGNAL: 'context:signal'
} as const

/** 主进程情境信号(main→renderer 推送):AFK 离开 / 久坐提醒，均为一次性边沿事件 */
export type ContextSignalKind = 'afk_leave' | 'break_reminder'

export interface LoadedPet {
  manifest: PetManifest
  /** data: URL of the spritesheet (webp), so the renderer needs no file access */
  spritesheetDataUrl: string
}

/** clamp:true keeps the window inside the display work area (autonomous walk);
 *  omitted/false lets it move freely (manual drag), matching MVP-01. */
export interface MoveDelta { dx: number; dy: number; clamp?: boolean }

export interface WindowBounds { workArea: Bounds; window: Bounds }

/** 持久化/展示用:仅标记"这轮有图",绝不携带字节 */
export interface ChatAttachment { kind: 'image' }
/** 发送用(瞬态):携带降采样后的图像字节,不落盘 */
export interface ChatSendAttachment { kind: 'image'; mimeType: string; dataBase64: string }
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[] }
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

export interface PetApi {
  getPet(): Promise<LoadedPet>
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
  close(): void
  openSettings(): void
}

export interface SettingsSnapshot { settings: AppSettings; hasKey: boolean; hasSearchKey: boolean; hasEmbeddingKey: boolean; hasFirecrawlKey: boolean }
export interface TestResult { ok: boolean; error?: string }

export interface PetSummary { id: string; displayName: string; description: string }
export type ImportReason = 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists' | 'copy-failed'
export type ImportResult =
  | { ok: true; pet: PetSummary }
  | { ok: false; reason: ImportReason; message: string }

export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>
  setSettings(settings: AppSettings): Promise<void>
  setApiKey(key: string): Promise<boolean>
  setSearchKey(key: string): Promise<boolean>
  setEmbeddingKey(key: string): Promise<boolean>
  setFirecrawlKey(key: string): Promise<boolean>
  openMemoryDir(): void
  testConnection(provider: ProviderSettings, key: string): Promise<TestResult>
  listPets(): Promise<PetSummary[]>
  importPet(): Promise<ImportResult | null>
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

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi; bubbleApi: BubbleApi }
}

export type { PetEvent, Bounds }
export type { TodoItem } from './todo'
export type { ReactionCategory } from './reactionPlanner'
