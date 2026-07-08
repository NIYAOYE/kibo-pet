import { desktopCapturer, type Display } from 'electron'
import { prepareImage, MAX_EDGE } from './imagePrep'
import { targetSize } from './imageResize'
import type { ImagePart } from '@shared/llm'

export interface FullScreenShot {
  image: ImagePart
  displayId: string
  originX: number
  originY: number
  physicalWidth: number
  physicalHeight: number
  imageWidth: number
  imageHeight: number
}

/**
 * 截取指定显示器整屏(不弹覆盖层),复用 MVP-07 的 prepareImage 降采样管线。
 * 同时算出「物理分辨率 ↔ 降采样后分辨率 ↔ 显示器物理原点」三组数据,
 * 交给 screenshotState 供后续 click_at 坐标换算 —— 三个数字必须与
 * prepareImage 实际产出的图像分辨率一致,因此用同一个 targetSize() 算,
 * 不在这里重新发明一套缩放逻辑。
 */
export async function captureFullScreen(display: Display): Promise<FullScreenShot> {
  const scale = display.scaleFactor
  const physicalWidth = Math.round(display.size.width * scale)
  const physicalHeight = Math.round(display.size.height * scale)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physicalWidth, height: physicalHeight } })
  const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!src) throw new Error('截屏失败:未取到屏幕画面')
  const dims = targetSize(physicalWidth, physicalHeight, MAX_EDGE)
  const image = prepareImage({ mimeType: 'image/jpeg', dataBase64: src.thumbnail.toJPEG(85).toString('base64') })
  return {
    image,
    displayId: String(src.display_id),
    originX: Math.round(display.bounds.x * scale),
    originY: Math.round(display.bounds.y * scale),
    physicalWidth,
    physicalHeight,
    imageWidth: dims.width,
    imageHeight: dims.height
  }
}
