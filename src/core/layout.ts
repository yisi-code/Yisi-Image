import type { LayoutItem, StitchDirection, StitchImage, StitchLayout } from './types'

export const MIN_GAP = 0
export const MAX_GAP = 200
export const DEFAULT_GAP = 24

export const MAX_EXPORT_SIDE = 16_384
export const MAX_EXPORT_AREA = 100_000_000
export const LARGE_OUTPUT_AREA = 60_000_000

export type LayoutSource = Pick<StitchImage, 'id' | 'width' | 'height'>

export interface OutputSizeCheck {
  ok: boolean
  isLarge: boolean
  reason: string
}

export function clampGap(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GAP
  }
  return Math.min(MAX_GAP, Math.max(MIN_GAP, Math.round(value)))
}

/**
 * 按原始像素计算拼接布局。
 *
 * - 纵向：画布宽度取最宽图，窄图水平居中。
 * - 横向：画布高度取最高图，矮图垂直居中。
 * - 图片本身不缩放，间距只加在相邻两张图之间。
 */
export function calculateStitchLayout(
  images: readonly LayoutSource[],
  direction: StitchDirection,
  gap: number,
): StitchLayout {
  const safeGap = clampGap(gap)

  if (images.length === 0) {
    return {
      direction,
      gap: safeGap,
      width: 0,
      height: 0,
      items: [],
    }
  }

  const items: LayoutItem[] = []
  let offset = 0

  if (direction === 'vertical') {
    const width = Math.max(...images.map((image) => image.width))

    for (const image of images) {
      items.push({
        id: image.id,
        x: Math.round((width - image.width) / 2),
        y: offset,
        width: image.width,
        height: image.height,
      })
      offset += image.height + safeGap
    }

    return {
      direction,
      gap: safeGap,
      width,
      height: offset - safeGap,
      items,
    }
  }

  const height = Math.max(...images.map((image) => image.height))

  for (const image of images) {
    items.push({
      id: image.id,
      x: offset,
      y: Math.round((height - image.height) / 2),
      width: image.width,
      height: image.height,
    })
    offset += image.width + safeGap
  }

  return {
    direction,
    gap: safeGap,
    width: offset - safeGap,
    height,
    items,
  }
}

export function inspectOutputSize(width: number, height: number): OutputSizeCheck {
  if (width <= 0 || height <= 0) {
    return {
      ok: false,
      isLarge: false,
      reason: '还没有可导出的图片',
    }
  }

  if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE) {
    const side = width > MAX_EXPORT_SIDE ? `宽 ${width} px` : `高 ${height} px`
    return {
      ok: false,
      isLarge: false,
      reason: `拼接后${side}，超过浏览器单边 ${MAX_EXPORT_SIDE} px 的导出上限`,
    }
  }

  const area = width * height
  if (area > MAX_EXPORT_AREA) {
    return {
      ok: false,
      isLarge: true,
      reason: `拼接后约 ${Math.round(area / 1_000_000)} 百万像素，超过浏览器可稳定导出的 1 亿像素上限`,
    }
  }

  return {
    ok: true,
    isLarge: area >= LARGE_OUTPUT_AREA,
    reason: '',
  }
}
