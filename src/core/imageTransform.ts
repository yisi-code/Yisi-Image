import type { StitchImage } from './types'

/**
 * 图片的缩放与裁剪（不改原图文件，可随时还原）。
 *
 * 一张图的变换只记两件事：裁剪区域 crop（原图像素坐标）与这块区域显示 / 导出的大小 width × height。
 * 没有变换时 crop 是整张原图、大小等于原图。标注、修瑕都存在原图坐标里，
 * 绘制和指针换算时按「原图 → 显示」的比例换算，所以缩放、裁剪后它们跟着画面走，还原后回到原位。
 *
 * 这里全是纯函数：拼接单张图与整张拼接图共用同一套尺寸、手柄与裁剪规则。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 一块内容的变换：取 crop 这块，显示成 width × height */
export interface ContentTransform {
  crop: Rect
  width: number
  height: number
}

/** 手柄：四角与四边中点 */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 显示尺寸下限：再小手柄就抓不住了 */
export const MIN_DISPLAY_SIDE = 8
/** 裁剪区域下限（原图像素） */
export const MIN_CROP_SIDE = 4

/** 没有变换时的样子：整张原图、原尺寸。 */
export function identityTransform(size: Size): ContentTransform {
  return { crop: { x: 0, y: 0, width: size.width, height: size.height }, width: size.width, height: size.height }
}

export function resolveTransform(size: Size, transform: ContentTransform | null | undefined): ContentTransform {
  return transform ?? identityTransform(size)
}

/** 显示像素 / 原图像素：x、y 两个方向（拉伸时不同）。 */
export function displayScale(transform: ContentTransform): Point {
  return {
    x: transform.width / Math.max(1e-9, transform.crop.width),
    y: transform.height / Math.max(1e-9, transform.crop.height),
  }
}

/** 显示坐标（0..width, 0..height）→ 原图坐标。 */
export function displayToSource(transform: ContentTransform, point: Point): Point {
  const scale = displayScale(transform)
  return {
    x: transform.crop.x + point.x / scale.x,
    y: transform.crop.y + point.y / scale.y,
  }
}

/** 原图坐标 → 显示坐标（可能落在裁剪区域外，为负或超出宽高）。 */
export function sourceToDisplay(transform: ContentTransform, point: Point): Point {
  const scale = displayScale(transform)
  return {
    x: (point.x - transform.crop.x) * scale.x,
    y: (point.y - transform.crop.y) * scale.y,
  }
}

/** 是否就是原样（整张、原尺寸）；是的话不必保存变换。 */
export function isIdentity(size: Size, transform: ContentTransform): boolean {
  const { crop } = transform
  return (
    crop.x === 0 &&
    crop.y === 0 &&
    crop.width === size.width &&
    crop.height === size.height &&
    transform.width === size.width &&
    transform.height === size.height
  )
}

/** 把裁剪区域限制在原图内、取整并不小于下限。 */
export function clampCrop(crop: Rect, size: Size): Rect {
  const width = Math.max(Math.min(MIN_CROP_SIDE, size.width), Math.min(size.width, Math.round(crop.width)))
  const height = Math.max(Math.min(MIN_CROP_SIDE, size.height), Math.min(size.height, Math.round(crop.height)))
  const x = Math.min(size.width - width, Math.max(0, Math.round(crop.x)))
  const y = Math.min(size.height - height, Math.max(0, Math.round(crop.y)))
  return { x, y, width, height }
}

/** 取整、限制范围；等于原样时返回 null（表示没有变换）。 */
export function normalizeTransform(size: Size, transform: ContentTransform): ContentTransform | null {
  const next: ContentTransform = {
    crop: clampCrop(transform.crop, size),
    width: Math.max(MIN_DISPLAY_SIDE, Math.round(transform.width)),
    height: Math.max(MIN_DISPLAY_SIDE, Math.round(transform.height)),
  }
  return isIdentity(size, next) ? null : next
}

function changesWidth(handle: ResizeHandle): boolean {
  return handle.includes('e') || handle.includes('w')
}

function changesHeight(handle: ResizeHandle): boolean {
  return handle.includes('n') || handle.includes('s')
}

/**
 * 拖手柄改显示尺寸。dx、dy 是指针移动的距离（显示像素，向右、向下为正），
 * 已按「这一侧实际要变多少」换算好（居中排列时交叉方向两侧同时变，调用方乘 2）。
 * 保持比例时任何手柄都等比：边只看自己那个方向，角取变化较大的那个方向。
 */
