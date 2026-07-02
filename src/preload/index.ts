import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent,
  type SettingsApi
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
  testConnection: (provider: ProviderSettings, key: string) => ipcRenderer.invoke(IPC.TEST_CONNECTION, { provider, key })
}

contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('chatApi', chatApi)
contextBridge.exposeInMainWorld('settingsApi', settingsApi)
