import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi, type MediaApi, type OverlayApi, type ChatSendAttachment,
  type OverlayInit, type OverlayRect
} from '@shared/ipc'
import type { AppSettings, ProviderSettings } from '@shared/llm'

const petApi: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  toggleDialog: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  onPetEvent: (cb: (event: PetEvent) => void): void => {
    ipcRenderer.removeAllListeners(IPC.PET_EVENT)
    ipcRenderer.on(IPC.PET_EVENT, (_e, event: PetEvent) => cb(event))
  },
  quit: (): void => ipcRenderer.send(IPC.QUIT)
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
  close: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  openSettings: (): void => ipcRenderer.send(IPC.OPEN_SETTINGS)
}

const settingsApi: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (s: AppSettings) => ipcRenderer.invoke(IPC.SET_SETTINGS, s),
  setApiKey: (key: string) => ipcRenderer.invoke(IPC.SET_API_KEY, key),
  setSearchKey: (key: string) => ipcRenderer.invoke(IPC.SET_SEARCH_KEY, key),
  setEmbeddingKey: (key: string) => ipcRenderer.invoke(IPC.SET_EMBEDDING_KEY, key),
  openMemoryDir: (): void => ipcRenderer.send(IPC.OPEN_MEMORY_DIR),
  testConnection: (provider: ProviderSettings, key: string) => ipcRenderer.invoke(IPC.TEST_CONNECTION, { provider, key }),
  listPets: () => ipcRenderer.invoke(IPC.LIST_PETS),
  importPet: () => ipcRenderer.invoke(IPC.IMPORT_PET),
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

contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('chatApi', chatApi)
contextBridge.exposeInMainWorld('settingsApi', settingsApi)
contextBridge.exposeInMainWorld('mediaApi', mediaApi)
contextBridge.exposeInMainWorld('overlayApi', overlayApi)
