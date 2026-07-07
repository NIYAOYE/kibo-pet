import type { PetManifest } from './petPackage'
import type { PetEvent, Bounds } from './petBrain'
import type { AppSettings, ProviderSettings } from './llm'
import type { TodoItem } from './todo'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
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
  OPEN_TODO_PANEL: 'todos:open-panel'
} as const

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
  moveWindow(delta: MoveDelta): void
  /** Toggle click-through: when true, mouse events pass through to windows below. */
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  toggleDialog(): void
  onPetEvent(cb: (event: PetEvent) => void): void
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

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi; settingsApi: SettingsApi; mediaApi: MediaApi; overlayApi: OverlayApi; todoApi: TodoApi }
}

export type { PetEvent, Bounds }
export type { TodoItem } from './todo'