export function resizeByHandle(start: Size, handle: ResizeHandle, dx: number, dy: number, keepRatio: boolean): Size {
  const signX = handle.includes('w') ? -1 : 1
  const signY = handle.includes('n') ? -1 : 1
  const rawWidth = changesWidth(handle) ? start.width + signX * dx : start.width
  const rawHeight = changesHeight(handle) ? start.height + signY * dy : start.height
  if (!keepRatio) {
    return {
      width: Math.max(MIN_DISPLAY_SIDE, Math.round(rawWidth)),
      height: Math.max(MIN_DISPLAY_SIDE, Math.round(rawHeight)),
    }
  }
  const fx = rawWidth / start.width
  const fy = rawHeight / start.height
  let factor: number
  if (changesWidth(handle) && changesHeight(handle)) {
    factor = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy
  } else {
    factor = changesWidth(handle) ? fx : fy
  }
  const minFactor = MIN_DISPLAY_SIDE / Math.min(start.width, start.height)
  factor = Math.max(minFactor, factor)
  return { width: Math.round(start.width * factor), height: Math.round(start.height * factor) }
}

/**
 * 按输入改显示尺寸：保持比例时改宽就按比例算高（反之亦然），也可直接给百分比（相对裁剪区域的原图像素）；
 * 不保持比例时宽高各改各的。
 */
export function resizeByInput(
  transform: ContentTransform,
  input: { width?: number; height?: number; percent?: number },
  keepRatio: boolean,
): Size {
  const { crop } = transform
  if (input.percent !== undefined) {
    const factor = Math.max(0.0001, input.percent / 100)
    return {
      width: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.width * factor)),
      height: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.height * factor)),
    }
  }
  let width = input.width ?? transform.width
  let height = input.height ?? transform.height
  if (keepRatio) {
    const ratio = transform.width / transform.height
    if (input.width !== undefined) {
      height = width / ratio
    } else if (input.height !== undefined) {
      width = height * ratio
    }
  }
  return {
    width: Math.max(MIN_DISPLAY_SIDE, Math.round(width)),
    height: Math.max(MIN_DISPLAY_SIDE, Math.round(height)),
  }
}

/** 当前显示大小相对裁剪区域原图像素的百分比（保持比例时两向相同，取宽度方向）。 */
export function scalePercent(transform: ContentTransform): number {
  return Math.round(displayScale(transform).x * 100)
}

/**
 * 拖裁剪框的边或角。dx、dy 是原图像素。保持比例时按起始裁剪框的宽高比，
 * 边只看自己那个方向、另一边按比例跟着变（以框中线为准），角取变化较大的方向。
 */
export function cropByHandle(start: Rect, handle: ResizeHandle, dx: number, dy: number, size: Size, keepRatio: boolean): Rect {
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('w')) left = Math.min(right - MIN_CROP_SIDE, Math.max(0, left + dx))
  if (handle.includes('e')) right = Math.max(left + MIN_CROP_SIDE, Math.min(size.width, right + dx))
  if (handle.includes('n')) top = Math.min(bottom - MIN_CROP_SIDE, Math.max(0, top + dy))
  if (handle.includes('s')) bottom = Math.max(top + MIN_CROP_SIDE, Math.min(size.height, bottom + dy))

  if (keepRatio) {
    const ratio = start.width / start.height
    let width = right - left
    let height = bottom - top
    const horizontal = changesWidth(handle)
    const vertical = changesHeight(handle)
    const byWidth = horizontal && (!vertical || Math.abs(width - start.width) / start.width >= Math.abs(height - start.height) / start.height)
    if (byWidth) {
      height = width / ratio
    } else {
      width = height * ratio
    }
    // 不超出原图：超了就按能放下的最大尺寸等比缩回。
    const anchorX = handle.includes('w') ? right : horizontal ? left : start.x + start.width / 2
    const anchorY = handle.includes('n') ? bottom : vertical ? top : start.y + start.height / 2
    const maxWidth = handle.includes('w') ? anchorX : horizontal ? size.width - anchorX : Math.min(anchorX, size.width - anchorX) * 2
    const maxHeight = handle.includes('n') ? anchorY : vertical ? size.height - anchorY : Math.min(anchorY, size.height - anchorY) * 2
    const fit = Math.min(1, maxWidth / width, maxHeight / height)
    width *= fit
    height *= fit
    left = handle.includes('w') ? anchorX - width : horizontal ? anchorX : anchorX - width / 2
    top = handle.includes('n') ? anchorY - height : vertical ? anchorY : anchorY - height / 2
    right = left + width
    bottom = top + height
  }
  return clampCrop({ x: left, y: top, width: right - left, height: bottom - top }, size)
}

