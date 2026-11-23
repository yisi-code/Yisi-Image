import { drawAnnotations } from './annotations'
import type { DrawAnnotationsOptions } from './annotations'
import { getPreviewFit } from './preview'
import type { PreviewOffset } from './preview'
import { DEFAULT_BACKGROUND, TRANSPARENT_BACKGROUND } from './settings'
import type { StitchBackground } from './settings'
import type { StitchImage, StitchLayout } from './types'

export interface RenderOptions {
  scale?: number
  /** 画布底色；null 不填充，保留透明 */
  background?: string | null
}

export interface ViewportRenderOptions {
  viewportWidth: number
  viewportHeight: number
  fitScale?: number
  zoom: number
  offset: PreviewOffset
  dpr?: number
  /** 拼接背景；透明时在内容区画棋盘格，方便看出哪里是透明的 */
  background?: StitchBackground
  /** 正在编辑、由输入框代为显示的文字标注 */
  hiddenAnnotationId?: string | null
}

/** 透明背景在预览里的棋盘格，格子按屏幕像素算，缩放时大小不变。 */
const CHECKER_CELL = 8
const CHECKER_LIGHT = '#ffffff'
const CHECKER_DARK = '#e3e8e6'
let checkerTile: HTMLCanvasElement | null = null

function getCheckerPattern(context: CanvasRenderingContext2D): CanvasPattern | string {
  if (!checkerTile) {
    const tile = document.createElement('canvas')
    tile.width = CHECKER_CELL * 2
    tile.height = CHECKER_CELL * 2
    const tileContext = tile.getContext('2d')
    if (!tileContext) {
      return CHECKER_LIGHT
    }
    tileContext.fillStyle = CHECKER_LIGHT
    tileContext.fillRect(0, 0, tile.width, tile.height)
    tileContext.fillStyle = CHECKER_DARK
    tileContext.fillRect(CHECKER_CELL, 0, CHECKER_CELL, CHECKER_CELL)
    tileContext.fillRect(0, CHECKER_CELL, CHECKER_CELL, CHECKER_CELL)
    checkerTile = tile
  }
  return context.createPattern(checkerTile, 'repeat') ?? CHECKER_LIGHT
}

function paintStitchImage(
  context: CanvasRenderingContext2D,
  image: StitchImage,
  x: number,
  y: number,
  width: number,
  height: number,
  annotationOptions: DrawAnnotationsOptions = {},
): void {
  if (image.kind === 'blank') {
    context.fillStyle = image.backgroundColor ?? '#ffffff'
    context.fillRect(x, y, width, height)
  } else if (image.element) {
    context.drawImage(image.element, x, y, width, height)
  }

  context.save()
  context.translate(x, y)
  context.scale(width / image.width, height / image.height)
  drawAnnotations(context, image, annotationOptions)
  context.restore()
}

export function renderStitch(
  target: HTMLCanvasElement,
  layout: StitchLayout,
  images: readonly StitchImage[],
  options: RenderOptions = {},
): HTMLCanvasElement {
  const scale = options.scale ?? 1
  const background = options.background === undefined ? DEFAULT_BACKGROUND : options.background
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
    paintStitchImage(context, image, item.x, item.y, item.width, item.height)
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  return target
}

/**
 * 只绘制预览视口内可见的那一块拼接图。
 *
 * 全尺寸画布在图片很多、缩放很大时会被浏览器的单边/面积上限压回低分辨率；
 * 这里让画布始终等于视口大小，再按缩放和平移换算可见区域，因此图片再多也能保持清晰。
 */
export function renderStitchView(
  target: HTMLCanvasElement,
  layout: StitchLayout,
  images: readonly StitchImage[],
  options: ViewportRenderOptions,
): HTMLCanvasElement {
  if (layout.width <= 0 || layout.height <= 0) {
    target.width = 1
    target.height = 1
    return target
  }

  const viewportWidth = Math.max(1, options.viewportWidth)
  const viewportHeight = Math.max(1, options.viewportHeight)
  const fit =
    options.fitScale === undefined
      ? getPreviewFit(layout, viewportWidth, viewportHeight).scale
      : options.fitScale
  const zoom = Math.max(0.01, options.zoom)
  const contentWidth = Math.max(1, layout.width * fit * zoom)
  const contentHeight = Math.max(1, layout.height * fit * zoom)
  const left = (viewportWidth - contentWidth) / 2 + options.offset.x
  const top = (viewportHeight - contentHeight) / 2 + options.offset.y

  const dpr = Math.max(1, options.dpr ?? 1)
  const backingScale = Math.max(
    0.01,
    Math.min(
      dpr,
      4096 / Math.max(viewportWidth, viewportHeight),
      Math.sqrt(16_000_000 / (viewportWidth * viewportHeight)),
    ),
  )
  target.width = Math.max(1, Math.round(viewportWidth * backingScale))
  target.height = Math.max(1, Math.round(viewportHeight * backingScale))

  const context = target.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D')
  }

  context.setTransform(backingScale, 0, 0, backingScale, 0, 0)
  context.clearRect(0, 0, viewportWidth, viewportHeight)

  // 图片没有铺满视口时给画布加一层轻阴影；放大到边缘超出视口时不再计算阴影。
  const contentOverflows = contentWidth > viewportWidth + 40 || contentHeight > viewportHeight + 40
  context.save()
  if (!contentOverflows) {
    context.shadowColor = 'rgba(19, 32, 28, 0.18)'
    context.shadowBlur = 28
    context.shadowOffsetY = 10
  }
  const background = options.background ?? DEFAULT_BACKGROUND
  context.fillStyle =
    background === TRANSPARENT_BACKGROUND ? getCheckerPattern(context) : background
  context.fillRect(left, top, contentWidth, contentHeight)
  context.restore()

  context.save()
  context.translate(left, top)
  context.scale(contentWidth / layout.width, contentHeight / layout.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const imageById = new Map(images.map((image) => [image.id, image]))
  for (const item of layout.items) {
    const image = imageById.get(item.id)
    if (!image) {
      continue
    }
    paintStitchImage(context, image, item.x, item.y, item.width, item.height, {
      isPreview: true,
      hiddenId: options.hiddenAnnotationId,
    })
  }
  context.restore()

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
