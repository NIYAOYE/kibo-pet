import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePetManifest, parseLive2DManifest, isLive2DManifestRaw, type PetRenderSource } from '@shared/petPackage'

export function petsDir(appRoot: string): string {
  return join(appRoot, 'pets')
}

export async function loadPet(petDir: string): Promise<PetRenderSource> {
  const manifestRaw = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
  if (isLive2DManifestRaw(manifestRaw)) {
    const manifest = parseLive2DManifest(manifestRaw)
    return { type: 'live2d', manifest }
  }
  const manifest = parsePetManifest(manifestRaw)
  const sheetBytes = await readFile(join(petDir, manifest.spritesheetPath))
  const spritesheetDataUrl = `data:image/webp;base64,${sheetBytes.toString('base64')}`
  return { type: 'sprite', manifest, spritesheetDataUrl }
}
