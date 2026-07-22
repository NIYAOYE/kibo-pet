import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC, type PetApi, type ChatApi, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect, type TodoApi, type TodoItem,
  type BubbleApi, type BubblePlace, type ContextSignalKind,
  type VoiceApi, type VoiceInstallProgress, type VoicePcmChunk,
  type GenieVoiceApi, type GenieInstallProgress,
  type PetChatListItem, type PetSwitchedPayload, type Live2DTransformPatch,
  type PetPreparePayload, type PetCommitPayload, type PetDiscardPayload, type WindowVisibilityPayload
} from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'
import type { PetRenderSource } from '@shared/petPackage'

const petApi: PetApi = {
  getPet: (): Promise<PetRenderSource> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): Promise<WindowBounds> => ipcRenderer.invoke(IPC.MOVE_WINDOW, delta),
  dragStart: (): void => ipcRenderer.send(IPC.DRAG_START),
  dragEnd: (): void => ipcRenderer.send(IPC.DRAG_END),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  toggleDialog: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  onPetEvent: (cb: (event: PetEvent) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_EVENT)
    ipcRenderer.on(IPC.PET_EVENT, (_e, event: PetEvent) => cb(event))
  },
  petSpeak: (category): void => ipcRenderer.send(IPC.PET_SPEAK, category),
  onContextSignal: (cb: (kind: ContextSignalKind) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CONTEXT_SIGNAL)
    ipcRenderer.on(IPC.CONTEXT_SIGNAL, (_e, kind: ContextSignalKind) => cb(kind))
  },
  quit: (): void => ipcRenderer.send(IPC.QUIT),
  onPetPrepare: (cb: (payload: PetPreparePayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_PREPARE)
    ipcRenderer.on(IPC.PET_PREPARE, (_e, payload: PetPreparePayload) => cb(payload))
  },
  reportPrepareResult: (requestId: string, ok: boolean, error?: string): void =>
    ipcRenderer.send(IPC.PET_PREPARE_RESULT, { requestId, ok, error }),
  onPetCommit: (cb: (payload: PetCommitPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_COMMIT)
    ipcRenderer.on(IPC.PET_COMMIT, (_e, payload: PetCommitPayload) => cb(payload))
  },
  onPetDiscard: (cb: (payload: PetDiscardPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_DISCARD)
    ipcRenderer.on(IPC.PET_DISCARD, (_e, payload: PetDiscardPayload) => cb(payload))
  },
  onWindowVisibilityChanged: (cb: (payload: WindowVisibilityPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.WINDOW_VISIBILITY_CHANGED)
    ipcRenderer.on(IPC.WINDOW_VISIBILITY_CHANGED, (_e, payload: WindowVisibilityPayload) => cb(payload))
  },
  onMouseFocus: (cb: (payload: { x: number; y: number }) => void): void => {
    ipcRenderer.removeAllListeners(IPC.MOUSE_FOCUS)
    ipcRenderer.on(IPC.MOUSE_FOCUS, (_e, payload: { x: number; y: number }) => cb(payload))
  },
  updateLive2DTransform: (patch: Live2DTransformPatch): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_LIVE2D_TRANSFORM, patch)
}

const chatApi: ChatApi = {
  send: (payload: ChatSendPayload): void => ipcRenderer.send(IPC.CHAT_SEND, payload),
  onUpdate: (cb: (messages: ChatMessage[]) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_UPDATE)
    ipcRenderer.on(IPC.CHAT_UPDATE, (_e, messages: ChatMessage[]) => cb(messages))
  },
  onStream: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_STREAM)
    ipcRenderer.on(IPC.CHAT_STREAM, (_e, text: string) => cb(text))
  },
  onDone: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_DONE)
    ipcRenderer.on(IPC.CHAT_DONE, () => cb())
  },
  onError: (cb: (message: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_ERROR)
    ipcRenderer.on(IPC.CHAT_ERROR, (_e, message: string) => cb(message))
  },
  onStatus: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.CHAT_STATUS)
    ipcRenderer.on(IPC.CHAT_STATUS, (_e, text: string) => cb(text))
  },
  cancel: (): void => ipcRenderer.send(IPC.CANCEL_CHAT),
  setSize: (collapsed: boolean): void => ipcRenderer.send(IPC.DIALOG_SET_SIZE, collapsed),
  reportCollapsedHeight: (height: number): void => ipcRenderer.send(IPC.DIALOG_REPORT_COLLAPSED_HEIGHT, height),
  close: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  openSettings: (): void => ipcRenderer.send(IPC.OPEN_SETTINGS),
  listPetsForChat: (): Promise<PetChatListItem[]> => ipcRenderer.invoke(IPC.CHAT_LIST_PETS),
  switchPet: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.SWITCH_PET, id),
  onSwitched: (cb: (p: PetSwitchedPayload) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_SWITCHED)
    ipcRenderer.on(IPC.PET_SWITCHED, (_e, p: PetSwitchedPayload) => cb(p))
  }
}

