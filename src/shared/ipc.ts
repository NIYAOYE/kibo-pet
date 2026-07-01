import type { PetManifest } from './petPackage'
import type { PetEvent, Bounds } from './petBrain'

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
  QUIT: 'app:quit'
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

export interface ChatAttachment { kind: 'image' }
export interface ChatMessage { role: 'user' | 'pet'; text: string; attachments?: ChatAttachment[] }
export interface ChatSendPayload { text: string; attachments?: ChatAttachment[] }

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
  setSize(collapsed: boolean): void
  close(): void
}

declare global {
  interface Window { petApi: PetApi; chatApi: ChatApi }
}

export type { PetEvent, Bounds }
