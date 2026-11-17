import type {
  AnnotationPoint,
  StitchAnnotation,
  StitchImage,
  StrokeAnnotation,
  TextAnnotation,
} from './types'

const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
const blurCache = new WeakMap<StitchImage, HTMLCanvasElement | null>()
let measureContext: CanvasRenderingContext2D | null | undefined

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
  measureContext = document.createElement('canvas').getContext('2d')
  return measureContext
}

function textWidth(annotation: TextAnnotation): number {
  const context = getMeasureContext()
  if (!context) {
    return annotation.text.length * annotation.fontSize * 0.6
  }
  context.font = `600 ${annotation.fontSize}px ${FONT_FAMILY}`
  return context.measureText(annotation.text).width
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

export function eraseAnnotationsAt(
  annotations: readonly StitchAnnotation[],
  point: AnnotationPoint,
  radius = 10,
): StitchAnnotation[] {
  return annotations.filter((annotation) => !hitsAnnotation(annotation, point, radius))
}

export function getBlurSource(image: StitchImage): HTMLCanvasElement | null {
  if (blurCache.has(image)) {
    return blurCache.get(image) ?? null
  }
  if (!image.element) {
    blurCache.set(image, null)
    return null
  }

  const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    blurCache.set(image, null)
    return null
  }
  context.filter = 'blur(8px)'
  context.drawImage(image.element, 0, 0, canvas.width, canvas.height)
  blurCache.set(image, canvas)
  return canvas
}

function drawStroke(
  context: CanvasRenderingContext2D,
  annotation: StrokeAnnotation,
  image: StitchImage,
): void {
  if (annotation.points.length === 0) {
    return
  }

  if (annotation.type === 'heal') {
    const blurred = getBlurSource(image)
    if (!blurred) {
      return
    }
    context.save()
    context.beginPath()
    for (const point of annotation.points) {
      const radius = Math.max(1.5, annotation.width / 2)
      context.moveTo(point.x + radius, point.y)
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
    }
    context.clip()
    context.drawImage(blurred, 0, 0, image.width, image.height)
    context.restore()
    return
  }

  context.save()
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth = annotation.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (annotation.points.length === 1) {
    const only = annotation.points[0]
    context.beginPath()
    context.arc(only.x, only.y, annotation.width / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.beginPath()
    context.moveTo(annotation.points[0].x, annotation.points[0].y)
    for (let index = 1; index < annotation.points.length; index += 1) {
      context.lineTo(annotation.points[index].x, annotation.points[index].y)
    }
    context.stroke()
  }
  context.restore()
}

function drawText(context: CanvasRenderingContext2D, annotation: TextAnnotation): void {
  context.save()
  context.fillStyle = annotation.color
  context.font = `600 ${annotation.fontSize}px ${FONT_FAMILY}`
  context.textBaseline = 'top'
  context.fillText(annotation.text, annotation.x, annotation.y)
  context.restore()
}

export function drawAnnotations(context: CanvasRenderingContext2D, image: StitchImage): void {
  if (image.annotations.length === 0) {
    return
  }
  for (const annotation of image.annotations) {
    if (annotation.type === 'text') {
      drawText(context, annotation)
    } else {
      drawStroke(context, annotation, image)
    }
  }
}
