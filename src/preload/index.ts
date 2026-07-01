import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC, type PetApi, type ChatApi, type LoadedPet, type MoveDelta,
  type WindowBounds, type ChatMessage, type ChatSendPayload, type PetEvent
} from '@shared/ipc'

const petApi: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  toggleDialog: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG),
  onPetEvent: (cb: (event: PetEvent) => void): void => {
    ipcRenderer.on(IPC.PET_EVENT, (_e, event: PetEvent) => cb(event))
  },
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

const chatApi: ChatApi = {
  send: (payload: ChatSendPayload): void => ipcRenderer.send(IPC.CHAT_SEND, payload),
  onUpdate: (cb: (messages: ChatMessage[]) => void): void => {
    ipcRenderer.on(IPC.CHAT_UPDATE, (_e, messages: ChatMessage[]) => cb(messages))
  },
  setSize: (collapsed: boolean): void => ipcRenderer.send(IPC.DIALOG_SET_SIZE, collapsed),
  close: (): void => ipcRenderer.send(IPC.TOGGLE_DIALOG)
}

contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('chatApi', chatApi)
