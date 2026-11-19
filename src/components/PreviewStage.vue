<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  Check,
  ChevronsRight,
  ChevronsUp,
  Eraser,
  FilePlus2,
  ImagePlus,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Paintbrush,
  Plus,
  Redo2,
  Type,
  Undo2,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-vue-next'
import FloatingToolbar from './FloatingToolbar.vue'
import { useFileDrop } from '../composables/useFileDrop'
import {
  cloneAnnotations,
  createAnnotationId,
  eraseAnnotationsAt,
} from '../core/annotations'
import { formatDimensions } from '../core/image'
import {
  clampPreviewOffset,
  getFocusOffset,
  getImageFillZoom,
  getMaxPreviewZoom,
  getPreviewFit,
  keepScaleAfterResize,
} from '../core/preview'
import { renderStitchView } from '../core/render'
import { THUMBNAIL_SIZE_PX } from '../core/settings'
import type {
  ThumbnailFit,
  ThumbnailOrientation,
  ThumbnailSize,
  PanelKey,
  PanelState,
} from '../core/settings'
import { vTooltip } from '../directives/tooltip'
import type {
  AnnotationPoint,
  AnnotationTool,
  ImportProgress,
  StitchAnnotation,
  StitchImage,
  StitchLayout,
  StrokeAnnotation,
} from '../core/types'

const props = defineProps<{
  images: StitchImage[]
  layout: StitchLayout
  isImporting: boolean
  progress: ImportProgress
  thumbOrientation: ThumbnailOrientation
  thumbSize: ThumbnailSize
  thumbFit: ThumbnailFit
  annotationToolbar: PanelState
  zoomToolbar: PanelState
  blankPanel: PanelState
  thumbnailPanel: PanelState
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
  'active-change': [id: string | null]
  'resize-blank': [id: string, width: number, height: number]
  'update-panel': [key: PanelKey, state: PanelState]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const zoom = ref(1)
const maxZoom = ref(4)
const offset = ref({ x: 0, y: 0 })
const isPanning = ref(false)
const activeImageId = ref<string | null>(null)
const thumbnailRailRef = ref<HTMLElement | null>(null)
const textInputRef = ref<HTMLInputElement | null>(null)
const annotationTool = ref<AnnotationTool>('select')
const annotationColor = ref('#d92d20')
const annotationWidth = ref(6)
/** 正在按住粗细滑块：显示实际粗细的预览圆点。 */
const isAdjustingWidth = ref(false)
const isDrawing = ref(false)
const textDraft = ref<{
  imageId: string
  x: number
  y: number
  screenX: number
  screenY: number
  value: string
} | null>(null)
const undoStack = ref<HistoryEntry[]>([])
const redoStack = ref<HistoryEntry[]>([])
let drawingImage: StitchImage | null = null
let drawingItem: StitchLayout['items'][number] | null = null
let drawingStroke: StrokeAnnotation | null = null
let drawingBefore: StitchAnnotation[] | null = null
let drawingPointerId: number | null = null
let resizeState: {
  pointerId: number
  startX: number
  startY: number
  startWidth: number
  startHeight: number
  scale: number
} | null = null
/** requestBlankResize 记下的「改尺寸之前」状态，下一帧绘制时消费。 */
let pendingScaleKeep: {
  scale: number
  offset: { x: number; y: number }
  size: { width: number; height: number }
} | null = null
/**
 * 空白页改尺寸后它的中心会移动；在用户自己平移、缩放、适应或改选图片之前，
 * 绘制时不按视口中心重选当前图片，否则拖到一半或输入宽度后空白页被取消选中、手柄和面板消失。
 */
let isHoldingActiveImage = false
let renderFrame = 0
let panState: {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
} | null = null

interface HistoryEntry {
  imageId: string
  before: StitchAnnotation[]
  after: StitchAnnotation[]
}

interface AnnotationToolOption {
  value: AnnotationTool
  /** 无障碍名称 */
  name: string
  /** 悬浮提示 */
  tip: string
  icon: Component
}

const ANNOTATION_TOOLS: AnnotationToolOption[] = [
  { value: 'select', name: '选择与平移', tip: '选择与平移', icon: MousePointer2 },
  { value: 'text', name: '添加文字', tip: '添加文字', icon: Type },
  { value: 'brush', name: '画笔', tip: '画笔', icon: Paintbrush },
  { value: 'eraser', name: '橡皮擦', tip: '橡皮擦（只擦标注，不改原图）', icon: Eraser },
  { value: 'heal', name: '局部修瑕', tip: '局部修瑕（柔化小污点）', icon: Wand2 },
]

const MIN_ZOOM = 0.5
/** 笔触粗细（屏幕像素）：画笔在屏幕上的粗细就是这个值，按当前缩放换算成图片像素。 */
const MIN_BRUSH_WIDTH = 2
const MAX_BRUSH_WIDTH = 30
/** 视口铺满整个点状画布；「适应窗口」时四周仍留出这圈边距。 */
const FIT_PADDING = 24
const PREVIEW_MAX_DPR = 2
const MAX_HISTORY = 50
const displaySize = ref({ width: 0, height: 0 })

const { isFileDragging, dropHandlers } = useFileDrop((files) => emit('add', files))

const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)
const maxZoomPercent = computed(() => `${Math.round(maxZoom.value * 100)}%`)

const resolvedThumbOrientation = computed<'horizontal' | 'vertical'>(() =>
  props.thumbOrientation === 'auto'
    ? props.layout.direction
    : props.thumbOrientation,
)

const thumbStyle = computed<Record<string, string>>(() => {
  const size = THUMBNAIL_SIZE_PX[props.thumbSize]
  return {
    '--thumb-w': `${size.width}px`,
    '--thumb-h': `${size.height}px`,
    '--thumb-fit': props.thumbFit,
  }
})

const previewLabel = computed(
  () =>
    `拼接效果预览，共 ${props.images.length} 张图片，输出尺寸 ${formatDimensions(props.layout.width, props.layout.height)} 像素`,
)

const activeImage = computed(
  () => props.images.find((image) => image.id === activeImageId.value) ?? null,
)
const activeItem = computed(
  () => props.layout.items.find((item) => item.id === activeImageId.value) ?? null,
)
const activeBlank = computed(() =>
  activeImage.value?.kind === 'blank' ? activeImage.value : null,
)
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

const imageToScreen = computed(() => {
  if (displaySize.value.width <= 0 || props.layout.width <= 0) {
    return 1
  }
  return (displaySize.value.width / props.layout.width) * zoom.value
})

