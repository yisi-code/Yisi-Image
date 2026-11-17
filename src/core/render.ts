import type { StitchImage, StitchLayout } from './types'

export interface RenderOptions {
  scale?: number
  background?: string | null
}

export function renderStitch(
  target: HTMLCanvasElement,
  layout: StitchLayout,
  images: readonly StitchImage[],
  options: RenderOptions = {},
): HTMLCanvasElement {
  const scale = options.scale ?? 1
  const background = options.background === undefined ? '#ffffff' : options.background
  const width = Math.max(1, Math.round(layout.width * scale))
  const height = Math.max(1, Math.round(layout.height * scale))

  target.width = width
  target.height = height

  const context = target.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D')
  }

  context.clearRect(0, 0, width, height)
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
  }

  if (scale !== 1) {
    context.setTransform(scale, 0, 0, scale, 0, 0)
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const imageById = new Map(images.map((image) => [image.id, image]))
  for (const item of layout.items) {
    const image = imageById.get(item.id)
    if (!image) {
      continue
    }
    context.drawImage(image.element, item.x, item.y, item.width, item.height)
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  return target
}

export class UnsupportedExportFormatError extends Error {
  constructor() {
    super('当前浏览器不支持该图片格式')
    this.name = 'UnsupportedExportFormatError'
  }
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('浏览器没有返回导出文件'))
          return
        }
        // 浏览器遇到不支持的格式时会静默回退成 PNG，不能把扩展名写错。
        if (blob.type !== mime) {
          reject(new UnsupportedExportFormatError())
          return
        }
        resolve(blob)
      },
      mime,
      quality,
    )
  })
}
