import type { PetManifest } from './petPackage'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  QUIT: 'app:quit'
} as const

export interface LoadedPet {
  manifest: PetManifest
  /** data: URL of the spritesheet (webp), so the renderer needs no file access */
  spritesheetDataUrl: string
}

export interface MoveDelta { dx: number; dy: number }

export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  quit(): void
}

declare global {
  interface Window { petApi: PetApi }
}
