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

export type LayoutSource = Pick<StitchImage, 'id' | 'width' | 'height'> & {
  /** 拖动后的位移（布局像素）；画布尺寸只按自动排好的位置算，不跟着变 */
  offsetX?: number
  offsetY?: number
  layer?: number
}

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
 * - 拖动过的图片在自动位置上加位移；画布大小只按自动位置算，拖出画布的部分在绘制时被裁掉。
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
        x: Math.round((width - image.width) / 2) + (image.offsetX ?? 0),
        y: offset + (image.offsetY ?? 0),
        width: image.width,
        height: image.height,
        ...(image.layer === undefined ? {} : { layer: image.layer }),
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
      x: offset + (image.offsetX ?? 0),
      y: Math.round((height - image.height) / 2) + (image.offsetY ?? 0),
      width: image.width,
      height: image.height,
      ...(image.layer === undefined ? {} : { layer: image.layer }),
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
 * 绘制顺序（从下往上）：按图层从小到大，没设图层的按队列顺序排在最上面；同层按队列顺序。
 * 点选命中按它倒序找，最上面的先命中。
 */
export function paintOrder<T extends { layer?: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const la = a.item.layer ?? Number.POSITIVE_INFINITY
      const lb = b.item.layer ?? Number.POSITIVE_INFINITY
      return la === lb ? a.index - b.index : la - lb
    })
    .map((entry) => entry.item)
}

export type LayerAction = 'top' | 'up' | 'down' | 'bottom'

/**
 * 调整图层：order 是从下往上的编号顺序，返回挪动后的新顺序；已在顶 / 底挪不动时返回 null。
 * 「上移一层」「下移一层」与相邻的那张交换。
 */
export function moveLayer(order: readonly string[], id: string, action: LayerAction): string[] | null {
  const index = order.indexOf(id)
  if (index < 0) {
    return null
  }
  const last = order.length - 1
  const target =
    action === 'top' ? last : action === 'bottom' ? 0 : action === 'up' ? index + 1 : index - 1
  if (target < 0 || target > last || target === index) {
    return null
  }
  const next = [...order]
  next.splice(index, 1)
  next.splice(target, 0, id)
  return next
}

/** 拖动时至少留在画布里的边长（布局像素），整张拖出去就再也点不到了。 */
export const MIN_VISIBLE_SIDE = 24

/**
 * 限制拖动量：图片框（rect，与 bounds 同一坐标）平移 dx、dy 后，与画布 bounds 至少重叠 minVisible
 * （图片本身更小时按图片边长）。返回实际可用的平移量。
 */
export function clampDragDelta(
  rect: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  minVisible = MIN_VISIBLE_SIDE,
): { dx: number; dy: number } {
  const keepX = Math.min(minVisible, rect.width, bounds.width)
  const keepY = Math.min(minVisible, rect.height, bounds.height)
  const x = Math.min(bounds.width - keepX, Math.max(keepX - rect.width, rect.x + dx))
  const y = Math.min(bounds.height - keepY, Math.max(keepY - rect.height, rect.y + dy))
  return { dx: x - rect.x, dy: y - rect.y }
}

/** 画布尺寸下限与上限（布局像素） */
export const MIN_CANVAS_SIDE = 16
export const MAX_CANVAS_SIDE = 65_536

/**
 * 手动设定的拼接画布：宽高，以及原来的内容放在新画布的哪里（anchorX / anchorY：0 靠左 / 上，
 * 0.5 居中，1 靠右 / 下）。画布比内容大时空出来的地方按背景填充，小时超出的部分被裁掉。
 */
export interface CanvasSize {
  width: number
  height: number
  anchorX: 0 | 0.5 | 1
  anchorY: 0 | 0.5 | 1
}

export function clampCanvasSide(value: number): number {
  return Math.min(MAX_CANVAS_SIDE, Math.max(MIN_CANVAS_SIDE, Math.round(value)))
}

/** 按手动画布换算布局：画布换成给定宽高，所有图片按锚点整体平移。没有手动画布时原样返回。 */
export function applyCanvasSize<T extends { width: number; height: number; items: LayoutItem[] }>(
  layout: T,
  canvas: CanvasSize | null,
): T {
  if (!canvas || layout.items.length === 0) {
    return layout
  }
  const dx = Math.round((canvas.width - layout.width) * canvas.anchorX)
  const dy = Math.round((canvas.height - layout.height) * canvas.anchorY)
  return {
    ...layout,
    width: canvas.width,
    height: canvas.height,
    items: layout.items.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy })),
  }
}

export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}

/** 吸附结果：修正后的平移量，以及对齐上的参考线（布局坐标，竖线给 x、横线给 y） */
export interface SnapResult {
  dx: number
  dy: number
  guideX: number | null
  guideY: number | null
}

/**
 * 拖动吸附：移动中的图片（起点 rect 加 dx、dy）的左 / 中 / 右、上 / 中 / 下，
 * 靠近其他图片的边与中线、画布四边与中线不到 threshold 时贴上去：左边贴别人的右边（紧贴）、
 * 左边对左边（对齐）都算。两个方向各自找最近的一条。
 */
export function snapMove(
  rect: SnapRect,
  dx: number,
  dy: number,
  others: readonly SnapRect[],
  bounds: { width: number; height: number },
  threshold: number,
): SnapResult {
  const targetsX = [0, bounds.width / 2, bounds.width]
  const targetsY = [0, bounds.height / 2, bounds.height]
  for (const other of others) {
    targetsX.push(other.x, other.x + other.width / 2, other.x + other.width)
    targetsY.push(other.y, other.y + other.height / 2, other.y + other.height)
  }
  const pick = (start: number, size: number, delta: number, targets: number[]) => {
    const edges = [start + delta, start + delta + size / 2, start + delta + size]
    let best: { shift: number; line: number } | null = null
    for (const edge of edges) {
      for (const target of targets) {
        const shift = target - edge
        if (Math.abs(shift) <= threshold && (!best || Math.abs(shift) < Math.abs(best.shift))) {
          best = { shift, line: target }
        }
      }
    }
    return best
  }
  const snapX = pick(rect.x, rect.width, dx, targetsX)
  const snapY = pick(rect.y, rect.height, dy, targetsY)
  return {
    dx: dx + (snapX?.shift ?? 0),
    dy: dy + (snapY?.shift ?? 0),
    guideX: snapX?.line ?? null,
    guideY: snapY?.line ?? null,
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
