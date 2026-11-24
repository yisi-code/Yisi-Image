import type { ExportFormat } from './exportFormats'
import type { LayoutItem, StitchDirection, StitchImage, StitchLayout } from './types'

export const MIN_GAP = 0
export const MAX_GAP = 200
export const DEFAULT_GAP = 24

/** 一张画布直接画、直接编码的安全尺寸；超过时 PNG 改为分块编码，JPG / WebP 用浏览器硬上限。 */
export const CANVAS_SAFE_SIDE = 16_384
export const CANVAS_SAFE_AREA = 100_000_000
/** Chromium 画布的硬上限：单边 32,767 px、面积 2^28 像素 */
export const CANVAS_MAX_SIDE = 32_767
export const CANVAS_MAX_AREA = 268_435_456
/** WebP 格式本身单边最多 16,383 px */
export const WEBP_MAX_SIDE = 16_383
/** PNG 规范的单边上限（2^31 − 1） */
export const PNG_MAX_SIDE = 2_147_483_647
export const LARGE_OUTPUT_AREA = 60_000_000

export type LayoutSource = Pick<StitchImage, 'id' | 'width' | 'height'>

export interface OutputSizeCheck {
  ok: boolean
  isLarge: boolean
  reason: string
  /** canvas：整张画布编码；strips：PNG 按行带分块编码，不受画布上限 */
  mode: 'canvas' | 'strips'
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

/**
 * 这个尺寸能不能导出、怎么导出。不给格式时按 PNG（最宽松）判断，用于拼接工作区的状态提示。
 * - 画布安全范围内：整张画布编码；
 * - PNG 超出：按行带分块编码，只受 PNG 规范限制；
 * - JPG 超出画布硬上限、WebP 超出格式上限：不能导出，提示改用 PNG。
 */
export function inspectOutputSize(
  width: number,
  height: number,
  format: ExportFormat = 'png',
): OutputSizeCheck {
  if (width <= 0 || height <= 0) {
    return { ok: false, isLarge: false, reason: '还没有可导出的图片', mode: 'canvas' }
  }
  const area = width * height
  const label = format === 'webp' ? 'WebP' : 'JPG'
  const maxSide = format === 'webp' ? WEBP_MAX_SIDE : CANVAS_MAX_SIDE
  // WebP 的格式上限（16,383）比画布安全档还小一点，先判断。
  const overFormatSide = format !== 'png' && (width > maxSide || height > maxSide)
  const withinSafe = width <= CANVAS_SAFE_SIDE && height <= CANVAS_SAFE_SIDE && area <= CANVAS_SAFE_AREA
  if (withinSafe && !overFormatSide) {
    return { ok: true, isLarge: area >= LARGE_OUTPUT_AREA, reason: '', mode: 'canvas' }
  }
  if (format === 'png') {
    if (width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) {
      return { ok: false, isLarge: true, reason: '超过 PNG 格式的尺寸上限', mode: 'strips' }
    }
    return { ok: true, isLarge: true, reason: '', mode: 'strips' }
  }
  if (overFormatSide) {
    const side = width > maxSide ? `宽 ${width} px` : `高 ${height} px`
    return {
      ok: false,
      isLarge: true,
      reason: `${side}，超过 ${label} 单边 ${maxSide.toLocaleString('en-US')} px 的上限；改用 PNG 可以导出`,
      mode: 'canvas',
    }
  }
  if (area > CANVAS_MAX_AREA) {
    return {
      ok: false,
      isLarge: true,
      reason: `约 ${Math.round(area / 1_000_000)} 百万像素，超过 ${label} 可导出的 ${Math.round(CANVAS_MAX_AREA / 1_000_000)} 百万像素；改用 PNG 可以导出`,
      mode: 'canvas',
    }
  }
  return { ok: true, isLarge: true, reason: '', mode: 'canvas' }
}
