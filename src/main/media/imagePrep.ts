import { nativeImage } from 'electron'
import type { ImagePart } from '@shared/llm'
import { targetSize } from './imageResize'

export const MAX_EDGE = 1568

/**
 * 用 Electron 内置 nativeImage 解码原图 → 降采样(最长边 ≤ MAX_EDGE)→ 重编码 base64。
 * png/gif 输出 PNG(保透明);其余输出 JPEG。幂等:对已合规图再跑一次≈原样重编码。
 * 该模块 import electron,不可被 Vitest 直接 import(靠真机验收)。
 */
export function prepareImage(a: { mimeType: string; dataBase64: string }, maxEdge = MAX_EDGE): ImagePart {
  const buf = Buffer.from(a.dataBase64, 'base64')
  let img = nativeImage.createFromBuffer(buf)
  const { width, height } = img.getSize()
  const t = targetSize(width, height, maxEdge)
  if (t.width !== width || t.height !== height) img = img.resize({ width: t.width, height: t.height, quality: 'good' })
  const keepPng = a.mimeType === 'image/png' || a.mimeType === 'image/gif'
  const out = keepPng ? img.toPNG() : img.toJPEG(80)
  return { mimeType: keepPng ? 'image/png' : 'image/jpeg', dataBase64: out.toString('base64') }
}