/** 拖动裁剪框整体平移，限制在原图内。 */
export function moveCrop(start: Rect, dx: number, dy: number, size: Size): Rect {
  return clampCrop({ ...start, x: start.x + dx, y: start.y + dy }, size)
}

/** 确定裁剪：新的裁剪区域沿用原来的「原图 → 显示」比例。 */
export function applyCrop(transform: ContentTransform, crop: Rect): ContentTransform {
  const scale = displayScale(transform)
  return {
    crop: { ...crop },
    width: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.width * scale.x)),
    height: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.height * scale.y)),
  }
}

/** 进入裁剪时临时显示整张原图（比例不变），裁剪框就画在上面。 */
export function uncroppedPreview(transform: ContentTransform, size: Size): ContentTransform {
  const scale = displayScale(transform)
  return {
    crop: { x: 0, y: 0, width: size.width, height: size.height },
    width: Math.max(MIN_DISPLAY_SIDE, Math.round(size.width * scale.x)),
    height: Math.max(MIN_DISPLAY_SIDE, Math.round(size.height * scale.y)),
  }
}

type TransformSource = Pick<StitchImage, 'kind' | 'width' | 'height' | 'transform'>

/** 一张图当前的变换；空白页没有裁剪缩放（它有自己的尺寸面板），总是原样。 */
export function transformOf(image: TransformSource): ContentTransform {
  return image.kind === 'blank' ? identityTransform(image) : resolveTransform(image, image.transform)
}

/** 一张图在拼接布局与导出里占的大小。 */
export function displaySizeOf(image: TransformSource): Size {
  const transform = transformOf(image)
  return { width: transform.width, height: transform.height }
}

/** 给布局计算用：编号、显示尺寸，以及拼接时拖出的位移和图层。 */
export function layoutSourceOf(image: TransformSource & Pick<StitchImage, 'id' | 'position' | 'layer'>): {
  id: string
  width: number
  height: number
  offsetX?: number
  offsetY?: number
  layer?: number
} {
  return {
    id: image.id,
    ...displaySizeOf(image),
    ...(image.position ? { offsetX: image.position.x, offsetY: image.position.y } : {}),
    ...(image.layer === undefined ? {} : { layer: image.layer }),
  }
}

/**
 * 整张拼接图的缩放与裁剪。crop 为 null 表示不裁剪：拼接内容变了（加图、改间距）时跟着整张走；
 * 缩放按比例记，布局尺寸变了也保持同样的倍数。
 */
export interface StitchFrame {
  crop: Rect | null
  scaleX: number
  scaleY: number
}

/** 按当前布局尺寸算出整张图的变换；裁剪区域超出新布局时收回来。 */
export function frameTransform(size: Size, frame: StitchFrame | null): ContentTransform | null {
  if (!frame || size.width <= 0 || size.height <= 0) {
    return null
  }
  const crop = frame.crop ? clampCrop(frame.crop, size) : { x: 0, y: 0, width: size.width, height: size.height }
  return {
    crop,
    width: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.width * frame.scaleX)),
    height: Math.max(MIN_DISPLAY_SIDE, Math.round(crop.height * frame.scaleY)),
  }
}

/** 调整工具给出的变换 → 记下来的整张图设置；原样时为 null。 */
export function frameFromTransform(size: Size, transform: ContentTransform | null): StitchFrame | null {
  const normalized = transform ? normalizeTransform(size, transform) : null
  if (!normalized) {
    return null
  }
  const { crop } = normalized
  const isFull = crop.x === 0 && crop.y === 0 && crop.width === size.width && crop.height === size.height
  return {
    crop: isFull ? null : crop,
    scaleX: normalized.width / crop.width,
    scaleY: normalized.height / crop.height,
  }
}

/** 把拼接布局换算到整张图变换后的坐标里：每张图的位置、大小按同样的裁剪与缩放变换。 */
export function frameLayout<T extends { width: number; height: number; items: Rect[] }>(
  layout: T,
  transform: ContentTransform | null,
): T {
  if (!transform) {
    return layout
  }
  const scale = displayScale(transform)
  return {
    ...layout,
    width: transform.width,
    height: transform.height,
    items: layout.items.map((item) => ({
      ...item,
      x: (item.x - transform.crop.x) * scale.x,
      y: (item.y - transform.crop.y) * scale.y,
      width: item.width * scale.x,
      height: item.height * scale.y,
    })),
  }
}
