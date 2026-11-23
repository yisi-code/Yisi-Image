<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  Check,
  ChevronsRight,
  ChevronsUp,
  Eraser,
  FilePlus2,
  GripVertical,
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
  findTextAt,
  getToolDiameter,
  measureText,
  textFont,
} from '../core/annotations'
import { createHealPatch, prepareHealJob } from '../core/heal'
import { runHeal } from '../core/healEngine'
import type { HealEngineChoice } from '../core/healEngine'
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
  StitchBackground,
} from '../core/settings'
import { vTooltip } from '../directives/tooltip'
import type {
  AnnotationPoint,
  AnnotationTool,
  ImportProgress,
  StitchAnnotation,
  StitchImage,
  StitchLayout,
  HealFill,
  StrokeAnnotation,
  TextAnnotation,
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
  /** 拼接背景；透明时预览画棋盘格 */
  background: StitchBackground
  /** 单图编辑：只放当前这一张，不显示缩略图条，文案按单图说 */
  singleImage?: boolean
  /** 这次修瑕用经典算法还是 AI 模型（由 App 按设置与模型下载状态算出） */
  healEngine: HealEngineChoice
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
  'active-change': [id: string | null]
  'resize-blank': [id: string, width: number, height: number]
  'update-panel': [key: PanelKey, state: PanelState]
  'heal-failed': [message: string]
  /** 修瑕成功但需要告诉用户的说明，例如 AI 模型不可用、这次改用了经典算法 */
  'heal-notice': [message: string]
  /** 修瑕计算开始 / 结束；单图模式据此暂时禁止切换图片，免得结果写不回去 */
  'busy-change': [busy: boolean]
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
/**
 * 正在输入或修改的文字。坐标是图片本地坐标（文字左上角），输入框按当前缩放换算到屏幕，
 * 字号、颜色与最终效果一致；editingId 不为空表示在改已有文字，绘制时先隐藏原文字。
 */
interface TextDraft {
  imageId: string
  editingId: string | null
  x: number
  y: number
  fontSize: number
  value: string
}
const textDraft = ref<TextDraft | null>(null)
/** 修瑕正在计算：期间不接受新的涂抹与撤销重做。 */
const isHealing = ref(false)
const healProgress = ref(0)
/** 画笔、橡皮擦、修瑕的范围圈位置（视口内坐标）；指针不在画布上时为空。 */
const cursorPoint = ref<{ x: number; y: number } | null>(null)
const undoStack = ref<HistoryEntry[]>([])
const redoStack = ref<HistoryEntry[]>([])
let drawingImage: StitchImage | null = null
let drawingItem: StitchLayout['items'][number] | null = null
let drawingStroke: StrokeAnnotation | null = null
let drawingBefore: StitchAnnotation[] | null = null
let drawingPointerId: number | null = null
/** 「选择」工具下按下的位置；松开时几乎没动就当作点击（用来点文字修改）。 */
let selectPress: { pointerId: number; x: number; y: number } | null = null
let textDragState: {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  scale: number
} | null = null
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
  { value: 'heal', name: '局部修瑕', tip: '局部修瑕（涂抹要去掉的物体，按周围画面补全）', icon: Wand2 },
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

const previewLabel = computed(() =>
  props.singleImage
    ? `单图编辑预览：${props.images[0]?.name ?? ''}，${formatDimensions(props.layout.width, props.layout.height)} 像素`
    : `拼接效果预览，共 ${props.images.length} 张图片，输出尺寸 ${formatDimensions(props.layout.width, props.layout.height)} 像素`,
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
const canUndo = computed(() => undoStack.value.length > 0 && !isHealing.value)
const canRedo = computed(() => redoStack.value.length > 0 && !isHealing.value)
const isPaintingTool = computed(
  () => annotationTool.value === 'brush' || annotationTool.value === 'eraser' || annotationTool.value === 'heal',
)
const healPercent = computed(() => `${Math.round(healProgress.value * 100)}%`)
/** 修瑕进行中提示里的引擎名：开始时记下，计算期间设置变了也不跟着变。 */
const healEngineLabel = ref('')
/** 刚完成的修瑕；在下一次涂抹、撤销重做或改文字前，可一键换成另一种补法。 */
const lastHealed = ref<{ imageId: string; annotationId: string } | null>(null)
const HEAL_FILL_LABELS: Record<HealFill, string> = {
  structure: '结构优先',
  smooth: '平滑优先',
  ai: 'AI 模型',
}
const healChoice = computed(() => {
  const target = lastHealed.value
  if (!target || isHealing.value) {
    return null
  }
  const annotation = findImage(target.imageId)?.annotations.find((item) => item.id === target.annotationId)
  if (annotation?.type !== 'heal' || !annotation.fill || !annotation.alternatePatch) {
    return null
  }
  const other: HealFill = annotation.fill === 'structure' ? 'smooth' : 'structure'
  return { current: HEAL_FILL_LABELS[annotation.fill], other: HEAL_FILL_LABELS[other] }
})

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

/** 图片本地坐标 → 视口内坐标。 */
function toViewport(imageId: string, x: number, y: number): { x: number; y: number } | null {
  const viewport = viewportRef.value
  const item = props.layout.items.find((candidate) => candidate.id === imageId)
  if (!viewport || !item) {
    return null
  }
  const scale = imageToScreen.value
  const contentWidth = displaySize.value.width * zoom.value
  const contentHeight = displaySize.value.height * zoom.value
  return {
    x: (viewport.clientWidth - contentWidth) / 2 + offset.value.x + (item.x + x) * scale,
    y: (viewport.clientHeight - contentHeight) / 2 + offset.value.y + (item.y + y) * scale,
  }
}

/** 输入框直接按最终字号、颜色画在文字位置上，输入即所见；拖动手柄在左侧，确认 / 取消在右侧。 */
const TEXT_GRIP_WIDTH = 20
const textEditorLayout = computed(() => {
  const draft = textDraft.value
  if (!draft) {
    return null
  }
  const origin = toViewport(draft.imageId, draft.x, draft.y)
  if (!origin) {
    return null
  }
  const fontPx = Math.max(6, draft.fontSize * imageToScreen.value)
  const sample = draft.value || '输入文字'
  const width = Math.max(fontPx * 2, measureText(sample, fontPx) + fontPx * 0.4)
  return {
    box: { left: `${origin.x - TEXT_GRIP_WIDTH}px`, top: `${origin.y}px` },
    input: {
      width: `${width}px`,
      height: `${fontPx}px`,
      font: textFont(fontPx),
      lineHeight: `${fontPx}px`,
      color: annotationColor.value,
    },
  }
})

const toolCursorStyle = computed<Record<string, string> | null>(() => {
  const point = cursorPoint.value
  if (!point || !isPaintingTool.value || isHealing.value) {
    return null
  }
  const scale = annotationScale()
  const diameter = getToolDiameter(annotationTool.value, annotationWidth.value, scale) * scale
  return {
    left: `${point.x}px`,
    top: `${point.y}px`,
    width: `${diameter}px`,
    height: `${diameter}px`,
    '--cursor-color': annotationColor.value,
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
  if (isHealing.value) {
    return
  }
  lastHealed.value = null
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
  if (isHealing.value) {
    return
  }
  lastHealed.value = null
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
  commitText()
  annotationTool.value = tool
  viewportRef.value?.focus()
}

function focusTextInput(selectAll = false): void {
  void nextTick(() => {
    textInputRef.value?.focus()
    if (selectAll) {
      textInputRef.value?.select()
    }
  })
}

/** 打开已有文字的编辑：原文字先隐藏，输入框以同样字号、颜色出现在原位。 */
function editExistingText(image: StitchImage, annotation: TextAnnotation): void {
  lastHealed.value = null
  activeImageId.value = image.id
  isHoldingActiveImage = true
  annotationColor.value = annotation.color
  textDraft.value = {
    imageId: image.id,
    editingId: annotation.id,
    x: annotation.x,
    y: annotation.y,
    fontSize: annotation.fontSize,
    value: annotation.text,
  }
  focusTextInput(true)
}

/** 文字工具点击：点中已有文字就修改，否则在点击位置新建。正在输入的内容先确认，不会丢。 */
function openTextEditor(event: PointerEvent): void {
  const hit = imageAtEvent(event)
  commitText()
  if (!hit) {
    return
  }
  const existing = findTextAt(hit.image.annotations, hit.point)
  if (existing) {
    editExistingText(hit.image, existing)
    return
  }
  activeImageId.value = hit.image.id
  textDraft.value = {
    imageId: hit.image.id,
    editingId: null,
    x: hit.point.x,
    y: hit.point.y,
    fontSize: Math.max(16, Math.round(24 / annotationScale())),
    value: '',
  }
  focusTextInput()
}

function cancelText(): void {
  if (!textDraft.value) {
    return
  }
  textDraft.value = null
  scheduleRender()
}

function startTextDrag(event: PointerEvent): void {
  const draft = textDraft.value
  if (!draft || event.button !== 0) {
    return
  }
  event.preventDefault()
  const handle = event.currentTarget
  if (handle instanceof HTMLElement) {
    handle.setPointerCapture(event.pointerId)
  }
  textDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: draft.x,
    originY: draft.y,
    scale: Math.max(0.0001, imageToScreen.value),
  }
}

function moveTextDrag(event: PointerEvent): void {
  const draft = textDraft.value
  if (!draft || !textDragState || event.pointerId !== textDragState.pointerId) {
    return
  }
  const item = props.layout.items.find((candidate) => candidate.id === draft.imageId)
  const maxX = item ? item.width - 1 : Infinity
  const maxY = item ? item.height - 1 : Infinity
  draft.x = Math.min(maxX, Math.max(0, textDragState.originX + (event.clientX - textDragState.startX) / textDragState.scale))
  draft.y = Math.min(maxY, Math.max(0, textDragState.originY + (event.clientY - textDragState.startY) / textDragState.scale))
}

function endTextDrag(event: PointerEvent): void {
  if (!textDragState || event.pointerId !== textDragState.pointerId) {
    return
  }
  const handle = event.currentTarget
  if (handle instanceof HTMLElement && handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId)
  }
  textDragState = null
  focusTextInput()
}

function annotationScale(): number {
  if (!viewportRef.value || props.layout.width <= 0 || displaySize.value.width <= 0) {
    return 1
  }
  return (displaySize.value.width / props.layout.width) * zoom.value
}

/** 确认文字：新建就追加；修改就原位替换（保持图层顺序）；改成空就删除。都记入撤销历史。 */
function commitText(): void {
  const draft = textDraft.value
  if (!draft) {
    return
  }
  textDraft.value = null
  const image = findImage(draft.imageId)
  if (!image) {
    scheduleRender()
    return
  }
  const text = draft.value.trim()
  const original = draft.editingId
    ? image.annotations.find((annotation) => annotation.id === draft.editingId)
    : null
  if (
    original?.type === 'text' &&
    original.text === text &&
    original.x === draft.x &&
    original.y === draft.y &&
    original.color === annotationColor.value &&
    original.fontSize === draft.fontSize
  ) {
    // 打开后没改任何东西：只恢复显示，不记一步撤销。
    scheduleRender()
    return
  }
  const before = cloneAnnotations(image.annotations)
  const next: TextAnnotation = {
    id: draft.editingId ?? createAnnotationId(),
    type: 'text',
    x: draft.x,
    y: draft.y,
    text,
    fontSize: draft.fontSize,
    color: annotationColor.value,
    width: measureText(text, draft.fontSize),
  }
  if (draft.editingId) {
    image.annotations = text
      ? image.annotations.map((annotation) => (annotation.id === draft.editingId ? next : annotation))
      : image.annotations.filter((annotation) => annotation.id !== draft.editingId)
  } else if (text) {
    image.annotations = [...image.annotations, next]
  }
  commitHistory(image.id, before, image.annotations)
  scheduleRender()
}

function beginDrawing(event: PointerEvent): void {
  event.preventDefault()
  if (annotationTool.value === 'text') {
    openTextEditor(event)
    return
  }
  if (isHealing.value) {
    return
  }
  lastHealed.value = null
  commitText()

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

  const width = getToolDiameter(annotationTool.value, annotationWidth.value, annotationScale())
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
    getToolDiameter('eraser', annotationWidth.value, annotationScale()) / 2,
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
  if (drawingImage && drawingBefore && drawingStroke?.type === 'heal') {
    void runHealStroke(drawingImage, drawingStroke, drawingBefore)
  } else if (drawingImage && drawingBefore) {
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
 * 涂抹结束后计算修瑕补丁：计算期间涂抹范围以半透明红色显示，完成后换成补丁并记入撤销历史；
 * 失败则撤掉这次涂抹并提示。
 */
async function runHealStroke(
  image: StitchImage,
  stroke: StrokeAnnotation,
  before: StitchAnnotation[],
): Promise<void> {
  const removeStroke = () => {
    image.annotations = image.annotations.filter((annotation) => annotation.id !== stroke.id)
  }
  let job
  try {
    job = prepareHealJob(image, stroke)
  } catch (error) {
    removeStroke()
    emit('heal-failed', error instanceof Error ? error.message : '无法读取图片像素')
    scheduleRender()
    return
  }
  if (!job) {
    removeStroke()
    scheduleRender()
    return
  }
  isHealing.value = true
  healProgress.value = 0
  scheduleRender()
  try {
    const engine = props.healEngine
    healEngineLabel.value = engine.kind === 'ai' ? engine.label : ''
    const result = await runHeal(job, engine, (fraction) => {
      healProgress.value = fraction
    })
    if (result.notice) {
      emit('heal-notice', result.notice)
    }
    const patch = createHealPatch(job, result.best.rgba)
    const alternatePatch = result.alternate ? createHealPatch(job, result.alternate.rgba) : undefined
    if (findImage(image.id) && image.annotations.some((annotation) => annotation.id === stroke.id)) {
      image.annotations = image.annotations.map((annotation) =>
        annotation.id === stroke.id
          ? {
              ...stroke,
              points: stroke.points.map((point) => ({ ...point })),
              patch,
              fill: result.best.strategy,
              alternatePatch,
            }
          : annotation,
      )
      commitHistory(image.id, before, image.annotations)
      lastHealed.value = { imageId: image.id, annotationId: stroke.id }
    }
  } catch (error) {
    removeStroke()
    emit('heal-failed', error instanceof Error ? error.message : '修瑕计算失败')
  } finally {
    isHealing.value = false
    scheduleRender()
  }
}

/** 把刚完成的修瑕换成另一种补法（两种结果都已算好，不用重算）；记入撤销历史。 */
function swapHealFill(): void {
  const target = lastHealed.value
  if (!target || isHealing.value) {
    return
  }
  const image = findImage(target.imageId)
  const annotation = image?.annotations.find((item) => item.id === target.annotationId)
  if (!image || annotation?.type !== 'heal' || !annotation.patch || !annotation.alternatePatch || !annotation.fill) {
    lastHealed.value = null
    return
  }
  const before = cloneAnnotations(image.annotations)
  const swapped: StrokeAnnotation = {
    ...annotation,
    patch: annotation.alternatePatch,
    alternatePatch: annotation.patch,
    fill: annotation.fill === 'structure' ? 'smooth' : 'structure',
  }
  image.annotations = image.annotations.map((item) => (item.id === annotation.id ? swapped : item))
  commitHistory(image.id, before, image.annotations)
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
  selectPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
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

function updateToolCursor(event: PointerEvent): void {
  const viewport = viewportRef.value
  if (!isPaintingTool.value || !viewport || event.target !== canvasRef.value) {
    cursorPoint.value = null
    return
  }
  const rect = viewport.getBoundingClientRect()
  cursorPoint.value = { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hideToolCursor(): void {
  cursorPoint.value = null
}

function onPointerMove(event: PointerEvent): void {
  updateToolCursor(event)
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

/** 「选择」工具下单击文字：打开修改。拖动平移不算点击。 */
function handleSelectClick(event: PointerEvent): void {
  const press = selectPress
  selectPress = null
  if (!press || press.pointerId !== event.pointerId) {
    return
  }
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
    return
  }
  const hit = imageAtEvent(event)
  const existing = hit ? findTextAt(hit.image.annotations, hit.point) : null
  if (hit && existing) {
    commitText()
    editExistingText(hit.image, existing)
  }
}

function onPointerUp(event: PointerEvent): void {
  if (isDrawing.value && event.pointerId === drawingPointerId) {
    finishDrawing()
    return
  }
  if (annotationTool.value === 'select') {
    handleSelectClick(event)
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
    cancelText()
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
    background: props.background,
    hiddenAnnotationId: textDraft.value?.editingId ?? null,
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
watch(() => props.background, scheduleRender)
// 开始 / 结束修改已有文字时重画：原文字在编辑期间隐藏。
watch(() => textDraft.value?.editingId ?? null, scheduleRender)
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

watch(isHealing, (busy) => emit('busy-change', busy))

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
    commitText()
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
      v-if="images.length > 0 && !thumbnailPanel.collapsed && !singleImage"
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

    <div class="preview-main">
      <!-- 标注栏固定在画布上方、画布之外，不遮挡图片。 -->
      <FloatingToolbar
        v-if="images.length > 0 && !annotationToolbar.collapsed"
        class="annotation-toolbar"
        docked
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

      <div class="preview-stage" :class="{ 'is-file-dragging': isFileDragging }">
        <div
          v-if="images.length > 0"
          ref="viewportRef"
          class="stage-viewport"
          :class="{
            'is-panning': isPanning,
            'is-zoomed': zoom > 1,
            'is-annotating': annotationTool !== 'select',
            'is-painting': isPaintingTool,
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
          @pointerleave="hideToolCursor"
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

          <span
            v-if="toolCursorStyle"
            class="tool-cursor"
            :class="`tool-cursor--${annotationTool}`"
            :style="toolCursorStyle"
            aria-hidden="true"
          />

          <div
            v-if="textDraft && textEditorLayout"
            class="text-editor"
            :style="textEditorLayout.box"
            @pointerdown.stop
            @click.stop
            @dblclick.stop
            @wheel.stop
          >
            <span
              v-tooltip="'拖动移动文字'"
              class="text-editor__grip"
              aria-hidden="true"
              @pointerdown="startTextDrag"
              @pointermove="moveTextDrag"
              @pointerup="endTextDrag"
              @pointercancel="endTextDrag"
            >
              <GripVertical :size="13" :stroke-width="1.9" />
            </span>
            <input
              ref="textInputRef"
              v-model="textDraft.value"
              class="text-editor__input"
              type="text"
              maxlength="120"
              placeholder="输入文字"
              :style="textEditorLayout.input"
              :aria-label="textDraft.editingId ? '修改标注文字' : '标注文字'"
              @keydown.enter.prevent="commitText"
              @keydown.esc.prevent="cancelText"
            />
            <span class="text-editor__actions">
              <button v-tooltip="'确认文字（回车）'" type="button" aria-label="确认文字" @click="commitText">
                <Check :size="14" :stroke-width="2" />
              </button>
              <button v-tooltip="'取消（Esc）'" type="button" aria-label="取消文字" @click="cancelText">
                <X :size="14" :stroke-width="2" />
              </button>
            </span>
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

          <template v-if="singleImage">
            <h2>添加图片，逐张编辑</h2>
            <p>可以一次放进多张，逐张标注、修瑕；导出时能转换格式、压缩，也能按同样设置一次导出全部。</p>
          </template>
          <template v-else>
            <h2>添加图片，开始拼接</h2>
            <p>把多张图片放进队列，纵向或横向拼成一张。可以拖动调整顺序，间距也能随时修改。</p>
          </template>

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

        <div v-if="healChoice" class="stage-busy heal-choice" role="status">
          <Wand2 :size="13" :stroke-width="1.9" />
          <span>已用「{{ healChoice.current }}」补全</span>
          <button
            v-tooltip="'结构优先适合栏杆、窗格等直线重复的结构；平滑优先适合天空、渐变、曲面。两种结果都已算好，可随时换回'"
            class="heal-choice__switch"
            type="button"
            @click="swapHealFill"
          >
            换成{{ healChoice.other }}
          </button>
          <button
            v-tooltip="'关闭'"
            class="heal-choice__close"
            type="button"
            aria-label="关闭补法切换"
            @click="lastHealed = null"
          >
            <X :size="12" :stroke-width="2" />
          </button>
        </div>

        <div v-if="isHealing" class="stage-busy" role="status">
          <Loader2 class="spin" :size="13" :stroke-width="2" />
          <span class="tnum">{{ healEngineLabel ? `正在用 ${healEngineLabel} 修瑕` : '正在修瑕' }} {{ healPercent }}</span>
        </div>

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

/* 画布列：上方是固定的标注栏，下方是点状画布；缩略图在这一列之外。 */
.preview-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

/* 外观由 FloatingToolbar（docked）负责；z-index 让粗细预览浮在画布之上。 */
.annotation-toolbar {
  z-index: 4;
  flex: 0 0 auto;
  align-self: flex-start;
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

/* 文字编辑：输入框就是最终效果（字号、颜色、位置都一致），只加一圈虚线框表示正在编辑。 */
.text-editor {
  position: absolute;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  cursor: default;
}

.text-editor__grip {
  display: inline-flex;
  width: 14px;
  height: 22px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--text-muted);
  cursor: grab;
  touch-action: none;
}

.text-editor__input {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  outline: 1px dashed var(--accent);
  outline-offset: 3px;
}

.text-editor__input::placeholder {
  color: var(--text-faint);
}

.text-editor__actions {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow-xs);
}

.text-editor button {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-muted);
}

.text-editor button:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

/* 画笔、橡皮擦、修瑕的实际作用范围：圈的直径就是落笔的真实直径。 */
.stage-viewport.is-painting .preview-canvas {
  cursor: none;
}

.tool-cursor {
  position: absolute;
  z-index: 4;
  border-radius: 50%;
  pointer-events: none;
  transform: translate(-50%, -50%);
}

.tool-cursor::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-strong);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
  content: '';
  transform: translate(-50%, -50%);
}

.tool-cursor--brush {
  border: 1px solid rgba(255, 255, 255, 0.95);
  background: var(--cursor-color);
  box-shadow: 0 0 0 1px rgba(19, 32, 28, 0.55);
  opacity: 0.55;
}

.tool-cursor--eraser {
  border: 1.5px dashed var(--text-strong);
  background: rgba(255, 255, 255, 0.28);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85);
}

.tool-cursor--heal {
  border: 1.5px solid rgba(217, 45, 32, 0.9);
  background: rgba(217, 45, 32, 0.22);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85);
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

.heal-choice {
  padding: 4px 6px 4px 10px;
}

.heal-choice__switch {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--accent-line-strong);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10.5px;
  font-weight: 600;
}

.heal-choice__switch:hover {
  background: var(--accent-soft-strong);
}

.heal-choice__close {
  display: inline-flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--text-muted);
}

.heal-choice__close:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
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
