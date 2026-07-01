import type { PetManifest } from './petPackage'
import type { PetEvent, Bounds } from './petBrain'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  QUIT: 'app:quit'
} as const

export interface LoadedPet {
  manifest: PetManifest
  /** data: URL of the spritesheet (webp), so the renderer needs no file access */
  spritesheetDataUrl: string
}

export interface MoveDelta { dx: number; dy: number }

export interface WindowBounds { workArea: Bounds; window: Bounds }

export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  /** Toggle click-through: when true, mouse events pass through to windows below. */
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  quit(): void
}

declare global {
  interface Window { petApi: PetApi }
}

export type { PetEvent, Bounds }
