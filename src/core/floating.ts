/**
 * 预览区浮动工具栏（标注栏、缩放栏）的位置计算。
 *
 * 位置按「离哪条边近就贴哪条边」记录：拖到右下角的工具栏在窗口变大后仍留在右下角，
 * 不会因为只记左上角坐标而漂到中间。所有函数都是纯函数，便于单测。
 */

export type FloatingAnchorX = 'left' | 'right'
export type FloatingAnchorY = 'top' | 'bottom'

export interface FloatingPosition {
  x: FloatingAnchorX
  y: FloatingAnchorY
  /** 到 x 所指那条边的距离（px） */
  dx: number
  /** 到 y 所指那条边的距离（px） */
  dy: number
}

export interface FloatingBox {
  left: number
  top: number
}

/** 工具栏与容器边缘至少留出的距离，避免贴边后点不到。 */
export const FLOATING_MARGIN = 6

/** 记录到配置里的距离上限，挡住被手改坏的配置值。 */
const MAX_FLOATING_OFFSET = 10_000

function clampAxis(start: number, size: number, containerSize: number, margin: number): number {
  const max = containerSize - size - margin
  if (max <= margin) {
    // 容器比工具栏还窄时贴住起始边，至少保证左/上半部分可见。
    return margin
  }
  return Math.min(max, Math.max(margin, start))
}

/** 把左上角坐标限制在容器内。 */
export function clampFloatingBox(
  box: FloatingBox,
  width: number,
  height: number,
  containerWidth: number,
  containerHeight: number,
  margin = FLOATING_MARGIN,
): FloatingBox {
  return {
    left: clampAxis(box.left, width, containerWidth, margin),
    top: clampAxis(box.top, height, containerHeight, margin),
  }
}

/** 拖动结束时，把左上角坐标换成「贴最近两条边」的位置。 */
export function anchorFloatingPosition(
  box: FloatingBox,
  width: number,
  height: number,
  containerWidth: number,
  containerHeight: number,
): FloatingPosition {
  const right = containerWidth - box.left - width
  const bottom = containerHeight - box.top - height
  const x: FloatingAnchorX = box.left <= right ? 'left' : 'right'
  const y: FloatingAnchorY = box.top <= bottom ? 'top' : 'bottom'
  return {
    x,
    y,
    dx: Math.max(0, Math.round(x === 'left' ? box.left : right)),
    dy: Math.max(0, Math.round(y === 'top' ? box.top : bottom)),
  }
}

/** 渲染时把记录的位置按当前容器与工具栏尺寸重新限制，窗口变小后也不会跑出可视区。 */
export function resolveFloatingPosition(
  position: FloatingPosition,
  width: number,
  height: number,
  containerWidth: number,
  containerHeight: number,
  margin = FLOATING_MARGIN,
): FloatingPosition {
  return {
    ...position,
    dx: clampAxis(position.dx, width, containerWidth, margin),
    dy: clampAxis(position.dy, height, containerHeight, margin),
  }
}

/** 配置文件里的位置可能被手改，逐项校验，不合法就当作未拖动过。 */
export function normalizeFloatingPosition(value: unknown): FloatingPosition | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const parsed = value as Partial<Record<keyof FloatingPosition, unknown>>
  const isX = parsed.x === 'left' || parsed.x === 'right'
  const isY = parsed.y === 'top' || parsed.y === 'bottom'
  const dx = Number(parsed.dx)
  const dy = Number(parsed.dy)
  if (!isX || !isY || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return null
  }
  return {
    x: parsed.x as FloatingAnchorX,
    y: parsed.y as FloatingAnchorY,
    dx: Math.min(MAX_FLOATING_OFFSET, Math.max(0, Math.round(dx))),
    dy: Math.min(MAX_FLOATING_OFFSET, Math.max(0, Math.round(dy))),
  }
}