const settingsApi: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (s: AppSettings) => ipcRenderer.invoke(IPC.SET_SETTINGS, s),
  setApiKey: (key: string) => ipcRenderer.invoke(IPC.SET_API_KEY, key),
  setSearchKey: (key: string) => ipcRenderer.invoke(IPC.SET_SEARCH_KEY, key),
  setEmbeddingKey: (key: string) => ipcRenderer.invoke(IPC.SET_EMBEDDING_KEY, key),
  setFirecrawlKey: (key: string) => ipcRenderer.invoke(IPC.SET_FIRECRAWL_KEY, key),
  confirmDesktopControl: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_DESKTOP_CONTROL),
  confirmBrowserControl: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_BROWSER_CONTROL),
  confirmCdpMode: (): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIRM_CDP_MODE),
  openMemoryDir: (): void => ipcRenderer.send(IPC.OPEN_MEMORY_DIR),
  testConnection: (provider: ProviderSettings, key: string) => ipcRenderer.invoke(IPC.TEST_CONNECTION, { provider, key }),
  listPets: () => ipcRenderer.invoke(IPC.LIST_PETS),
  stageImportPet: () => ipcRenderer.invoke(IPC.STAGE_IMPORT_PET),
  commitStagedImport: (stagingId: string, manifestId: string) => ipcRenderer.invoke(IPC.COMMIT_STAGED_IMPORT, { stagingId, manifestId }),
  discardStagedImport: (stagingId: string) => ipcRenderer.invoke(IPC.DISCARD_STAGED_IMPORT, { stagingId }),
  relaunch: (): void => ipcRenderer.send(IPC.RELAUNCH_APP)
}

const mediaApi: MediaApi = {
  pickImage: (): Promise<ChatSendAttachment[]> => ipcRenderer.invoke(IPC.MEDIA_PICK_IMAGE),
  captureRegion: (): Promise<ChatSendAttachment | null> => ipcRenderer.invoke(IPC.MEDIA_CAPTURE_REGION)
}

const overlayApi: OverlayApi = {
  onInit: (cb: (d: OverlayInit) => void): void => {
    ipcRenderer.removeAllListeners(IPC.OVERLAY_INIT)
    ipcRenderer.on(IPC.OVERLAY_INIT, (_e, d: OverlayInit) => cb(d))
  },
  submit: (rect: OverlayRect): void => ipcRenderer.send(IPC.OVERLAY_SUBMIT, rect),
  cancel: (): void => ipcRenderer.send(IPC.OVERLAY_CANCEL)
}

const todoApi: TodoApi = {
  list: (): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.LIST_TODOS),
  add: (input): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.ADD_TODO, input),
  toggle: (id: string): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.TOGGLE_TODO, id),
  remove: (id: string): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.REMOVE_TODO, id),
  onUpdate: (cb: (items: TodoItem[]) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TODO_UPDATE)
    ipcRenderer.on(IPC.TODO_UPDATE, (_e, items: TodoItem[]) => cb(items))
  },
  onFired: (cb: (id: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.TODO_FIRED)
    ipcRenderer.on(IPC.TODO_FIRED, (_e, id: string) => cb(id))
  },
  openPanel: (): void => ipcRenderer.send(IPC.OPEN_TODO_PANEL)
}

