import type { LayoutItem, StitchDirection, StitchLayout } from './types'

export interface PreviewFit {
  width: number
  height: number
  scale: number
}

export interface PreviewOffset {
  x: number
  y: number
}

/**
 * 计算整张拼接图适应预览视口时的显示尺寸。
 * padding 是适应时四周留出的边距：视口铺满整个画布区域、内容可以画到边缘，
 * 但「适应窗口」时仍留出一圈空白，不让图片贴着画布边框。
 */
export function getPreviewFit(
  layout: StitchLayout,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0,
): PreviewFit {
  if (layout.width <= 0 || layout.height <= 0) {
    return { width: 0, height: 0, scale: 0 }
  }

  const width = Math.max(1, viewportWidth - padding * 2)
  const height = Math.max(1, viewportHeight - padding * 2)
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

/** 预览允许的最大缩放：至少保留 4 倍，并保证任意一张图都能撑满视口（扣除适应边距）。 */
export function getMaxPreviewZoom(
  layout: StitchLayout,
  viewportWidth: number,
  viewportHeight: number,
  minimum = 4,
  padding = 0,
): number {
  const fit = getPreviewFit(layout, viewportWidth, viewportHeight, padding)
  const fillWidth = viewportWidth - padding * 2
  const fillHeight = viewportHeight - padding * 2
  let maximum = Math.max(1, minimum)
  for (const item of layout.items) {
    maximum = Math.max(
      maximum,
      getImageFillZoom(item, fillWidth, fillHeight, fit.scale),
    )
  }
  return maximum
}

export interface KeepScaleInput {
  /** 改尺寸前「图片像素 → 屏幕像素」的比例（适应比例 × 缩放） */
  previousScale: number
  /** 改尺寸后整图的适应比例 */
  fitScale: number
  minZoom: number
  maxZoom: number
  offset: PreviewOffset
  direction: StitchDirection
  previousSize: { width: number; height: number }
  nextSize: { width: number; height: number }
}

/**
 * 空白页改尺寸后，让其他图片在屏幕上保持原来的大小与位置。
 *
 * - 缩放：按新的适应比例反算，使「图片像素 → 屏幕像素」比例不变（受最小、最大缩放限制）。
 * - 平移：内容在视口里居中，拼接方向上变长会让整图往回缩一半；把这一半补回去，
 *   空白页之前的图片就停在原处。交叉方向上图片本来就居中，不需要补。
 */
export function keepScaleAfterResize(input: KeepScaleInput): { zoom: number; offset: PreviewOffset } {
  if (input.fitScale <= 0 || input.previousScale <= 0) {
    return { zoom: 1, offset: input.offset }
  }
  const zoom = Math.min(input.maxZoom, Math.max(input.minZoom, input.previousScale / input.fitScale))
  const scale = input.fitScale * zoom
  if (input.direction === 'vertical') {
    const grow = input.nextSize.height - input.previousSize.height
    return { zoom, offset: { x: input.offset.x, y: input.offset.y + (grow * scale) / 2 } }
  }
  const grow = input.nextSize.width - input.previousSize.width
  return { zoom, offset: { x: input.offset.x + (grow * scale) / 2, y: input.offset.y } }
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
