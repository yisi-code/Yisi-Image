import type {
  AnnotationPoint,
  AnnotationTool,
  StitchAnnotation,
  StitchImage,
  StrokeAnnotation,
  TextAnnotation,
} from './types'

/** 文字标注的字体；预览里的输入框用同一份，保证所见即所得。 */
export const TEXT_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
export const TEXT_FONT_WEIGHT = 600
/** 修瑕计算中、补丁还没出来时，涂抹范围在预览里的颜色。 */
const HEAL_PENDING_COLOR = 'rgba(217, 45, 32, 0.38)'
let measureContext: CanvasRenderingContext2D | null | undefined

export function textFont(fontSize: number): string {
  return `${TEXT_FONT_WEIGHT} ${fontSize}px ${TEXT_FONT_FAMILY}`
}

/**
 * 画笔、橡皮擦、修瑕在图片坐标里的作用直径。
 * widthSetting 是工具栏上的笔触粗细（屏幕像素），scale 是「图片像素 → 屏幕像素」比例。
 * 画图和指针处的范围圈都用这一份，保证显示的大小就是实际效果。
 */
export function getToolDiameter(tool: AnnotationTool, widthSetting: number, scale: number): number {
  const safeScale = Math.max(0.0001, scale)
  if (tool === 'eraser') {
    return Math.max(8, Math.round((widthSetting * 1.5 + 4) / safeScale)) * 2
  }
  if (tool === 'heal') {
    return Math.max(8, Math.round((widthSetting * 2.5) / safeScale))
  }
  return Math.max(1, Math.round(widthSetting / safeScale))
}

export function createAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function cloneAnnotations(annotations: readonly StitchAnnotation[]): StitchAnnotation[] {
  return annotations.map((annotation) => {
    if (annotation.type === 'text') {
      return { ...annotation }
    }
    return {
      ...annotation,
      points: annotation.points.map((point) => ({ x: point.x, y: point.y })),
    }
  })
}

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext !== undefined) {
    return measureContext
  }
  // 单元测试（Node）或 Worker 里没有 document，退回按字数估算宽度。
  measureContext =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return measureContext
}

export function measureText(text: string, fontSize: number): number {
  const context = getMeasureContext()
  if (!context) {
    return text.length * fontSize * 0.6
  }
  context.font = textFont(fontSize)
  return context.measureText(text).width
}

function textWidth(annotation: TextAnnotation): number {
  return measureText(annotation.text, annotation.fontSize)
}

function distanceToSegment(point: AnnotationPoint, start: AnnotationPoint, end: AnnotationPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  )
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t))
}

function hitsAnnotation(
  annotation: StitchAnnotation,
  point: AnnotationPoint,
  radius: number,
): boolean {
  if (annotation.type === 'text') {
    const width = textWidth(annotation)
    const height = annotation.fontSize * 1.25
    return (
      point.x >= annotation.x - radius &&
      point.x <= annotation.x + width + radius &&
      point.y >= annotation.y - radius &&
      point.y <= annotation.y + height + radius
    )
  }

  const tolerance = annotation.width / 2 + radius
  if (annotation.points.length === 1) {
    const only = annotation.points[0]
    return Math.hypot(point.x - only.x, point.y - only.y) <= tolerance
  }
  for (let index = 1; index < annotation.points.length; index += 1) {
    if (distanceToSegment(point, annotation.points[index - 1], annotation.points[index]) <= tolerance) {
      return true
    }
  }
  return false
}

/** 点中的文字标注（后画的在上层，优先命中）；没有时返回 null。 */
export function findTextAt(
  annotations: readonly StitchAnnotation[],
  point: AnnotationPoint,
  tolerance = 4,
): TextAnnotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index]
    if (annotation.type === 'text' && hitsAnnotation(annotation, point, tolerance)) {
      return annotation
    }
  }
  return null
}

export function eraseAnnotationsAt(
  annotations: readonly StitchAnnotation[],
  point: AnnotationPoint,
  radius = 10,
): StitchAnnotation[] {
  return annotations.filter((annotation) => !hitsAnnotation(annotation, point, radius))
}

export interface DrawAnnotationsOptions {
  /** 正在编辑的文字标注不画，由输入框替它显示 */
  hiddenId?: string | null
  /** 预览模式：修瑕补丁还没算出来时显示半透明涂抹范围；导出时不画 */
  isPreview?: boolean
}

/** 按笔画路径描一遍（圆头圆角）；画笔与修瑕的涂抹范围、修瑕遮罩共用。 */
export function traceStroke(
  context: CanvasRenderingContext2D,
  points: readonly AnnotationPoint[],
  width: number,
  color: string,
): void {
  if (points.length === 0) {
    return
  }
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (points.length === 1) {
    context.beginPath()
    context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y)
    }
    context.stroke()
  }
  context.restore()
}

function drawStroke(
  context: CanvasRenderingContext2D,
  annotation: StrokeAnnotation,
  options: DrawAnnotationsOptions,
): void {
  if (annotation.type === 'heal') {
    if (annotation.patch) {
      const { canvas, x, y, width, height } = annotation.patch
      context.drawImage(canvas, x, y, width, height)
    } else if (options.isPreview) {
      traceStroke(context, annotation.points, annotation.width, HEAL_PENDING_COLOR)
    }
    return
  }
  traceStroke(context, annotation.points, annotation.width, annotation.color)
}

function drawText(context: CanvasRenderingContext2D, annotation: TextAnnotation): void {
  context.save()
  context.fillStyle = annotation.color
  context.font = textFont(annotation.fontSize)
  context.textBaseline = 'top'
  context.fillText(annotation.text, annotation.x, annotation.y)
  context.restore()
}

export function drawAnnotations(
  context: CanvasRenderingContext2D,
  image: StitchImage,
  options: DrawAnnotationsOptions = {},
): void {
  if (image.annotations.length === 0) {
    return
  }
  for (const annotation of image.annotations) {
    if (annotation.id === options.hiddenId) {
      continue
    }
    if (annotation.type === 'text') {
      drawText(context, annotation)
    } else {
      drawStroke(context, annotation, options)
    }
  }
}
