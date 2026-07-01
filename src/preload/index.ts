import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PetApi, type LoadedPet, type MoveDelta } from '@shared/ipc'

const api: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

contextBridge.exposeInMainWorld('petApi', api)
