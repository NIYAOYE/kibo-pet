import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePetManifest } from '@shared/petPackage'
import type { LoadedPet } from '@shared/ipc'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

export async function loadPet(petDir: string): Promise<LoadedPet> {
  const manifestRaw = await readFile(join(petDir, 'pet.json'), 'utf-8')
  const manifest = parsePetManifest(JSON.parse(manifestRaw))
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { manifest, spritesheetDataUrl }
}