const blankSelectionStyle = computed<Record<string, string> | null>(() => {
  const image = activeBlank.value
  const item = activeItem.value
  const viewport = viewportRef.value
  if (!image || !item || !viewport) {
    return null
  }
  const scale = imageToScreen.value
  const contentWidth = displaySize.value.width * zoom.value
  const contentHeight = displaySize.value.height * zoom.value
  const left = (viewport.clientWidth - contentWidth) / 2 + offset.value.x + item.x * scale
  const top = (viewport.clientHeight - contentHeight) / 2 + offset.value.y + item.y * scale
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${item.width * scale}px`,
    height: `${item.height * scale}px`,
  }
})

const textEditorStyle = computed<Record<string, string> | null>(() => {
  const draft = textDraft.value
  const viewport = viewportRef.value
  if (!draft || !viewport) {
    return null
  }
  return {
    left: `${Math.max(8, Math.min(viewport.clientWidth - 236, draft.screenX))}px`,
    top: `${Math.max(8, Math.min(viewport.clientHeight - 50, draft.screenY))}px`,
  }
})

const blankSizeSummary = computed(() =>
  activeBlank.value
    ? formatDimensions(activeBlank.value.width, activeBlank.value.height)
    : '',
)

function findImage(id: string): StitchImage | null {
  return props.images.find((image) => image.id === id) ?? null
}

function pointForItem(
  event: PointerEvent | MouseEvent,
  item: StitchLayout['items'][number],
): AnnotationPoint | null {
  const viewport = viewportRef.value
  if (!viewport || displaySize.value.width <= 0 || props.layout.width <= 0) {
    return null
  }
  const rect = viewport.getBoundingClientRect()
  const scale = imageToScreen.value
  const contentWidth = displaySize.value.width * zoom.value
  const contentHeight = displaySize.value.height * zoom.value
  const left = (viewport.clientWidth - contentWidth) / 2 + offset.value.x
  const top = (viewport.clientHeight - contentHeight) / 2 + offset.value.y
  const localX = (event.clientX - rect.left - left) / scale
  const localY = (event.clientY - rect.top - top) / scale
  return {
    x: Math.max(0, Math.min(item.width, localX - item.x)),
    y: Math.max(0, Math.min(item.height, localY - item.y)),
  }
}

function imageAtEvent(event: PointerEvent | MouseEvent): {
  image: StitchImage
  item: StitchLayout['items'][number]
  point: AnnotationPoint
  screenX: number
  screenY: number
} | null {
  const viewport = viewportRef.value
  if (!viewport || displaySize.value.width <= 0 || props.layout.width <= 0) {
    return null
  }
  const rect = viewport.getBoundingClientRect()
  const scale = imageToScreen.value
  const contentWidth = displaySize.value.width * zoom.value
  const contentHeight = displaySize.value.height * zoom.value
  const left = (viewport.clientWidth - contentWidth) / 2 + offset.value.x
  const top = (viewport.clientHeight - contentHeight) / 2 + offset.value.y
  const layoutX = (event.clientX - rect.left - left) / scale
  const layoutY = (event.clientY - rect.top - top) / scale

  for (let index = props.layout.items.length - 1; index >= 0; index -= 1) {
    const item = props.layout.items[index]
    if (
      layoutX >= item.x &&
      layoutX <= item.x + item.width &&
      layoutY >= item.y &&
      layoutY <= item.y + item.height
    ) {
      const image = findImage(item.id)
      if (!image) {
        continue
      }
      return {
        image,
        item,
        point: {
          x: Math.max(0, Math.min(item.width, layoutX - item.x)),
          y: Math.max(0, Math.min(item.height, layoutY - item.y)),
        },
        screenX: event.clientX - rect.left,
        screenY: event.clientY - rect.top,
      }
    }
  }
  return null
}

function resetHistory(): void {
  undoStack.value = []
  redoStack.value = []
}

function commitHistory(
  imageId: string,
  before: StitchAnnotation[],
  after: StitchAnnotation[],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return
  }
  undoStack.value.push({
    imageId,
    before: cloneAnnotations(before),
    after: cloneAnnotations(after),
  })
  if (undoStack.value.length > MAX_HISTORY) {
    undoStack.value.shift()
  }
  redoStack.value = []
}

function undo(): void {
  while (undoStack.value.length > 0) {
    const entry = undoStack.value.pop()
    if (!entry) {
      return
    }
    const image = findImage(entry.imageId)
    if (!image) {
      continue
    }
    image.annotations = cloneAnnotations(entry.before)
    redoStack.value.push(entry)
    scheduleRender()
    return
  }
}

function redo(): void {
  while (redoStack.value.length > 0) {
    const entry = redoStack.value.pop()
    if (!entry) {
      return
    }
    const image = findImage(entry.imageId)
    if (!image) {
      continue
    }
    image.annotations = cloneAnnotations(entry.after)
    undoStack.value.push(entry)
    scheduleRender()
    return
  }
}

function startWidthAdjust(): void {
  isAdjustingWidth.value = true
  const stop = () => {
    isAdjustingWidth.value = false
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

/** 输入过程中只接受范围内的数，避免输入「1」准备打「15」时被立即改成 2。 */
function onWidthInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value >= MIN_BRUSH_WIDTH && value <= MAX_BRUSH_WIDTH) {
    annotationWidth.value = Math.round(value)
  }
}

function commitWidthInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (Number.isFinite(value) && input.value.trim() !== '') {
    annotationWidth.value = Math.min(MAX_BRUSH_WIDTH, Math.max(MIN_BRUSH_WIDTH, Math.round(value)))
  }
  input.value = String(annotationWidth.value)
}

function setTool(tool: AnnotationTool): void {
  if (isDrawing.value) {
    finishDrawing()
  }
  textDraft.value = null
  annotationTool.value = tool
  viewportRef.value?.focus()
}

function openTextEditor(event: PointerEvent): void {
  const hit = imageAtEvent(event)
  if (!hit) {
    return
  }
  activeImageId.value = hit.image.id
  textDraft.value = {
    imageId: hit.image.id,
    x: hit.point.x,
    y: hit.point.y,
    screenX: hit.screenX,
    screenY: hit.screenY,
    value: '',
  }
  void nextTick(() => textInputRef.value?.focus())
}

function cancelText(): void {
  textDraft.value = null
}

function annotationScale(): number {
  if (!viewportRef.value || props.layout.width <= 0 || displaySize.value.width <= 0) {
    return 1
  }
  return (displaySize.value.width / props.layout.width) * zoom.value
}

function commitText(): void {
  const draft = textDraft.value
  if (!draft) {
    return
  }
  const text = draft.value.trim()
  const image = findImage(draft.imageId)
  if (!text || !image) {
    textDraft.value = null
    return
  }
  const scale = annotationScale()
  const fontSize = Math.max(16, Math.round(24 / scale))
  const before = cloneAnnotations(image.annotations)
  image.annotations = [
    ...image.annotations,
    {
      id: createAnnotationId(),
      type: 'text',
      x: draft.x,
      y: draft.y,
      text,
      fontSize,
      color: annotationColor.value,
      width: text.length * fontSize * 0.62,
    },
  ]
  commitHistory(image.id, before, image.annotations)
  textDraft.value = null
  scheduleRender()
}

function beginDrawing(event: PointerEvent): void {
  event.preventDefault()
  if (annotationTool.value === 'text') {
    openTextEditor(event)
    return
  }

  const hit = imageAtEvent(event)
  if (!hit) {
    return
  }
  const viewport = viewportRef.value
  if (!viewport) {
    return
  }

  event.preventDefault()
  activeImageId.value = hit.image.id
  drawingImage = hit.image
  drawingItem = hit.item
  drawingPointerId = event.pointerId
  drawingBefore = cloneAnnotations(hit.image.annotations)
  isDrawing.value = true
  viewport.setPointerCapture(event.pointerId)

  if (annotationTool.value === 'eraser') {
    applyEraser(hit.point)
    scheduleRender()
    return
  }

  const scale = annotationScale()
  const width =
    annotationTool.value === 'heal'
      ? Math.max(8, Math.round((annotationWidth.value * 2.5) / scale))
      : Math.max(1, Math.round(annotationWidth.value / scale))
  const stroke: StrokeAnnotation = {
    id: createAnnotationId(),
    type: annotationTool.value === 'heal' ? 'heal' : 'brush',
    points: [hit.point],
    color: annotationColor.value,
    width,
  }
  hit.image.annotations = [...hit.image.annotations, stroke]
  drawingStroke = stroke
  scheduleRender()
}

function applyEraser(point: AnnotationPoint): void {
  if (!drawingImage) {
    return
  }
  const next = eraseAnnotationsAt(
    drawingImage.annotations,
    point,
    Math.max(8, Math.round((annotationWidth.value * 1.5 + 4) / annotationScale())),
  )
  if (next.length !== drawingImage.annotations.length) {
    drawingImage.annotations = next
  }
}

function appendDrawing(event: PointerEvent): void {
  if (!drawingImage || !drawingItem) {
    return
  }
  const point = pointForItem(event, drawingItem)
  if (!point) {
    return
  }
  if (annotationTool.value === 'eraser') {
    applyEraser(point)
    scheduleRender()
    return
  }
  if (!drawingStroke) {
    return
  }
  const last = drawingStroke.points[drawingStroke.points.length - 1]
  if (Math.hypot(point.x - last.x, point.y - last.y) < 1.5) {
    return
  }
  drawingStroke.points.push(point)
  scheduleRender()
}

function finishDrawing(): void {
  const viewport = viewportRef.value
  if (viewport && drawingPointerId !== null && viewport.hasPointerCapture(drawingPointerId)) {
    viewport.releasePointerCapture(drawingPointerId)
  }
  if (drawingImage && drawingBefore) {
    commitHistory(drawingImage.id, drawingBefore, drawingImage.annotations)
  }
  isDrawing.value = false
  drawingImage = null
  drawingItem = null
  drawingStroke = null
  drawingBefore = null
  drawingPointerId = null
  scheduleRender()
}

/**
 * 改空白页尺寸的唯一入口：先记下改之前的屏幕比例与平移，
 * 下一帧绘制时按 keepScaleAfterResize 调整，其他图片在屏幕上保持原大小、原位置。
 * 同一帧内多次改尺寸只记第一次，保证按「改之前」计算。
 */
function requestBlankResize(id: string, width: number, height: number): void {
  isHoldingActiveImage = true
  if (!pendingScaleKeep && displaySize.value.width > 0) {
    pendingScaleKeep = {
      scale: imageToScreen.value,
      offset: { ...offset.value },
      size: { width: props.layout.width, height: props.layout.height },
    }
  }
  emit('resize-blank', id, width, height)
}

function updateBlankSize(axis: 'width' | 'height', event: Event): void {
  const image = activeBlank.value
  if (!image) {
    return
  }
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (!Number.isFinite(value)) {
    input.value = String(axis === 'width' ? image.width : image.height)
    return
  }
  const width = axis === 'width' ? value : image.width
  const height = axis === 'height' ? value : image.height
  requestBlankResize(image.id, width, height)
}

function applyBlankPreset(width: number, height: number): void {
  const image = activeBlank.value
  if (image) {
    requestBlankResize(image.id, width, height)
  }
}

function startBlankResize(event: PointerEvent): void {
  const image = activeBlank.value
  if (!image || props.isImporting) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) {
    return
  }
  target.setPointerCapture(event.pointerId)
  resizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: image.width,
    startHeight: image.height,
    scale: imageToScreen.value,
  }
}

function moveBlankResize(event: PointerEvent): void {
  if (!resizeState || resizeState.pointerId !== event.pointerId) {
    return
  }
  const image = activeBlank.value
  if (!image) {
    return
  }
  const scale = Math.max(0.001, resizeState.scale)
  // 图片在交叉方向上居中，空白页会向两侧同时变宽（高）；按 2 倍换算，手柄才跟得上指针。
  const crossFactor = 2
  const widthFactor = props.layout.direction === 'vertical' ? crossFactor : 1
  const heightFactor = props.layout.direction === 'horizontal' ? crossFactor : 1
  requestBlankResize(
    image.id,
    resizeState.startWidth + ((event.clientX - resizeState.startX) * widthFactor) / scale,
    resizeState.startHeight + ((event.clientY - resizeState.startY) * heightFactor) / scale,
  )
}

function endBlankResize(event: PointerEvent): void {
  if (!resizeState || resizeState.pointerId !== event.pointerId) {
    return
  }
  const target = event.currentTarget
  if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  resizeState = null
}

function collapsePanel(key: PanelKey): void {
  emit('update-panel', key, { ...props[key], collapsed: true })
}

function resetView(): void {
  isHoldingActiveImage = false
  zoom.value = 1
  offset.value = { x: 0, y: 0 }
  isPanning.value = false
  panState = null
}

function updateActiveImage(): void {
  const viewport = viewportRef.value
  if (!viewport || !props.layout.items.length || displaySize.value.width <= 0) {
    activeImageId.value = null
    emit('active-change', null)
    return
  }

  const scale = (displaySize.value.width / props.layout.width) * zoom.value
  const contentWidth = props.layout.width * scale
  const contentHeight = props.layout.height * scale
  const left = (viewport.clientWidth - contentWidth) / 2 + offset.value.x
  const top = (viewport.clientHeight - contentHeight) / 2 + offset.value.y
  const centerX = (viewport.clientWidth / 2 - left) / scale
  const centerY = (viewport.clientHeight / 2 - top) / scale

  let closest = props.layout.items[0]
  let closestDistance = Number.POSITIVE_INFINITY
  for (const item of props.layout.items) {
    const dx = item.x + item.width / 2 - centerX
    const dy = item.y + item.height / 2 - centerY
    const distance = dx * dx + dy * dy
    if (distance < closestDistance) {
      closest = item
      closestDistance = distance
    }
  }
  activeImageId.value = closest.id
  emit('active-change', activeImageId.value)
}

function focusImage(index: number): void {
  isHoldingActiveImage = false
  const viewport = viewportRef.value
  const item = props.layout.items[index]
  if (!viewport || !item || displaySize.value.width <= 0) {
    return
  }

  const fitScale = displaySize.value.width / props.layout.width
  const fillZoom = getImageFillZoom(
    item,
    viewport.clientWidth - FIT_PADDING * 2,
    viewport.clientHeight - FIT_PADDING * 2,
    fitScale,
  )
  const nextZoom = Math.min(maxZoom.value, Math.max(zoom.value, fillZoom))
  zoom.value = nextZoom
  offset.value = clampOffset(
    getFocusOffset(item, props.layout, fitScale, nextZoom),
  )
  activeImageId.value = item.id
  scheduleRender()
}

async function scrollActiveThumbnail(id: string | null): Promise<void> {
  await nextTick()
  const rail = thumbnailRailRef.value
  if (!rail || !id) {
    return
  }
  const button = Array.from(
    rail.querySelectorAll<HTMLElement>('[data-image-id]'),
  ).find((item) => item.dataset.imageId === id)
  if (!button) {
    return
  }

  const padding = 8
  const railRect = rail.getBoundingClientRect()
  const buttonRect = button.getBoundingClientRect()
  if (resolvedThumbOrientation.value === 'horizontal') {
    if (buttonRect.left < railRect.left + padding) {
      rail.scrollBy({
        left: buttonRect.left - railRect.left - padding,
        behavior: 'smooth',
      })
    } else if (buttonRect.right > railRect.right - padding) {
      rail.scrollBy({
        left: buttonRect.right - railRect.right + padding,
        behavior: 'smooth',
      })
    }
    return
  }

  if (buttonRect.top < railRect.top + padding) {
    rail.scrollBy({
      top: buttonRect.top - railRect.top - padding,
      behavior: 'smooth',
    })
  } else if (buttonRect.bottom > railRect.bottom - padding) {
    rail.scrollBy({
      top: buttonRect.bottom - railRect.bottom + padding,
      behavior: 'smooth',
    })
  }
}

function onThumbWheel(event: WheelEvent): void {
  if (resolvedThumbOrientation.value !== 'horizontal') {
    return
  }
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
    return
  }
  const rail = thumbnailRailRef.value
  if (!rail) {
    return
  }
  event.preventDefault()
  rail.scrollLeft += event.deltaY
}

function clampOffset(next: { x: number; y: number }) {
  const viewport = viewportRef.value
  if (!viewport) {
    return next
  }

  return clampPreviewOffset(
    next,
    displaySize.value.width * zoom.value,
    displaySize.value.height * zoom.value,
    viewport.clientWidth,
    viewport.clientHeight,
  )
}

function applyZoom(nextZoom: number, anchorX?: number, anchorY?: number): void {
  isHoldingActiveImage = false
  const next = Math.min(maxZoom.value, Math.max(MIN_ZOOM, nextZoom))
  if (Math.abs(next - zoom.value) < 0.001) {
    return
  }

  if (next <= 1) {
    zoom.value = next
    offset.value = { x: 0, y: 0 }
    return
  }

  const viewport = viewportRef.value
  if (!viewport) {
    zoom.value = next
    return
  }

  const rect = viewport.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const px = (anchorX ?? centerX) - centerX
  const py = (anchorY ?? centerY) - centerY
  const contentX = (px - offset.value.x) / zoom.value
  const contentY = (py - offset.value.y) / zoom.value

  zoom.value = next
  offset.value = clampOffset({
    x: px - contentX * next,
    y: py - contentY * next,
  })
}

function zoomBy(factor: number): void {
  const viewport = viewportRef.value
  if (!viewport) {
    applyZoom(zoom.value * factor)
    return
  }
  const rect = viewport.getBoundingClientRect()
  applyZoom(zoom.value * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function onWheel(event: WheelEvent): void {
  if (props.images.length === 0 || isDrawing.value) {
    return
  }
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  const delta = Math.max(-240, Math.min(240, event.deltaY * unit))
  applyZoom(zoom.value * Math.exp(-delta * 0.0018), event.clientX, event.clientY)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) {
    return
  }
  if (annotationTool.value !== 'select') {
    beginDrawing(event)
    return
  }
  if (zoom.value <= 1) {
    return
  }
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) {
    return
  }

  event.preventDefault()
  target.setPointerCapture(event.pointerId)
  isHoldingActiveImage = false
  panState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: offset.value.x,
    originY: offset.value.y,
  }
  isPanning.value = true
}

function onPointerMove(event: PointerEvent): void {
  if (isDrawing.value && event.pointerId === drawingPointerId) {
    appendDrawing(event)
    return
  }
  if (!panState || event.pointerId !== panState.pointerId) {
    return
  }

  offset.value = clampOffset({
    x: panState.originX + event.clientX - panState.startX,
    y: panState.originY + event.clientY - panState.startY,
  })
  scheduleRender()
  updateActiveImage()
}

function onPointerUp(event: PointerEvent): void {
  if (isDrawing.value && event.pointerId === drawingPointerId) {
    finishDrawing()
    return
  }
  if (!panState || event.pointerId !== panState.pointerId) {
    return
  }

  const target = event.currentTarget
  if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  panState = null
  isPanning.value = false
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, textarea, select'))
  )
}

function onViewportKeydown(event: KeyboardEvent): void {
  // 视口里的输入框（文字标注、空白页宽高、笔触粗细、滑块）按键交给输入框自己：
  // 否则 0、+、- 会被当成缩放快捷键吃掉，输入 1200 只剩 12。
  if (isEditableTarget(event.target)) {
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) {
      redo()
    } else {
      undo()
    }
    return
  }
  if (event.key === 'Escape') {
    textDraft.value = null
    return
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomBy(1.25)
    return
  }
  if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    zoomBy(0.8)
    return
  }
  if (event.key === '0') {
    event.preventDefault()
    resetView()
    return
  }
  if (zoom.value <= 1) {
    return
  }

  const step = 36
  isHoldingActiveImage = false
  const next = { ...offset.value }
  if (event.key === 'ArrowLeft') next.x -= step
  else if (event.key === 'ArrowRight') next.x += step
  else if (event.key === 'ArrowUp') next.y -= step
  else if (event.key === 'ArrowDown') next.y += step
  else return

  event.preventDefault()
  offset.value = clampOffset(next)
  scheduleRender()
  updateActiveImage()
}

function handleResize(): void {
  if (zoom.value <= 1) {
    offset.value = { x: 0, y: 0 }
  }
  scheduleRender()
}

function renderPreview(): void {
  const canvas = canvasRef.value
  const viewport = viewportRef.value
  if (!canvas || !viewport || props.layout.width <= 0 || props.layout.height <= 0) {
    return
  }

  const viewportWidth = Math.max(1, viewport.clientWidth)
  const viewportHeight = Math.max(1, viewport.clientHeight)
  const fit = getPreviewFit(props.layout, viewportWidth, viewportHeight, FIT_PADDING)
  if (fit.scale <= 0) {
    return
  }

  displaySize.value = { width: fit.width, height: fit.height }
  maxZoom.value = getMaxPreviewZoom(
    props.layout,
    viewportWidth,
    viewportHeight,
    undefined,
    FIT_PADDING,
  )

  if (pendingScaleKeep) {
    const kept = keepScaleAfterResize({
      previousScale: pendingScaleKeep.scale,
      fitScale: fit.scale,
      minZoom: MIN_ZOOM,
      maxZoom: maxZoom.value,
      offset: pendingScaleKeep.offset,
      direction: props.layout.direction,
      previousSize: pendingScaleKeep.size,
      nextSize: { width: props.layout.width, height: props.layout.height },
    })
    pendingScaleKeep = null
    zoom.value = kept.zoom
    offset.value = clampOffset(kept.offset)
  }

  if (zoom.value > maxZoom.value) {
    zoom.value = maxZoom.value
  }
  if (zoom.value > 1) {
    const clamped = clampOffset(offset.value)
    if (clamped.x !== offset.value.x || clamped.y !== offset.value.y) {
      offset.value = clamped
    }
  }

  renderStitchView(canvas, props.layout, props.images, {
    viewportWidth,
    viewportHeight,
    fitScale: fit.scale,
    zoom: zoom.value,
    offset: offset.value,
    dpr: Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR),
  })
  if (!isHoldingActiveImage) {
    updateActiveImage()
  }
}

function scheduleRender(): void {
  window.cancelAnimationFrame(renderFrame)
  renderFrame = window.requestAnimationFrame(renderPreview)
}

watch(() => props.layout, scheduleRender, { flush: 'post' })
watch(zoom, scheduleRender, { flush: 'post' })
watch(activeImageId, (id) => {
  emit('active-change', id)
  if (!id) {
    textDraft.value = null
  }
  void scrollActiveThumbnail(id)
})
watch(
  [resolvedThumbOrientation, () => props.thumbSize, () => props.thumbnailPanel.collapsed],
  () => {
    scheduleRender()
    void scrollActiveThumbnail(activeImageId.value)
  },
  { flush: 'post' },
)

// 收起标注栏后看不到当前工具，回到「选择」，避免点一下画布就画上一笔。
watch(
  () => props.annotationToolbar.collapsed,
  (collapsed) => {
    if (!collapsed) {
      return
    }
    if (isDrawing.value) {
      finishDrawing()
    }
    textDraft.value = null
    annotationTool.value = 'select'
  },
)

// 视口尺寸除了窗口缩放，还会随缩略图收起/展开、方向切换而变化，统一用 ResizeObserver 重绘。
const viewportObserver = new ResizeObserver(() => handleResize())
watch(
  viewportRef,
  (element, previous) => {
    if (previous) {
      viewportObserver.unobserve(previous)
    }
    if (element) {
      viewportObserver.observe(element)
    }
  },
  { flush: 'post' },
)

let previousImageIds: string[] = []
watch(
  () => props.images.map((image) => image.id),
  (nextIds) => {
    const hadImages = previousImageIds.length > 0
    const hasImages = nextIds.length > 0
    const previousIds = new Set(previousImageIds)
    const replaced = hadImages && hasImages && !nextIds.some((id) => previousIds.has(id))

    // 删掉其中一张、排序、追加都不重置视图；只有从空到有、清空或整组替换才回到适应窗口。
    if ((!hadImages && hasImages) || (hadImages && !hasImages) || replaced) {
      resetView()
      resetHistory()
    } else if (nextIds.length < previousImageIds.length) {
      // 被删除的图片可能还被历史记录引用，删图时清空标注历史，避免撤销作用到已移除对象。
      resetHistory()
    }
    if (!hasImages) {
      textDraft.value = null
    }
    previousImageIds = [...nextIds]
    scheduleRender()
  },
  { flush: 'post' },
)

onMounted(() => {
  if (viewportRef.value) {
    viewportObserver.observe(viewportRef.value)
  }
  scheduleRender()
})
onBeforeUnmount(() => {
  window.cancelAnimationFrame(renderFrame)
  viewportObserver.disconnect()
})

defineExpose({ focusImage })
</script>

<template>
  <div
    class="preview-area"
    :class="`preview-area--${resolvedThumbOrientation}`"
    :style="thumbStyle"
    v-on="dropHandlers"
  >
    <aside
      v-if="images.length > 0 && !thumbnailPanel.collapsed"
      class="thumb-panel"
      aria-label="图片缩略图"
    >
      <button
        v-tooltip="'收起缩略图（可在预览标题栏重新显示）'"
        class="thumb-panel__collapse"
        type="button"
        aria-label="收起缩略图（可在预览标题栏重新显示）"
        @click="collapsePanel('thumbnailPanel')"
      >
        <ChevronsUp v-if="resolvedThumbOrientation === 'horizontal'" :size="14" :stroke-width="1.9" />
        <ChevronsRight v-else :size="14" :stroke-width="1.9" />
      </button>
      <nav
        ref="thumbnailRailRef"
        class="preview-thumbnails"
        :class="`preview-thumbnails--${resolvedThumbOrientation}`"
        aria-label="图片缩略图导航"
        @wheel="onThumbWheel"
      >
        <button
          v-for="(image, index) in images"
          :key="image.id"
          class="preview-thumbnail"
          :class="{ 'is-active': image.id === activeImageId }"
          type="button"
          :data-image-id="image.id"
          :aria-label="`定位并放大到第 ${index + 1} 张：${image.name}`"
          :aria-current="image.id === activeImageId ? 'true' : undefined"
          @click="focusImage(index)"
        >
          <span v-if="image.kind === 'blank'" class="preview-thumbnail__blank" aria-hidden="true">
            <FilePlus2 :size="17" :stroke-width="1.6" />
          </span>
          <img v-else :src="image.url" alt="" draggable="false" />
          <span class="preview-thumbnail__index tnum">{{ index + 1 }}</span>
        </button>
      </nav>
    </aside>

    <div class="preview-stage" :class="{ 'is-file-dragging': isFileDragging }">
      <div
        v-if="images.length > 0"
        ref="viewportRef"
        class="stage-viewport"
        :class="{
          'is-panning': isPanning,
          'is-zoomed': zoom > 1,
          'is-annotating': annotationTool !== 'select',
          'is-drawing': isDrawing,
        }"
        role="region"
        tabindex="0"
        aria-label="预览视口，滚轮缩放，放大后可拖动查看，按 0 恢复适应窗口"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="resetView"
        @keydown="onViewportKeydown"
      >
        <canvas
          ref="canvasRef"
          class="preview-canvas"
          role="img"
          :aria-label="previewLabel"
        />

        <div
          v-if="activeBlank && blankSelectionStyle"
          class="blank-selection"
          :style="blankSelectionStyle"
          aria-hidden="true"
        >
          <span class="blank-selection-label">空白页</span>
          <button
            v-tooltip="'拖动调整空白页大小'"
            class="blank-resize-handle"
            type="button"
            aria-label="拖动调整空白页大小"
            @pointerdown="startBlankResize"
            @pointermove="moveBlankResize"
            @pointerup="endBlankResize"
            @pointercancel="endBlankResize"
          />
        </div>

        <FloatingToolbar
          v-if="!annotationToolbar.collapsed"
          class="annotation-toolbar"
          label="标注工具栏"
          :state="annotationToolbar"
          @update:state="emit('update-panel', 'annotationToolbar', $event)"
        >
          <button
            v-for="tool in ANNOTATION_TOOLS"
            :key="tool.value"
            v-tooltip="tool.tip"
            class="annotation-tool"
            :class="{ 'is-active': annotationTool === tool.value }"
            type="button"
            :aria-label="tool.name"
            :aria-pressed="annotationTool === tool.value"
            @click="setTool(tool.value)"
          >
            <component :is="tool.icon" :size="14" :stroke-width="1.9" />
          </button>
          <span class="annotation-separator" aria-hidden="true" />
          <label v-tooltip="'标注颜色'" class="annotation-color">
            <input v-model="annotationColor" type="color" aria-label="标注颜色" />
          </label>
          <label v-tooltip="'笔触粗细'" class="annotation-size">
            <input
              v-model.number="annotationWidth"
              type="range"
              :min="MIN_BRUSH_WIDTH"
              :max="MAX_BRUSH_WIDTH"
              step="1"
              aria-label="笔触粗细"
              @pointerdown="startWidthAdjust"
            />
            <span
              v-if="isAdjustingWidth"
              class="annotation-size-preview"
              :class="{ 'is-above': annotationToolbar.position?.y === 'bottom' }"
              aria-hidden="true"
            >
              <span
                class="annotation-size-dot"
                :style="{
                  width: `${annotationWidth}px`,
                  height: `${annotationWidth}px`,
                  background: annotationColor,
                }"
              />
              <span class="tnum">{{ annotationWidth }} px</span>
            </span>
          </label>
          <input
            v-tooltip="`笔触粗细，可输入 ${MIN_BRUSH_WIDTH}–${MAX_BRUSH_WIDTH}`"
            class="annotation-size-input tnum"
            type="number"
            :min="MIN_BRUSH_WIDTH"
            :max="MAX_BRUSH_WIDTH"
            step="1"
            :value="annotationWidth"
            aria-label="笔触粗细（像素）"
            @input="onWidthInput"
            @change="commitWidthInput"
          />
          <span class="annotation-separator" aria-hidden="true" />
          <button
            v-tooltip="'撤销标注（Ctrl+Z）'"
            class="annotation-tool"
            type="button"
            :disabled="!canUndo"
            aria-label="撤销标注"
            @click="undo"
          >
            <Undo2 :size="14" :stroke-width="1.9" />
          </button>
          <button
            v-tooltip="'重做标注（Ctrl+Shift+Z）'"
            class="annotation-tool"
            type="button"
            :disabled="!canRedo"
            aria-label="重做标注"
            @click="redo"
          >
            <Redo2 :size="14" :stroke-width="1.9" />
          </button>
        </FloatingToolbar>

        <div
          v-if="activeBlank && !blankPanel.collapsed"
          class="blank-size-panel"
          @pointerdown.stop
          @click.stop
          @dblclick.stop
          @wheel.stop
        >
          <div class="blank-size-head">
            <strong>空白页</strong>
            <span class="tnum">{{ blankSizeSummary }}</span>
            <button
              v-tooltip="'收起空白页面板（可在预览标题栏重新显示）'"
              class="blank-size-collapse"
              type="button"
              aria-label="收起空白页面板（可在预览标题栏重新显示）"
              @click="collapsePanel('blankPanel')"
            >
              <ChevronsRight :size="14" :stroke-width="1.9" />
            </button>
          </div>
          <div class="blank-size-fields">
            <label>
              <span>宽</span>
              <input
                type="number"
                min="40"
                max="16384"
                step="10"
                :value="activeBlank.width"
                @change="updateBlankSize('width', $event)"
              />
            </label>
            <label>
              <span>高</span>
              <input
                type="number"
                min="40"
                max="16384"
                step="10"
                :value="activeBlank.height"
                @change="updateBlankSize('height', $event)"
              />
            </label>
          </div>
          <div class="blank-size-presets">
            <button type="button" @click="applyBlankPreset(800, 800)">1:1</button>
            <button type="button" @click="applyBlankPreset(1200, 800)">3:2</button>
            <button type="button" @click="applyBlankPreset(1920, 1080)">16:9</button>
          </div>
          <span class="blank-size-hint">也可拖动右下角调整</span>
        </div>

        <div
          v-if="textDraft"
          class="text-editor"
          :style="textEditorStyle"
          @pointerdown.stop
          @click.stop
        >
          <input
            ref="textInputRef"
            v-model="textDraft.value"
            type="text"
            maxlength="120"
            placeholder="输入文字后回车"
            aria-label="标注文字"
            @keydown.enter.prevent="commitText"
            @keydown.esc.prevent="cancelText"
          />
          <button v-tooltip="'确认文字'" type="button" aria-label="确认文字" @click="commitText">
            <Check :size="14" :stroke-width="2" />
          </button>
          <button v-tooltip="'取消文字'" type="button" aria-label="取消文字" @click="cancelText">
            <X :size="14" :stroke-width="2" />
          </button>
        </div>
      </div>

      <div v-else-if="isImporting" class="stage-loading" role="status">
        <span class="loading-mark">
          <Loader2 class="spin" :size="24" :stroke-width="1.8" />
        </span>
        <p>正在读取图片</p>
        <span class="loading-count tnum">{{ progress.done }} / {{ progress.total }}</span>
      </div>

      <div v-else class="stage-empty">
        <div class="empty-art" aria-hidden="true">
          <span class="empty-sheet empty-sheet--back" />
          <span class="empty-sheet empty-sheet--mid" />
          <span class="empty-sheet empty-sheet--front">
            <ImagePlus :size="27" :stroke-width="1.6" />
          </span>
        </div>

        <h2>添加图片，开始拼接</h2>
        <p>把多张图片放进队列，纵向或横向拼成一张。可以拖动调整顺序，间距也能随时修改。</p>

        <button class="button button-primary empty-action" type="button" @click="emit('pick')">
          <ImagePlus :size="16" :stroke-width="1.9" />
          <span>选择图片</span>
        </button>

        <span class="empty-drop-hint">
          <UploadCloud :size="13" :stroke-width="1.8" />
          也可以把图片拖到这里
        </span>
      </div>

      <FloatingToolbar
        v-if="images.length > 0 && !zoomToolbar.collapsed"
        class="zoom-toolbar"
        label="缩放栏"
        :state="zoomToolbar"
        @update:state="emit('update-panel', 'zoomToolbar', $event)"
      >
        <button
          v-tooltip="'缩小预览'"
          class="zoom-button"
          type="button"
          :disabled="zoom <= MIN_ZOOM + 0.001"
          aria-label="缩小预览"
          @click="zoomBy(0.8)"
        >
          <Minus :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'恢复到适应窗口'"
          class="zoom-value tnum"
          type="button"
          :aria-label="`当前缩放 ${zoomPercent}，点击恢复适应窗口`"
          @click="resetView"
        >
          {{ zoomPercent }}
        </button>
        <button
          v-tooltip="`放大预览（最大 ${maxZoomPercent}）`"
          class="zoom-button"
          type="button"
          :disabled="zoom >= maxZoom - 0.001"
          :aria-label="`放大预览，最大 ${maxZoomPercent}`"
          @click="zoomBy(1.25)"
        >
          <Plus :size="14" :stroke-width="2" />
        </button>
        <span class="zoom-separator" aria-hidden="true" />
        <button
          v-tooltip="'恢复适应窗口'"
          class="zoom-fit"
          type="button"
          @click="resetView"
        >
          <Maximize2 :size="13" :stroke-width="1.9" />
          <span>适应</span>
        </button>
        <span class="zoom-hint" aria-hidden="true">滚轮缩放 · 拖动查看</span>
      </FloatingToolbar>

      <div v-if="isImporting && images.length > 0" class="stage-busy" role="status">
        <Loader2 class="spin" :size="13" :stroke-width="2" />
        <span class="tnum">正在添加 {{ progress.done }}/{{ progress.total }}</span>
      </div>

      <div v-if="isFileDragging" class="stage-drop-overlay" aria-hidden="true">
        <span class="stage-drop-icon">
          <UploadCloud :size="24" :stroke-width="1.7" />
        </span>
        <strong>松开以添加图片</strong>
        <span>支持一次拖入多张</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 预览区：缩略图面板在点状画布之外，横向排列时在上方，纵向排列时在右侧。 */
.preview-area {
  --thumb-w: 92px;
  --thumb-h: 56px;
  --thumb-fit: contain;

  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  gap: 8px;
  margin: 12px;
}

.preview-area--horizontal {
  flex-direction: column;
}

.preview-area--vertical {
  flex-direction: row;
}

.preview-stage {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: 13px;
  background-color: var(--surface-inset);
  background-image: radial-gradient(rgba(29, 64, 54, 0.13) 1px, transparent 1px);
  background-size: 16px 16px;
}

/* 视口铺满整个点状画布，内容放大、平移、空白页变宽时都能画到画布边缘。 */
.stage-viewport {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 12px;
  cursor: zoom-in;
  touch-action: none;
}

.thumb-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.preview-area--horizontal .thumb-panel {
  flex-direction: row;
}

.preview-area--vertical .thumb-panel {
  order: 2;
  flex-direction: column;
}

.thumb-panel__collapse {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-muted);
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.thumb-panel__collapse:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.preview-thumbnails {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 0;
  scrollbar-color: var(--scrollbar-thumb) transparent;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}

.preview-thumbnails::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.preview-thumbnails::-webkit-scrollbar-track {
  background: transparent;
}

.preview-thumbnails::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--scrollbar-thumb);
}

.preview-thumbnails::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

.preview-thumbnails--horizontal {
  min-width: 0;
  height: calc(var(--thumb-h) + 12px);
  flex: 1;
  flex-direction: row;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 2px 8px;
  scroll-snap-type: x proximity;
}

.preview-thumbnails--vertical {
  min-height: 0;
  width: calc(var(--thumb-w) + 12px);
  flex: 1;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 2px 8px 2px 2px;
  scroll-snap-type: y proximity;
}

.preview-thumbnail {
  position: relative;
  display: block;
  flex: 0 0 auto;
  overflow: hidden;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 7px;
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--border);
  cursor: pointer;
  scroll-snap-align: start;
  transition:
    border-color 0.15s var(--ease),
    box-shadow 0.15s var(--ease);
}

.preview-thumbnails--horizontal .preview-thumbnail {
  width: var(--thumb-w);
  height: var(--thumb-h);
}

.preview-thumbnails--vertical .preview-thumbnail {
  width: var(--thumb-w);
  height: var(--thumb-h);
}

.preview-thumbnail img {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--surface);
  object-fit: var(--thumb-fit);
}

.preview-thumbnail__blank {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  background: var(--surface-subtle);
  color: var(--text-faint);
}

.preview-thumbnail__index {
  position: absolute;
  bottom: 3px;
  left: 4px;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(19, 32, 28, 0.72);
  color: #fff;
  font-size: 9px;
  font-weight: 650;
  line-height: 1.35;
}

.preview-thumbnail:hover {
  border-color: var(--accent-line-strong);
}

.preview-thumbnail.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.preview-thumbnail:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.stage-viewport.is-zoomed {
  cursor: grab;
}

.stage-viewport.is-panning {
  cursor: grabbing;
}

.stage-viewport.is-annotating,
.stage-viewport.is-drawing {
  cursor: crosshair;
}

.stage-viewport:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.preview-canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 8px;
  background: transparent;
  cursor: inherit;
}

/* 外观与拖动由 FloatingToolbar 负责，这里只给未拖动过时的默认位置。 */
.annotation-toolbar {
  z-index: 4;
  top: 10px;
  left: 10px;
}

.annotation-tool {
  display: inline-flex;
  width: 27px;
  height: 27px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-muted);
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.annotation-tool:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.annotation-tool.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.annotation-tool:disabled {
  opacity: 0.3;
}

.annotation-separator {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--border);
}

.annotation-color {
  display: inline-flex;
  width: 27px;
  height: 27px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  cursor: pointer;
}

.annotation-color:hover {
  background: var(--surface-hover);
}

.annotation-color input {
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: none;
  cursor: pointer;
}

.annotation-color input::-webkit-color-swatch-wrapper {
  padding: 0;
}

.annotation-color input::-webkit-color-swatch {
  border: 0;
  border-radius: 50%;
}

.annotation-size {
  position: relative;
  display: inline-flex;
  width: 66px;
  height: 27px;
  align-items: center;
  padding: 0 4px;
  cursor: pointer;
}

.annotation-size input {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 按住滑块时的粗细预览：圆点直径就是画笔在屏幕上的实际粗细。 */
.annotation-size-preview {
  position: absolute;
  z-index: 2;
  top: calc(100% + 8px);
  left: 50%;
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: var(--shadow-float);
  pointer-events: none;
  transform: translateX(-50%);
}

.annotation-size-preview.is-above {
  top: auto;
  bottom: calc(100% + 8px);
}

.annotation-size-dot {
  flex: 0 0 auto;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(19, 32, 28, 0.14);
}

.annotation-size-input {
  width: 32px;
  height: 22px;
  margin: 0 2px 0 0;
  padding: 0 3px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 10.5px;
  text-align: center;
  appearance: textfield;
}

.annotation-size-input::-webkit-inner-spin-button,
.annotation-size-input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.annotation-size-input:focus {
  border-color: var(--accent);
  outline: none;
}

.blank-selection {
  position: absolute;
  z-index: 3;
  border: 1.5px dashed var(--accent);
  background: transparent;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.72) inset;
  pointer-events: none;
}

.blank-selection-label {
  position: absolute;
  top: -19px;
  left: -1px;
  padding: 2px 6px;
  border-radius: 4px 4px 0 0;
  background: var(--accent);
  color: var(--surface);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.blank-resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 15px;
  height: 15px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-xs);
  cursor: nwse-resize;
  pointer-events: auto;
  transform: translate(50%, 50%);
}

.blank-resize-handle:hover {
  background: var(--accent-soft);
}

.blank-size-panel {
  position: absolute;
  z-index: 4;
  right: 10px;
  bottom: 10px;
  display: flex;
  width: 214px;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: var(--shadow-xs);
  backdrop-filter: blur(8px);
}

.blank-size-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.blank-size-head strong {
  color: var(--text-strong);
  font-size: 11px;
  font-weight: 650;
}

.blank-size-head span {
  flex: 1;
  color: var(--text-faint);
  font-size: 9.5px;
  text-align: right;
}

.blank-size-collapse {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  margin-right: -4px;
  border-radius: 5px;
  color: var(--text-muted);
}

.blank-size-collapse:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.blank-size-fields {
  display: flex;
  gap: 7px;
}

.blank-size-fields label {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
  font-size: 9px;
}

.blank-size-fields input {
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.blank-size-fields input:focus {
  border-color: var(--accent);
  outline: none;
}

.blank-size-presets {
  display: flex;
  gap: 4px;
}

.blank-size-presets button {
  height: 22px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 9px;
}

.blank-size-presets button:hover {
  border-color: var(--accent-line-strong);
  color: var(--accent);
}

.blank-size-hint {
  color: var(--text-faint);
  font-size: 9px;
  line-height: 1.4;
}

.text-editor {
  position: absolute;
  z-index: 5;
  display: flex;
  width: 228px;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--accent-line-strong);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-float);
}

.text-editor input {
  min-width: 0;
  height: 28px;
  flex: 1;
  padding: 0 7px;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font-size: 12px;
}

.text-editor input:focus {
  outline: none;
}

.text-editor button {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-muted);
}

.text-editor button:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.zoom-toolbar {
  z-index: 3;
  bottom: 15px;
  left: 15px;
}

.zoom-button,
.zoom-value,
.zoom-fit {
  display: inline-flex;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-muted);
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.zoom-button {
  width: 26px;
}

.zoom-button:hover:not(:disabled),
.zoom-value:hover,
.zoom-fit:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.zoom-button:disabled {
  opacity: 0.3;
}

.zoom-value {
  min-width: 42px;
  padding: 0 4px;
  color: var(--text-strong);
  font-size: 10.5px;
  font-weight: 600;
}

.zoom-fit {
  gap: 4px;
  padding: 0 7px;
  font-size: 10.5px;
  font-weight: 550;
}

.zoom-separator {
  width: 1px;
  height: 15px;
  margin: 0 2px;
  background: var(--border);
}

.zoom-hint {
  padding: 0 7px 0 6px;
  color: var(--text-faint);
  font-size: 9.5px;
  white-space: nowrap;
}

.stage-empty {
  display: flex;
  max-width: 440px;
  flex-direction: column;
  align-items: center;
  padding: 18px;
  text-align: center;
}

.empty-art {
  position: relative;
  width: 132px;
  height: 104px;
  margin-bottom: 22px;
}

.empty-sheet {
  position: absolute;
  display: flex;
  width: 78px;
  height: 92px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 10px 24px -18px rgba(19, 32, 28, 0.42);
}

.empty-sheet--back {
  top: 8px;
  left: 7px;
  background: var(--surface-canvas);
  transform: rotate(-10deg);
}

.empty-sheet--mid {
  top: 3px;
  right: 7px;
  transform: rotate(7deg);
}

.empty-sheet--front {
  top: 0;
  left: 27px;
  border-color: var(--accent-line-strong);
  background: linear-gradient(155deg, var(--surface), var(--surface-accent));
  color: var(--accent);
}

.empty-sheet--front::after {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 20px;
  height: 20px;
  border: 3px solid var(--surface-inset);
  border-radius: 50%;
  background: var(--accent);
  content: '';
}

.stage-empty h2 {
  color: var(--text-strong);
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.3;
}

.stage-empty p {
  margin-top: 9px;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.75;
}

.empty-action {
  height: 40px;
  margin-top: 20px;
  padding: 0 18px;
}

.empty-drop-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  color: var(--text-faint);
  font-size: 10.5px;
}

.stage-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.loading-mark {
  display: inline-flex;
  width: 50px;
  height: 50px;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--accent);
  box-shadow: var(--shadow-xs);
}

.stage-loading p {
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 650;
}

.loading-count {
  color: var(--text-muted);
  font-size: 11px;
}

.stage-busy {
  position: absolute;
  right: 24px;
  bottom: 52px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--text-muted);
  font-size: 10.5px;
  box-shadow: var(--shadow-xs);
  backdrop-filter: blur(4px);
}

.stage-drop-overlay {
  position: absolute;
  z-index: 4;
  inset: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  border: 2px dashed var(--accent);
  border-radius: 12px;
  background: rgba(246, 252, 250, 0.94);
  color: var(--accent);
  pointer-events: none;
  backdrop-filter: blur(2px);
}

.stage-drop-icon {
  display: inline-flex;
  width: 46px;
  height: 46px;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
  border-radius: 13px;
  background: var(--accent-soft);
}

.stage-drop-overlay strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
}

.stage-drop-overlay > span:last-child {
  color: var(--text-muted);
  font-size: 11px;
}

@media (max-width: 700px) {
  .preview-area {
    margin: 10px;
  }

  .preview-stage {
    padding: 16px;
  }

  .preview-thumbnails {
    gap: 4px;
  }

  .annotation-toolbar {
    top: 8px;
    left: 8px;
  }

  .annotation-tool {
    width: 25px;
    height: 25px;
  }

  .annotation-color {
    width: 25px;
    height: 25px;
  }

  .annotation-size {
    display: none;
  }

  .blank-size-panel {
    right: 8px;
    bottom: 8px;
    width: 190px;
    padding: 8px;
  }

  .text-editor {
    width: 200px;
  }

  .blank-selection-label {
    font-size: 8px;
  }

  .zoom-toolbar {
    bottom: 11px;
    left: 11px;
  }

  .stage-busy {
    right: 16px;
    bottom: 46px;
  }

  .zoom-hint {
    display: none;
  }

  .stage-empty {
    padding: 10px;
  }

  .empty-art {
    margin-bottom: 16px;
    transform: scale(0.9);
  }

  .stage-empty h2 {
    font-size: 19px;
  }
}
</style>