const bubbleApi: BubbleApi = {
  onStream: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_STREAM)
    ipcRenderer.on(IPC.BUBBLE_STREAM, (_e, text: string) => cb(text))
  },
  onStatus: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_STATUS)
    ipcRenderer.on(IPC.BUBBLE_STATUS, (_e, text: string) => cb(text))
  },
  onDone: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_DONE)
    ipcRenderer.on(IPC.BUBBLE_DONE, () => cb())
  },
  onError: (cb: (message: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_ERROR)
    ipcRenderer.on(IPC.BUBBLE_ERROR, (_e, message: string) => cb(message))
  },
  onClear: (cb: () => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_CLEAR)
    ipcRenderer.on(IPC.BUBBLE_CLEAR, () => cb())
  },
  onPlace: (cb: (p: BubblePlace) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_PLACE)
    ipcRenderer.on(IPC.BUBBLE_PLACE, (_e, p: BubblePlace) => cb(p))
  },
  onLine: (cb: (text: string) => void): void => {
    ipcRenderer.removeAllListeners(IPC.BUBBLE_LINE)
    ipcRenderer.on(IPC.BUBBLE_LINE, (_e, text: string) => cb(text))
  },
  reportSize: (height: number): void => ipcRenderer.send(IPC.BUBBLE_RESIZE, height)
}

const voiceApi = {
  getState: () => ipcRenderer.invoke(IPC.VOICE_GET_STATE),
  pickInstallPath: () => ipcRenderer.invoke(IPC.VOICE_PICK_INSTALL_PATH),
  startInstall: () => ipcRenderer.send(IPC.VOICE_START_INSTALL),
  onInstallProgress: (cb: (p: VoiceInstallProgress) => void) => {
    ipcRenderer.removeAllListeners(IPC.VOICE_INSTALL_PROGRESS)
    ipcRenderer.on(IPC.VOICE_INSTALL_PROGRESS, (_e, p) => cb(p))
  },
  importArchive: () => ipcRenderer.invoke(IPC.VOICE_IMPORT_ARCHIVE),
  exportArchive: () => ipcRenderer.invoke(IPC.VOICE_EXPORT_ARCHIVE),
  onAudioChunk: (cb: (c: VoicePcmChunk) => void) => {
    ipcRenderer.removeAllListeners(IPC.VOICE_AUDIO_CHUNK)
    ipcRenderer.on(IPC.VOICE_AUDIO_CHUNK, (_e, c) => cb(c))
  },
  onAudioDone: (cb: () => void) => {
    ipcRenderer.removeAllListeners(IPC.VOICE_AUDIO_DONE)
    ipcRenderer.on(IPC.VOICE_AUDIO_DONE, () => cb())
  },
  onAudioError: (cb: (message: string) => void) => {
    ipcRenderer.removeAllListeners(IPC.VOICE_AUDIO_ERROR)
    ipcRenderer.on(IPC.VOICE_AUDIO_ERROR, (_e, m) => cb(m))
  },
  onPlaybackStop: (cb: () => void) => {
    ipcRenderer.removeAllListeners(IPC.VOICE_PLAYBACK_STOP)
    ipcRenderer.on(IPC.VOICE_PLAYBACK_STOP, () => cb())
  },
  stop: () => ipcRenderer.send(IPC.VOICE_STOP)
} satisfies VoiceApi

const genieVoiceApi = {
  getState: () => ipcRenderer.invoke(IPC.GENIE_GET_STATE),
  pickInstallPath: () => ipcRenderer.invoke(IPC.GENIE_PICK_INSTALL_PATH),
  startInstall: () => ipcRenderer.send(IPC.GENIE_START_INSTALL),
  onInstallProgress: (cb: (p: GenieInstallProgress) => void) => {
    ipcRenderer.removeAllListeners(IPC.GENIE_INSTALL_PROGRESS)
    ipcRenderer.on(IPC.GENIE_INSTALL_PROGRESS, (_e, p) => cb(p))
  },
  importArchive: () => ipcRenderer.invoke(IPC.GENIE_IMPORT_ARCHIVE),
  exportArchive: () => ipcRenderer.invoke(IPC.GENIE_EXPORT_ARCHIVE)
} satisfies GenieVoiceApi

contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('chatApi', chatApi)
contextBridge.exposeInMainWorld('settingsApi', settingsApi)
contextBridge.exposeInMainWorld('mediaApi', mediaApi)
contextBridge.exposeInMainWorld('overlayApi', overlayApi)
contextBridge.exposeInMainWorld('todoApi', todoApi)
contextBridge.exposeInMainWorld('bubbleApi', bubbleApi)
contextBridge.exposeInMainWorld('voiceApi', voiceApi)
contextBridge.exposeInMainWorld('genieVoiceApi', genieVoiceApi)
