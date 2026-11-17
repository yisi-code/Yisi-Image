import type { LayoutItem, StitchLayout } from './types'

export interface PreviewFit {
  width: number
  height: number
  scale: number
}

export interface PreviewOffset {
  x: number
  y: number
}

/** 计算整张拼接图适应预览视口时的显示尺寸。 */
export function getPreviewFit(
  layout: StitchLayout,
  viewportWidth: number,
  viewportHeight: number,
): PreviewFit {
  if (layout.width <= 0 || layout.height <= 0) {
    return { width: 0, height: 0, scale: 0 }
  }

  const width = Math.max(1, viewportWidth)
  const height = Math.max(1, viewportHeight)
  const scale = Math.min(1, width / layout.width, height / layout.height)
  return {
    width: layout.width * scale,
    height: layout.height * scale,
    scale,
  }
}

/** 单张图片完整占满预览视口所需的缩放倍数。 */
export function getImageFillZoom(
  item: LayoutItem,
  viewportWidth: number,
  viewportHeight: number,
  fitScale: number,
): number {
  const imageWidth = item.width * fitScale
  const imageHeight = item.height * fitScale
  if (imageWidth <= 0 || imageHeight <= 0) {
    return 1
  }

  return Math.max(
    1,
    Math.min(Math.max(1, viewportWidth) / imageWidth, Math.max(1, viewportHeight) / imageHeight),
  )
}

/** 预览允许的最大缩放：至少保留 4 倍，并保证任意一张图都能撑满视口。 */
export function getMaxPreviewZoom(
  layout: StitchLayout,
  viewportWidth: number,
  viewportHeight: number,
  minimum = 4,
): number {
  const fit = getPreviewFit(layout, viewportWidth, viewportHeight)
  let maximum = Math.max(1, minimum)
  for (const item of layout.items) {
    maximum = Math.max(
      maximum,
      getImageFillZoom(item, viewportWidth, viewportHeight, fit.scale),
    )
  }
  return maximum
}

/** 把某张图片的中心对齐到预览视口中心所需的偏移。 */
export function getFocusOffset(
  item: LayoutItem,
  layout: StitchLayout,
  fitScale: number,
  zoom: number,
): PreviewOffset {
  const scale = fitScale * zoom
  const contentWidth = layout.width * scale
  const contentHeight = layout.height * scale
  const imageCenterX = (item.x + item.width / 2) * scale
  const imageCenterY = (item.y + item.height / 2) * scale
  return {
    x: contentWidth / 2 - imageCenterX,
    y: contentHeight / 2 - imageCenterY,
  }
}

/** 限制平移范围，避免把图片拖出视口后留下大片空白。 */
export function clampPreviewOffset(
  offset: PreviewOffset,
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): PreviewOffset {
  const maxX = Math.max(0, (contentWidth - viewportWidth) / 2)
  const maxY = Math.max(0, (contentHeight - viewportHeight) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  }
}
