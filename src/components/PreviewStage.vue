<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  BringToFront,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsRight,
  ChevronsUp,
  Columns2,
  Crop,
  Eraser,
  FilePlus2,
  GripVertical,
  ImageMinus,
  ImagePlus,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Paintbrush,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  SendToBack,
  Sparkles,
  Type,
  Undo2,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-vue-next'
import FloatingToolbar from './FloatingToolbar.vue'
import SharpenPanel from './SharpenPanel.vue'
import { releaseCanvas } from '../core/exportJob'
import { DEFAULT_AI_SHARPEN_LEVEL, allowedResolutions, defaultResolution } from '../core/aiUpscale'
import type { AiSharpenLevel } from '../core/aiUpscale'
import { DEFAULT_SHARPEN, isSharpenNoop } from '../core/sharpen'
import type { SharpenSettings } from '../core/sharpen'
import { AiCanceledError, cancelAiJobs } from '../core/aiWorkerClient'
import {
  aiSharpenImage,
  estimateAiSharpenSeconds,
  probeAiModel,
  sharpenImage,
} from '../core/sharpenEngine'
import type { AiModelChoice, AiModelInfo, SharpenAiState } from '../core/sharpenEngine'
import { useCutout } from '../composables/useCutout'
import { useFileDrop } from '../composables/useFileDrop'
import { applySelection, removeBackground } from '../core/matteEngine'
import type { MatteModelChoice, SegmentModelChoice } from '../core/matteEngine'
import type { CutoutMode } from '../core/matte'
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
import { formatDimensions, getBaseSource, releaseMatteComposite } from '../core/image'
import {
  RESIZE_HANDLES,
  applyCrop,
  cropByHandle,
  displayScale,
  displayToSource,
  identityTransform,
  moveCrop,
  normalizeTransform,
  resizeByHandle,
  resizeByInput,
  scalePercent,
  sourceToDisplay,
  transformOf,
  uncroppedPreview,
} from '../core/imageTransform'
import type { ContentTransform, Rect, ResizeHandle } from '../core/imageTransform'
import {
  clampPreviewOffset,
  getFocusOffset,
  getImageFillZoom,
  getMaxPreviewZoom,
  getPreviewFit,
  keepScaleAfterResize,
} from '../core/preview'
import { clampCanvasSide, clampDragDelta, moveLayer, paintOrder, snapMove } from '../core/layout'
import type { CanvasSize, LayerAction } from '../core/layout'
import { renderStitchView } from '../core/render'
import { THUMBNAIL_SIZE_PX } from '../core/settings'
import type {
  ThumbnailFit,
  ThumbnailOrientation,
  ThumbnailSize,
  PanelKey,
  PanelState,
  SharpenEngine,
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
  ImageEnhance,
  ImageMatte,
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
  /** 清晰化面板默认用的方式（随设置保存） */
  sharpenEngine: SharpenEngine
  /** 可选的 AI 清晰化模型及各自能不能用（由 App 按模型下载状态算出） */
  aiModels: AiModelChoice[]
  /** 当前选的 AI 模型编号（随设置保存） */
  aiModelKey: string
  /** 这次修瑕用经典算法还是 AI 模型（由 App 按设置与模型下载状态算出） */
  healEngine: HealEngineChoice
  /** 去除背景用的模型及能不能用（由 App 按设置与模型下载状态算出） */
  matteModel: MatteModelChoice
  /** 点选抠图用的模型及能不能用 */
  segmentModel: SegmentModelChoice
  /** 整张拼接图的缩放与裁剪（布局 layout 已按它换算好）；单图编辑或原样时为 null */
  frame?: ContentTransform | null
  /** 拼接布局原本的尺寸（整张调整的「原图」）；单图编辑时为 null */
  baseSize?: { width: number; height: number } | null
  /** 手动设定的画布尺寸；null 表示贴合内容。单图编辑时为 null */
  canvasSize?: CanvasSize | null
  /** 按方向、间距自动排出来的内容尺寸（画布贴合内容时的大小）；单图编辑时为 null */
  contentSize?: { width: number; height: number } | null
  /** 拼接时拖动图片是否吸附 */
  snap?: boolean
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
  'active-change': [id: string | null]
  'resize-blank': [id: string, width: number, height: number]
  /** 调整工具改了一张图的缩放 / 裁剪；null 表示还原 */
  'set-transform': [id: string, transform: ContentTransform | null]
  /** 调整工具改了整张拼接图的缩放 / 裁剪；null 表示还原 */
  'set-frame': [transform: ContentTransform | null]
  /** 拼接时拖动了一张图：相对自动位置的位移（布局像素）；null 表示归位 */
  'set-position': [id: string, position: { x: number; y: number } | null]
  /** 拼接时调整了图层：从下往上的图片编号顺序 */
  'set-layers': [order: string[]]
  /** 改了画布尺寸；null 表示贴合内容 */
  'set-canvas': [canvas: CanvasSize | null]
  'update-snap': [snap: boolean]
  'update-panel': [key: PanelKey, state: PanelState]
  'heal-failed': [message: string]
  /** 修瑕成功但需要告诉用户的说明，例如 AI 模型不可用、这次改用了经典算法 */
  'heal-notice': [message: string]
  /** 修瑕计算开始 / 结束；单图模式据此暂时禁止切换图片，免得结果写不回去 */
  'busy-change': [busy: boolean]
  'sharpen-failed': [message: string]
  /** 抠图 / 去除背景的结果说明或不能用的原因 */
  'matte-notice': [message: string]
  'matte-failed': [message: string]
  'update-sharpen-engine': [engine: SharpenEngine]
  'update-sharpen-model': [key: string]
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
/** 清晰化面板是否打开、面板里显示的参数、正在计算的张数与进度 */
const isSharpenOpen = ref(false)
const sharpenDraft = ref<SharpenSettings>({ ...DEFAULT_SHARPEN })
const aiSharpenLevel = ref<AiSharpenLevel>(DEFAULT_AI_SHARPEN_LEVEL)
/** AI 结果保留原图的几倍（1 原尺寸、2、4）；默认 2 倍，做不到时退回能做的 */
const aiResolution = ref(2)
/** 各模型试算出的倍数（自定义模型第一次用时才知道）；error 为试算失败的原因 */
const aiModelInfos = ref<Record<string, AiModelInfo | { error: string } | 'probing'>>({})
/** 每跑完一次 AI 清晰化就 +1，让预计耗时按新测的速度重算 */
const aiSpeedVersion = ref(0)
const sharpenRunning = ref(0)
const sharpenProgress = ref(0)
/** 前后对比：打开后画布上出现中线，左边画原图 */
const isComparing = ref(false)
const compareSplit = ref(0.5)
let sharpenTimer: ReturnType<typeof setTimeout> | undefined
/** 每张图最新一次清晰化请求的编号，旧请求的结果到了直接丢掉 */
const sharpenTokens = new Map<string, number>()
let compareDrag: { pointerId: number } | null = null
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
  /** 屏幕像素 / 原图像素（两个方向，图片拉伸过时不同） */
  scaleX: number
  scaleY: number
} | null = null
/** 调整工具：拖手柄与输入宽高时是否保持比例 */
const adjustKeepRatio = ref(true)
/** 正在裁剪：original 是进入裁剪前的变换（取消时恢复），crop 是裁剪框（原图像素） */
const cropDraft = ref<{
  kind: AdjustKind
  targetId: string
  original: ContentTransform | null
  crop: Rect
} | null>(null)
/** 拼接时调整的对象：选中的那张，或整张拼接图 */
const adjustScope = ref<AdjustKind>('image')
/** 拖动调整手柄或裁剪框 */
let adjustDrag: {
  pointerId: number
  target: ResizeHandle | 'move'
  startX: number
  startY: number
  start: ContentTransform
  startCrop: Rect | null
  /** 布局像素 → 屏幕像素 */
  scale: number
} | null = null
/** 调整工具下拖动选中的图片换位置（拼接时） */
let moveDrag: {
  pointerId: number
  imageId: string
  startX: number
  startY: number
  /** 拖动开始时的位移（拼接布局像素，整张缩放前） */
  startPosition: { x: number; y: number }
  /** 拖动开始时图片在预览布局里的框 */
  rect: Rect
  /** 预览布局像素 → 屏幕像素 */
  scale: number
  /** 整张拼接图的缩放：预览布局像素 / 拼接布局像素 */
  frameScale: { x: number; y: number }
  moved: boolean
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

type AdjustKind = 'image' | 'whole'

/** 调整工具作用的对象：一张图（原图尺寸 + 它的变换）或整张拼接图（布局尺寸 + 整张变换） */
interface AdjustSubject {
  kind: AdjustKind
  id: string
  size: { width: number; height: number }
  transform: ContentTransform
  /** 原样之外有没有调整过 */
  isTransformed: boolean
  image: StitchImage | null
}

const WHOLE_ID = '__whole__'

interface HistoryEntry {
  imageId: string
  before: StitchAnnotation[]
  after: StitchAnnotation[]
  /** 抠图 / 去除背景这一步：遮罩前后（null 表示整张不透明）；有它时标注不变 */
  matte?: { before: ImageMatte | null; after: ImageMatte | null }
}

/** 撤销记录里最多留几步抠图（每步一张原图尺寸的遮罩画布，占内存） */
const MAX_MATTE_HISTORY = 5

interface AnnotationToolOption {
  value: AnnotationTool
  /** 无障碍名称 */
  name: string
  /** 悬浮提示 */
  tip: string
  icon: Component
}

const LAYER_ACTIONS: Array<{ value: LayerAction; name: string; icon: Component }> = [
  { value: 'top', name: '置于顶层', icon: BringToFront },
  { value: 'up', name: '上移一层', icon: ChevronUp },
  { value: 'down', name: '下移一层', icon: ChevronDown },
  { value: 'bottom', name: '置于底层', icon: SendToBack },
]

const ANNOTATION_TOOLS: AnnotationToolOption[] = [
  { value: 'select', name: '选择与平移', tip: '选择与平移', icon: MousePointer2 },
  { value: 'text', name: '添加文字', tip: '添加文字', icon: Type },
  { value: 'brush', name: '画笔', tip: '画笔', icon: Paintbrush },
  { value: 'eraser', name: '橡皮擦', tip: '橡皮擦（只擦标注，不改原图）', icon: Eraser },
  { value: 'heal', name: '局部修瑕', tip: '局部修瑕（涂抹要去掉的物体，按周围画面补全）', icon: Wand2 },
  {
    value: 'cutout',
    name: '抠图',
    tip: '抠图（点要保留的物体，可选细部 / 部位 / 整体；Alt + 点击排除）',
    icon: Scissors,
  },
  {
    value: 'adjust',
    name: '调整',
    tip: '调整（拖手柄缩放，拼接时拖动图片换位置、调图层，或裁剪、还原；原图不变）',
    icon: Crop,
  },
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
/** 清晰化作用的图片：单图编辑是当前这张，拼接是预览里选中的那张 */
const sharpenTarget = computed<StitchImage | null>(() =>
  props.singleImage ? (props.images[0] ?? null) : activeImage.value,
)
/** 调整工具作用的图片：单图编辑是当前这张，拼接是选中的那张；空白页有自己的尺寸面板，不在这里调整 */
const adjustImage = computed<StitchImage | null>(() => {
  const target = annotationTool.value === 'adjust' ? sharpenTarget.value : null
  return target?.kind === 'image' ? target : null
})
const adjustSubject = computed<AdjustSubject | null>(() => {
  if (annotationTool.value !== 'adjust') {
    return null
  }
  if (!props.singleImage && adjustScope.value === 'whole') {
    const size = props.baseSize
    if (!size || size.width <= 0 || size.height <= 0) {
      return null
    }
    return {
      kind: 'whole',
      id: WHOLE_ID,
      size,
      transform: props.frame ?? identityTransform(size),
      isTransformed: Boolean(props.frame),
      image: null,
    }
  }
  const image = adjustImage.value
  return image
    ? {
        kind: 'image',
        id: image.id,
        size: { width: image.width, height: image.height },
        transform: transformOf(image),
        isTransformed: Boolean(image.transform),
        image,
      }
    : null
})
/** 整个内容（整张拼接图）在视口里的框 */
function contentViewportRect(): Rect | null {
  const viewport = viewportRef.value
  if (!viewport || displaySize.value.width <= 0) {
    return null
  }
  const width = displaySize.value.width * zoom.value
  const height = displaySize.value.height * zoom.value
  return {
    x: (viewport.clientWidth - width) / 2 + offset.value.x,
    y: (viewport.clientHeight - height) / 2 + offset.value.y,
    width,
    height,
  }
}
const adjustRect = computed(() => {
  const subject = adjustSubject.value
  if (!subject) {
    return null
  }
  return subject.kind === 'whole' ? contentViewportRect() : itemViewportRect(subject.id)
})
const adjustBoxStyle = computed(() => (adjustRect.value ? rectStyle(adjustRect.value) : null))
/** 裁剪框相对选框的位置（像素） */
const cropFrameStyle = computed<Record<string, string> | null>(() => {
  const draft = cropDraft.value
  const subject = adjustSubject.value
  const box = adjustRect.value
  if (!draft || !subject || !box || draft.targetId !== subject.id) {
    return null
  }
  const transform = subject.transform
  // 选框像素 / 显示像素（整张图缩放过时，单张图在选框里还要再乘这一层）
  const scaleX = box.width / transform.width
  const scaleY = box.height / transform.height
  const origin = sourceToDisplay(transform, { x: draft.crop.x, y: draft.crop.y })
  const factor = displayScale(transform)
  return rectStyle({
    x: origin.x * scaleX,
    y: origin.y * scaleY,
    width: draft.crop.width * factor.x * scaleX,
    height: draft.crop.height * factor.y * scaleY,
  })
})
const adjustInfo = computed(() => {
  const subject = adjustSubject.value
  if (!subject) {
    return null
  }
  const { transform } = subject
  return {
    width: transform.width,
    height: transform.height,
    percent: scalePercent(transform),
    isTransformed: subject.isTransformed,
  }
})

const sharpenDisabledReason = computed(() => {
  const target = sharpenTarget.value
  if (!target) {
    return '先选中一张图片：点左侧卡片，或把它移到画面中间。'
  }
  if (target.kind === 'blank') {
    return '空白页不需要清晰化；选中一张图片再试。'
  }
  if (!target.element) {
    return '图片还没读完，请稍候。'
  }
  return ''
})
const comparePercent = computed(() => Math.round(compareSplit.value * 100))
const aiChoice = computed(
  () => props.aiModels.find((choice) => choice.key === props.aiModelKey) ?? props.aiModels[0] ?? null,
)
const aiState = computed<SharpenAiState>(
  () => aiChoice.value?.state ?? { ready: false, reason: '没有可用的 AI 模型' },
)
/** 选中模型的倍数：内置模型登记过；自定义模型要等试算完 */
const aiModelScale = computed(() => {
  const state = aiState.value
  if (!state.ready) {
    return null
  }
  if (state.model.scale !== null) {
    return state.model.scale
  }
  const info = aiModelInfos.value[state.model.key]
  return info && typeof info === 'object' && 'scale' in info ? info.scale : null
})
/** 选中模型试算中、或试算失败的原因 */
const aiModelNote = computed(() => {
  const state = aiState.value
  if (!state.ready || state.model.scale !== null) {
    return ''
  }
  const info = aiModelInfos.value[state.model.key]
  if (info === 'probing' || info === undefined) {
    return '正在识别这个模型的放大倍数…'
  }
  return 'error' in info ? `这个模型用不了：${info.error}` : `已识别：×${info.scale}`
})
const aiAllowedResolutions = computed(() => {
  const target = sharpenTarget.value
  const scale = aiModelScale.value
  return target && scale ? allowedResolutions(target.width, target.height, aiSharpenLevel.value, scale) : []
})
const aiEstimateSeconds = computed(() => {
  void aiSpeedVersion.value
  const target = sharpenTarget.value
  const key = aiChoice.value?.key ?? ''
  return target?.element
    ? estimateAiSharpenSeconds(target.width, target.height, aiSharpenLevel.value, key)
    : 0
})
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

/** 一张图在视口里占的框（视口内像素）；选框、手柄、裁剪框都按它定位。 */
function itemViewportRect(id: string | null | undefined): Rect | null {
  const viewport = viewportRef.value
  const item = id ? props.layout.items.find((candidate) => candidate.id === id) : null
  if (!viewport || !item) {
    return null
  }
  const scale = imageToScreen.value
  const contentWidth = displaySize.value.width * zoom.value
  const contentHeight = displaySize.value.height * zoom.value
  return {
    x: (viewport.clientWidth - contentWidth) / 2 + offset.value.x + item.x * scale,
    y: (viewport.clientHeight - contentHeight) / 2 + offset.value.y + item.y * scale,
    width: item.width * scale,
    height: item.height * scale,
  }
}

function rectStyle(rect: Rect): Record<string, string> {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
}

const blankSelectionStyle = computed<Record<string, string> | null>(() => {
  const rect = activeBlank.value ? itemViewportRect(activeItem.value?.id) : null
  return rect ? rectStyle(rect) : null
})

/** 原图坐标 → 视口内坐标（按这张图的缩放与裁剪换算）。 */
function toViewport(imageId: string, x: number, y: number): { x: number; y: number } | null {
  const rect = itemViewportRect(imageId)
  const image = findImage(imageId)
  if (!rect || !image) {
    return null
  }
  const transform = transformOf(image)
  const local = sourceToDisplay(transform, { x, y })
  return {
    x: rect.x + (local.x * rect.width) / transform.width,
    y: rect.y + (local.y * rect.height) / transform.height,
  }
}

/** 布局像素 / 图片显示像素：整张拼接图缩放过时不是 1。 */
function itemFactor(image: StitchImage | null): { x: number; y: number } {
  const item = image ? props.layout.items.find((candidate) => candidate.id === image.id) : null
  if (!image || !item) {
    return { x: 1, y: 1 }
  }
  const transform = transformOf(image)
  return { x: item.width / transform.width, y: item.height / transform.height }
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
  const draftImage = findImage(draft.imageId)
  const fontPx = Math.max(
    6,
    draft.fontSize *
      imageToScreen.value *
      (draftImage ? displayScale(transformOf(draftImage)).y * itemFactor(draftImage).y : 1),
  )
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
  const image = findImage(item.id)
  return toSourcePoint(image, item, localX - item.x, localY - item.y)
}

/** 图片框内的显示坐标 → 原图坐标（标注、修瑕都记在原图坐标里），限制在原图范围内。 */
function toSourcePoint(
  image: StitchImage | null,
  item: StitchLayout['items'][number],
  x: number,
  y: number,
): AnnotationPoint {
  const local = { x: Math.max(0, Math.min(item.width, x)), y: Math.max(0, Math.min(item.height, y)) }
  if (!image) {
    return local
  }
  const factor = itemFactor(image)
  const source = displayToSource(transformOf(image), { x: local.x / factor.x, y: local.y / factor.y })
  return {
    x: Math.max(0, Math.min(image.width, source.x)),
    y: Math.max(0, Math.min(image.height, source.y)),
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

  // 画布外的部分已被裁掉，点不到；重叠时最上层的先命中。
  if (layoutX < 0 || layoutY < 0 || layoutX > props.layout.width || layoutY > props.layout.height) {
    return null
  }
  const ordered = paintOrder(props.layout.items)
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index]
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
        point: toSourcePoint(image, item, layoutX - item.x, layoutY - item.y),
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
    if (entry.matte) {
      replaceMatte(image, entry.matte.before)
    } else {
      image.annotations = cloneAnnotations(entry.before)
    }
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
    if (entry.matte) {
      replaceMatte(image, entry.matte.after)
    } else {
      image.annotations = cloneAnnotations(entry.after)
    }
    undoStack.value.push(entry)
    scheduleRender()
    return
  }
}

/** 换上另一份遮罩（或去掉），释放旧遮罩的合成画面；遮罩画布本身可能还在撤销记录里。 */
function replaceMatte(image: StitchImage, matte: ImageMatte | null): void {
  releaseMatteComposite(image.matte?.mask)
  image.matte = matte ?? undefined
  scheduleRender()
}

/** 抠图 / 去除背景改了遮罩：换上并记进撤销记录（Ctrl+Z 可撤回）。 */
function setMatte(image: StitchImage, mask: HTMLCanvasElement | null, source: ImageMatte['source']): void {
  const before = image.matte ?? null
  const after: ImageMatte | null = mask ? markRaw({ source, mask: markRaw(mask) }) : null
  if (!before && !after) {
    return
  }
  replaceMatte(image, after)
  undoStack.value.push({
    imageId: image.id,
    before: image.annotations,
    after: image.annotations,
    matte: { before, after },
  })
  // 抠图步骤只留最近几步，再早的从撤销记录里拿掉。
  const matteEntries = undoStack.value.filter((entry) => entry.matte)
  if (matteEntries.length > MAX_MATTE_HISTORY) {
    const oldest = matteEntries[0]
    undoStack.value = undoStack.value.filter((entry) => entry !== oldest)
  }
  if (undoStack.value.length > MAX_HISTORY) {
    undoStack.value.shift()
  }
  redoStack.value = []
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
    fontSize: Math.max(16, Math.round(24 / annotationScale(hit.image))),
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
  const draftImage = findImage(draft.imageId)
  const imageScale = draftImage ? displayScale(transformOf(draftImage)) : { x: 1, y: 1 }
  const factor = itemFactor(draftImage)
  textDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: draft.x,
    originY: draft.y,
    scaleX: Math.max(0.0001, imageToScreen.value * imageScale.x * factor.x),
    scaleY: Math.max(0.0001, imageToScreen.value * imageScale.y * factor.y),
  }
}

function moveTextDrag(event: PointerEvent): void {
  const draft = textDraft.value
  if (!draft || !textDragState || event.pointerId !== textDragState.pointerId) {
    return
  }
  const image = findImage(draft.imageId)
  const maxX = image ? image.width - 1 : Infinity
  const maxY = image ? image.height - 1 : Infinity
  draft.x = Math.min(maxX, Math.max(0, textDragState.originX + (event.clientX - textDragState.startX) / textDragState.scaleX))
  draft.y = Math.min(maxY, Math.max(0, textDragState.originY + (event.clientY - textDragState.startY) / textDragState.scaleY))
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

/** 屏幕像素 / 原图像素：给了图片时再乘上它的缩放（拉伸时取两个方向的几何平均）。 */
function annotationScale(image?: StitchImage | null): number {
  if (!viewportRef.value || props.layout.width <= 0 || displaySize.value.width <= 0) {
    return 1
  }
  const layoutScale = (displaySize.value.width / props.layout.width) * zoom.value
  if (!image) {
    return layoutScale
  }
  const scale = displayScale(transformOf(image))
  const factor = itemFactor(image)
  return layoutScale * Math.sqrt(scale.x * factor.x * scale.y * factor.y)
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

  const width = getToolDiameter(annotationTool.value, annotationWidth.value, annotationScale(hit.image))
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
    getToolDiameter('eraser', annotationWidth.value, annotationScale(drawingImage)) / 2,
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
  keepScaleBeforeResize()
  emit('resize-blank', id, width, height)
}

/** 改布局尺寸前记下屏幕比例与平移，下一帧按它调整，其他图片在屏幕上不跳。 */
function keepScaleBeforeResize(): void {
  isHoldingActiveImage = true
  if (!pendingScaleKeep && displaySize.value.width > 0) {
    pendingScaleKeep = {
      scale: imageToScreen.value,
      offset: { ...offset.value },
      size: { width: props.layout.width, height: props.layout.height },
    }
  }
}

/** 调整工具改缩放 / 裁剪的唯一入口：一张图交给 set-transform，整张交给 set-frame；等于原样时按还原处理。 */
function requestTransform(kind: AdjustKind, id: string, transform: ContentTransform | null): void {
  keepScaleBeforeResize()
  if (kind === 'whole') {
    emit('set-frame', transform)
    return
  }
  const image = findImage(id)
  if (image) {
    emit('set-transform', image.id, transform ? normalizeTransform(image, transform) : null)
  }
}

function subjectSize(kind: AdjustKind, id: string): { width: number; height: number } | null {
  if (kind === 'whole') {
    return props.baseSize ?? null
  }
  const image = findImage(id)
  return image ? { width: image.width, height: image.height } : null
}

function startAdjustDrag(target: ResizeHandle | 'move', event: PointerEvent): void {
  const subject = adjustSubject.value
  const box = adjustRect.value
  if (!subject || !box || event.button !== 0 || isHealing.value) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const element = event.currentTarget
  if (element instanceof HTMLElement) {
    element.setPointerCapture(event.pointerId)
  }
  adjustDrag = {
    pointerId: event.pointerId,
    target,
    startX: event.clientX,
    startY: event.clientY,
    start: subject.transform,
    startCrop: cropDraft.value ? { ...cropDraft.value.crop } : null,
    // 屏幕像素 / 显示像素
    scale: Math.max(0.0001, box.width / subject.transform.width),
  }
}

function moveAdjustDrag(event: PointerEvent): void {
  const drag = adjustDrag
  const subject = adjustSubject.value
  if (!drag || !subject || drag.pointerId !== event.pointerId) {
    return
  }
  const dxDisplay = (event.clientX - drag.startX) / drag.scale
  const dyDisplay = (event.clientY - drag.startY) / drag.scale
  const draft = cropDraft.value
  if (draft && drag.startCrop) {
    const scale = displayScale(drag.start)
    const dx = dxDisplay / scale.x
    const dy = dyDisplay / scale.y
    const crop =
      drag.target === 'move'
        ? moveCrop(drag.startCrop, dx, dy, subject.size)
        : cropByHandle(drag.startCrop, drag.target, dx, dy, subject.size, adjustKeepRatio.value)
    cropDraft.value = { ...draft, crop }
    return
  }
  if (drag.target === 'move') {
    return
  }
  // 居中排列的方向上会向两侧同时变，按 2 倍换算，手柄才跟得上指针（同空白页）；整张图在视口里两个方向都居中。
  const widthFactor = subject.kind === 'whole' || props.layout.direction === 'vertical' ? 2 : 1
  const heightFactor = subject.kind === 'whole' || props.layout.direction === 'horizontal' ? 2 : 1
  const size = resizeByHandle(
    { width: drag.start.width, height: drag.start.height },
    drag.target,
    dxDisplay * widthFactor,
    dyDisplay * heightFactor,
    adjustKeepRatio.value,
  )
  requestTransform(subject.kind, subject.id, { ...drag.start, width: size.width, height: size.height })
}

function endAdjustDrag(event: PointerEvent): void {
  if (!adjustDrag || adjustDrag.pointerId !== event.pointerId) {
    return
  }
  const element = event.currentTarget
  if (element instanceof HTMLElement && element.hasPointerCapture(event.pointerId)) {
    element.releasePointerCapture(event.pointerId)
  }
  adjustDrag = null
}

/** 输入宽、高或百分比；保持比例时另一边跟着变。 */
function applyAdjustInput(kind: 'width' | 'height' | 'percent', event: Event): void {
  const subject = adjustSubject.value
  const input = event.target as HTMLInputElement
  if (!subject) {
    return
  }
  const { transform } = subject
  const value = Number(input.value)
  if (!Number.isFinite(value) || value <= 0) {
    input.value = String(kind === 'percent' ? scalePercent(transform) : transform[kind])
    return
  }
  const size = resizeByInput(transform, { [kind]: value }, adjustKeepRatio.value)
  requestTransform(subject.kind, subject.id, { ...transform, ...size })
}

/** 进入裁剪：先按原比例显示整个内容，裁剪框落在原来的裁剪区域上。 */
function startCrop(): void {
  const subject = adjustSubject.value
  if (!subject || cropDraft.value) {
    return
  }
  const current = subject.transform
  cropDraft.value = {
    kind: subject.kind,
    targetId: subject.id,
    original: subject.isTransformed ? current : null,
    crop: { ...current.crop },
  }
  requestTransform(subject.kind, subject.id, uncroppedPreview(current, subject.size))
}

function applyCropDraft(): void {
  const draft = cropDraft.value
  const size = draft ? subjectSize(draft.kind, draft.targetId) : null
  cropDraft.value = null
  if (!draft || !size) {
    return
  }
  requestTransform(draft.kind, draft.targetId, applyCrop(draft.original ?? identityTransform(size), draft.crop))
}

function cancelCrop(): void {
  const draft = cropDraft.value
  cropDraft.value = null
  if (draft && subjectSize(draft.kind, draft.targetId)) {
    requestTransform(draft.kind, draft.targetId, draft.original)
  }
}

/** 还原：去掉缩放与裁剪，标注、修瑕回到原位；之后整张回到窗口里看。 */
function restoreTransform(): void {
  const subject = adjustSubject.value
  if (!subject) {
    return
  }
  cropDraft.value = null
  if (props.singleImage || subject.kind === 'whole') {
    // 还原后的大图沿用缩放时的屏幕比例会超出窗口，改为适应窗口。
    if (subject.kind === 'whole') {
      emit('set-frame', null)
    } else {
      emit('set-transform', subject.id, null)
    }
    resetView()
    return
  }
  requestTransform(subject.kind, subject.id, null)
}

/** 拼接时选中的那张可以拖动换位置、调图层（单张调整、不在裁剪时）。 */
const movableImage = computed<StitchImage | null>(() =>
  !props.singleImage && adjustScope.value === 'image' && !cropDraft.value ? (adjustSubject.value?.image ?? null) : null,
)
/** 从下往上的绘制顺序 */
const layerOrder = computed(() => paintOrder(props.layout.items).map((item) => item.id))

function canMoveLayer(action: LayerAction): boolean {
  const image = movableImage.value
  return Boolean(image && moveLayer(layerOrder.value, image.id, action))
}

function applyLayer(action: LayerAction): void {
  const image = movableImage.value
  const next = image ? moveLayer(layerOrder.value, image.id, action) : null
  if (next) {
    isHoldingActiveImage = true
    emit('set-layers', next)
  }
}

function resetPosition(): void {
  const image = movableImage.value
  if (image?.position) {
    isHoldingActiveImage = true
    emit('set-position', image.id, null)
  }
}

function startMoveDrag(event: PointerEvent): void {
  const image = movableImage.value
  const item = image ? props.layout.items.find((candidate) => candidate.id === image.id) : null
  if (!image || !item || event.button !== 0 || isHealing.value) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  moveDrag = {
    pointerId: event.pointerId,
    imageId: image.id,
    startX: event.clientX,
    startY: event.clientY,
    startPosition: { ...(image.position ?? { x: 0, y: 0 }) },
    rect: { x: item.x, y: item.y, width: item.width, height: item.height },
    scale: Math.max(0.0001, imageToScreen.value),
    frameScale: props.frame ? displayScale(props.frame) : { x: 1, y: 1 },
    moved: false,
  }
}

function moveMoveDrag(event: PointerEvent): void {
  const drag = moveDrag
  if (!drag || drag.pointerId !== event.pointerId) {
    return
  }
  const screenDx = event.clientX - drag.startX
  const screenDy = event.clientY - drag.startY
  if (!drag.moved && Math.hypot(screenDx, screenDy) <= 4) {
    return
  }
  drag.moved = true
  const bounds = { width: props.layout.width, height: props.layout.height }
  let dx = screenDx / drag.scale
  let dy = screenDy / drag.scale
  snapGuides.value = null
  // 吸附：边或中线离其他图片、画布的边与中线不到 8 个屏幕像素就贴上去；按住 Alt 临时不吸附。
  if (props.snap && !event.altKey) {
    const others = props.layout.items.filter((item) => item.id !== drag.imageId)
    const snapped = snapMove(drag.rect, dx, dy, others, bounds, SNAP_SCREEN_PX / drag.scale)
    dx = snapped.dx
    dy = snapped.dy
    snapGuides.value =
      snapped.guideX === null && snapped.guideY === null ? null : { x: snapped.guideX, y: snapped.guideY }
  }
  // 画布大小不变：拖出去的部分会被裁掉，但至少留一条在画布里，免得再也点不到。
  const delta = clampDragDelta(drag.rect, dx, dy, bounds)
  isHoldingActiveImage = true
  emit('set-position', drag.imageId, {
    x: Math.round(drag.startPosition.x + delta.dx / drag.frameScale.x),
    y: Math.round(drag.startPosition.y + delta.dy / drag.frameScale.y),
  })
}

function endMoveDrag(event: PointerEvent): void {
  const drag = moveDrag
  if (!drag || drag.pointerId !== event.pointerId) {
    return
  }
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  moveDrag = null
  snapGuides.value = null
  // 没拖动只是点了一下：按点选处理，重叠时可以点中上面那张。
  if (!drag.moved) {
    selectPress = { pointerId: event.pointerId, x: drag.startX, y: drag.startY }
    handleAdjustClick(event)
  }
}

/** 吸附距离（屏幕像素） */
const SNAP_SCREEN_PX = 8
/** 拖动时吸附上的参考线（预览布局坐标） */
const snapGuides = ref<{ x: number | null; y: number | null } | null>(null)

/** 选中那张在画布里的位置和大小（输出像素，已含整张缩放裁剪） */
const movableMetrics = computed(() => {
  const image = movableImage.value
  const item = image ? props.layout.items.find((candidate) => candidate.id === image.id) : null
  return item
    ? { x: Math.round(item.x), y: Math.round(item.y), width: Math.round(item.width), height: Math.round(item.height) }
    : null
})

/** 输入 X / Y：把选中那张移到画布里的这个位置（输出像素）。 */
function applyPositionInput(axis: 'x' | 'y', event: Event): void {
  const image = movableImage.value
  const metrics = movableMetrics.value
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (!image || !metrics) {
    return
  }
  if (!Number.isFinite(value)) {
    input.value = String(metrics[axis])
    return
  }
  const frameScale = props.frame ? displayScale(props.frame) : { x: 1, y: 1 }
  const start = image.position ?? { x: 0, y: 0 }
  const shift = (Math.round(value) - metrics[axis]) / frameScale[axis]
  isHoldingActiveImage = true
  emit('set-position', image.id, { ...start, [axis]: Math.round(start[axis] + shift) })
}

/** 选中图片的参考线：在视口里的位置 */
const snapGuideStyles = computed(() => {
  const guides = snapGuides.value
  const box = contentViewportRect()
  if (!guides || !box) {
    return []
  }
  const scale = box.width / Math.max(1, props.layout.width)
  const styles: Array<{ key: string; style: Record<string, string> }> = []
  if (guides.x !== null) {
    styles.push({ key: 'x', style: { left: `${box.x + guides.x * scale}px`, top: '0', bottom: '0', width: '0' } })
  }
  if (guides.y !== null) {
    styles.push({ key: 'y', style: { top: `${box.y + guides.y * scale}px`, left: '0', right: '0', height: '0' } })
  }
  return styles
})

/** 画布面板：调整工具「整张」时显示，手动设定拼接画布的宽高和内容位置 */
const showCanvasPanel = computed(
  () => !props.singleImage && annotationTool.value === 'adjust' && adjustScope.value === 'whole' && !cropDraft.value,
)
const canvasValue = computed<CanvasSize | null>(() => {
  if (props.canvasSize) {
    return props.canvasSize
  }
  const content = props.contentSize
  return content ? { width: content.width, height: content.height, anchorX: 0.5, anchorY: 0.5 } : null
})
const CANVAS_ANCHORS: Array<{ x: 0 | 0.5 | 1; y: 0 | 0.5 | 1; name: string }> = [
  { x: 0, y: 0, name: '左上' },
  { x: 0.5, y: 0, name: '上' },
  { x: 1, y: 0, name: '右上' },
  { x: 0, y: 0.5, name: '左' },
  { x: 0.5, y: 0.5, name: '居中' },
  { x: 1, y: 0.5, name: '右' },
  { x: 0, y: 1, name: '左下' },
  { x: 0.5, y: 1, name: '下' },
  { x: 1, y: 1, name: '右下' },
]

function setCanvas(patch: Partial<CanvasSize>): void {
  const current = canvasValue.value
  if (!current) {
    return
  }
  keepScaleBeforeResize()
  emit('set-canvas', { ...current, ...patch })
}

function applyCanvasInput(axis: 'width' | 'height', event: Event): void {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (!Number.isFinite(value) || value <= 0) {
    input.value = String(canvasValue.value?.[axis] ?? '')
    return
  }
  const side = clampCanvasSide(value)
  input.value = String(side)
  setCanvas({ [axis]: side })
}

function fitCanvasToContent(): void {
  keepScaleBeforeResize()
  emit('set-canvas', null)
}

/** 调整工具下单击图片：选中它（拼接时）。 */
function handleAdjustClick(event: PointerEvent): void {
  const press = selectPress
  selectPress = null
  if (!press || press.pointerId !== event.pointerId || cropDraft.value || adjustScope.value === 'whole') {
    return
  }
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
    return
  }
  const hit = imageAtEvent(event)
  if (hit && hit.image.id !== activeImageId.value) {
    activeImageId.value = hit.image.id
    isHoldingActiveImage = true
    emit('active-change', hit.image.id)
    scheduleRender()
  }
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
    scale: imageToScreen.value * itemFactor(image).x,
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
  if (annotationTool.value !== 'select' && annotationTool.value !== 'adjust' && annotationTool.value !== 'cutout') {
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
  } else if (annotationTool.value === 'adjust') {
    handleAdjustClick(event)
  } else if (annotationTool.value === 'cutout') {
    handleCutoutClick(event)
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
    cancelCrop()
    cutout.clear()
    return
  }
  if (event.key === 'Enter' && cropDraft.value) {
    event.preventDefault()
    applyCropDraft()
    return
  }
  if (annotationTool.value === 'cutout' && event.key === 'Enter' && cutout.hasSelection.value) {
    event.preventDefault()
    applyCutout('keep')
    return
  }
  if (annotationTool.value === 'cutout' && event.key === 'Backspace' && cutoutTarget.value) {
    event.preventDefault()
    cutout.undoPoint(cutoutTarget.value)
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

function syncSharpenDraft(): void {
  const enhance = sharpenTarget.value?.enhance
  sharpenDraft.value = { ...(enhance?.sharpen ?? DEFAULT_SHARPEN) }
  aiSharpenLevel.value = enhance?.aiLevel ?? aiSharpenLevel.value
}

function toggleSharpenPanel(): void {
  isSharpenOpen.value = !isSharpenOpen.value
  if (isSharpenOpen.value) {
    syncSharpenDraft()
  }
}

function clearEnhance(image: StitchImage): void {
  if (image.enhance) {
    releaseCanvas(image.enhance.canvas)
    image.enhance = undefined
  }
}

/**
 * 算出清晰化结果并挂到图片上（经典与 AI 共用）：每张图只认最新一次请求，旧结果到了直接丢掉；
 * 结果画布替换旧的并释放旧画布，然后重画预览。
 */
async function applyEnhance(
  image: StitchImage,
  meta: Omit<ImageEnhance, 'canvas'>,
  compute: (report: (fraction: number) => void) => Promise<HTMLCanvasElement>,
): Promise<void> {
  const token = (sharpenTokens.get(image.id) ?? 0) + 1
  sharpenTokens.set(image.id, token)
  sharpenRunning.value += 1
  sharpenProgress.value = 0
  try {
    const canvas = await compute((fraction) => {
      if (sharpenTokens.get(image.id) === token) {
        sharpenProgress.value = fraction
      }
    })
    if (sharpenTokens.get(image.id) !== token) {
      releaseCanvas(canvas)
      return
    }
    const previous = image.enhance?.canvas
    image.enhance = { ...meta, canvas: markRaw(canvas) }
    releaseCanvas(previous)
    scheduleRender()
  } catch (error) {
    // 用户点了「停止」：图片保持原样，不当作失败提示。
    if (error instanceof AiCanceledError) {
      return
    }
    console.error('清晰化失败', error)
    if (sharpenTokens.get(image.id) === token) {
      emit('sharpen-failed', error instanceof Error && error.message ? error.message : '清晰化计算失败')
    }
  } finally {
    sharpenRunning.value -= 1
    aiSpeedVersion.value += 1
  }
}

async function runSharpen(image: StitchImage, settings: SharpenSettings): Promise<void> {
  const element = image.element
  if (!element) {
    return
  }
  if (isSharpenNoop(settings)) {
    sharpenTokens.set(image.id, (sharpenTokens.get(image.id) ?? 0) + 1)
    clearEnhance(image)
    scheduleRender()
    return
  }
  await applyEnhance(image, { engine: 'classic', sharpen: { ...settings }, resolution: 1 }, (report) =>
    sharpenImage(element, image.width, image.height, settings, report),
  )
}

/** 选了一个还不知道倍数的自定义模型：在 Worker 里试算一次（结果缓存，失败时给出原因）。 */
function probeSelectedModel(): void {
  const state = aiState.value
  if (!isSharpenOpen.value || props.sharpenEngine !== 'ai' || !state.ready || state.model.scale !== null) {
    return
  }
  const key = state.model.key
  if (aiModelInfos.value[key]) {
    return
  }
  aiModelInfos.value = { ...aiModelInfos.value, [key]: 'probing' }
  probeAiModel(state.model)
    .then((info) => {
      aiModelInfos.value = { ...aiModelInfos.value, [key]: info }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : '无法读取这个模型'
      aiModelInfos.value = { ...aiModelInfos.value, [key]: { error: message } }
    })
}

function startAiSharpen(): void {
  const target = sharpenTarget.value
  const state = aiState.value
  const element = target?.element
  const resolution = aiResolution.value
  if (
    !target ||
    !element ||
    !state.ready ||
    sharpenDisabledReason.value ||
    !aiAllowedResolutions.value.includes(resolution)
  ) {
    return
  }
  window.clearTimeout(sharpenTimer)
  const level = aiSharpenLevel.value
  const spec = state.model
  void applyEnhance(
    target,
    { engine: 'ai', sharpen: { ...sharpenDraft.value }, aiLevel: level, model: spec.key, resolution },
    (report) => aiSharpenImage(element, target.width, target.height, level, spec, resolution, report),
  )
}

function stopAiSharpen(): void {
  const target = sharpenTarget.value
  if (target) {
    sharpenTokens.set(target.id, (sharpenTokens.get(target.id) ?? 0) + 1)
  }
  cancelAiJobs()
}

function onSharpenChange(settings: SharpenSettings): void {
  const target = sharpenTarget.value
  if (!target || sharpenDisabledReason.value) {
    return
  }
  // 拖经典滑块就是要用经典锐化，顺手把方式切回经典。
  if (props.sharpenEngine !== 'classic') {
    emit('update-sharpen-engine', 'classic')
  }
  sharpenDraft.value = settings
  window.clearTimeout(sharpenTimer)
  // 拖滑块时连续触发，停一下再算，避免每一格都算一遍。
  sharpenTimer = setTimeout(() => void runSharpen(target, settings), 180)
}

function resetSharpen(): void {
  const target = sharpenTarget.value
  window.clearTimeout(sharpenTimer)
  if (!target) {
    return
  }
  // 让还在算的旧请求作废。
  sharpenTokens.set(target.id, (sharpenTokens.get(target.id) ?? 0) + 1)
  clearEnhance(target)
  syncSharpenDraft()
  scheduleRender()
}

/** 抠图与去除背景作用的图片：同清晰化（单图是当前这张，拼接是选中的那张），空白页除外 */
const cutoutTarget = computed<StitchImage | null>(() =>
  sharpenTarget.value?.kind === 'image' ? sharpenTarget.value : null,
)
/** 点下去加的是保留点还是排除点；按住 Alt 临时反过来 */
const cutoutPointMode = ref<'keep' | 'exclude'>('keep')
const cutout = useCutout({
  target: cutoutTarget,
  active: computed(() => annotationTool.value === 'cutout'),
  choice: computed(() => props.segmentModel),
  onError: (message) => emit('matte-failed', `抠图：${message}`),
})
/** 正在去除背景的图片编号与进度 */
const removingId = ref<string | null>(null)
const removeProgress = ref(0)
const removePercent = computed(() => `${Math.round(removeProgress.value * 100)}%`)
const cutoutPercent = computed(() => `${Math.round(cutout.progress.value * 100)}%`)

/** 抠图工具栏上的状态提示 */
const cutoutHint = computed(() => {
  if (!cutoutTarget.value) {
    return sharpenTarget.value?.kind === 'blank' ? '空白页不能抠图' : '先选中一张图片'
  }
  if (!props.segmentModel.ready) {
    return '抠图模型还不能用'
  }
  if (cutout.phase.value === 'encoding') {
    return `正在分析画面 ${cutoutPercent.value}`
  }
  if (cutout.points.value.length === 0) {
    return cutoutPointMode.value === 'keep' ? '点要保留的物体' : '点要排除的地方'
  }
  return cutout.phase.value === 'decoding' ? '正在选取…' : ''
})

const removeDisabledReason = computed(() => {
  if (!cutoutTarget.value) {
    return sharpenTarget.value?.kind === 'blank'
      ? '空白页不需要去除背景'
      : '先选中一张图片：点左侧卡片，或把它移到画面中间'
  }
  if (removingId.value) {
    return '正在去除背景'
  }
  return ''
})

/** 抠图工具下单击：在点中的图片上加一个保留点或排除点（拼接时点到别的图就改选那张）。 */
function handleCutoutClick(event: PointerEvent): void {
  const press = selectPress
  selectPress = null
  if (!press || press.pointerId !== event.pointerId) {
    return
  }
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
    return
  }
  if (!props.segmentModel.ready) {
    emit('matte-notice', props.segmentModel.reason)
    return
  }
  const hit = imageAtEvent(event)
  if (!hit || hit.image.kind !== 'image') {
    return
  }
  if (!props.singleImage && hit.image.id !== activeImageId.value) {
    activeImageId.value = hit.image.id
    isHoldingActiveImage = true
    emit('active-change', hit.image.id)
  }
  const positive = (cutoutPointMode.value === 'keep') !== event.altKey
  cutout.addPoint(hit.image, { x: hit.point.x, y: hit.point.y, positive })
}

/** 用当前选区：保留选中的（其余变透明），或把选中的去掉。可撤销。 */
function applyCutout(mode: CutoutMode): void {
  const image = cutout.pointImageId.value ? findImage(cutout.pointImageId.value) : null
  const selection = cutout.selectionCanvas()
  if (!image || !selection) {
    return
  }
  const mask = applySelection(image.matte?.mask ?? null, selection, mode, image.width, image.height)
  selection.width = 0
  setMatte(image, mask, 'cutout')
  cutout.clear()
  // 用完选区后下一次多半是重新选物体，点选方式回到「保留点」。
  cutoutPointMode.value = 'keep'
  emit(
    'matte-notice',
    mode === 'keep'
      ? '已保留选中部分，其余变透明；可在底栏换底色，Ctrl+Z 撤销'
      : '已去掉选中部分；可继续点选，Ctrl+Z 撤销',
  )
}

/** 去掉抠图与去除背景的结果，回到整张不透明（可撤销）。 */
function restoreMatte(): void {
  const image = cutoutTarget.value
  if (image?.matte) {
    cutout.clear()
    setMatte(image, null, 'cutout')
  }
}

async function runRemoveBackground(): Promise<void> {
  const image = cutoutTarget.value
  if (!image || removeDisabledReason.value) {
    return
  }
  const choice = props.matteModel
  if (!choice.ready) {
    emit('matte-notice', choice.reason)
    return
  }
  const source = getBaseSource(image)
  if (!source) {
    return
  }
  removingId.value = image.id
  removeProgress.value = 0
  try {
    const mask = await removeBackground(source, image.width, image.height, image.matte?.mask ?? null, choice, (fraction) => {
      removeProgress.value = fraction
    })
    if (!mask) {
      emit('matte-notice', `${choice.label} 没有找到可以去掉的背景，图片保持原样`)
      return
    }
    setMatte(image, mask, 'remove-background')
    emit('matte-notice', `已用 ${choice.label} 去除背景；可在底栏换底色，Ctrl+Z 撤销，或用「抠图」再细调`)
  } catch (error) {
    if (!(error instanceof AiCanceledError)) {
      console.error('去除背景失败', error)
      emit('matte-failed', error instanceof Error && error.message ? error.message : '去除背景计算失败')
    }
  } finally {
    removingId.value = null
  }
}

function stopRemoveBackground(): void {
  cancelAiJobs()
}

/** 选点在视口里的位置，画成圆点标记 */
const cutoutMarkers = computed(() => {
  const imageId = cutout.pointImageId.value
  if (annotationTool.value !== 'cutout' || !imageId) {
    return []
  }
  // 依赖缩放与平移，跟着画面走。
  void zoom.value
  void offset.value
  void displaySize.value
  return cutout.points.value.flatMap((point, index) => {
    const position = toViewport(imageId, point.x, point.y)
    return position ? [{ index, positive: point.positive, style: { left: `${position.x}px`, top: `${position.y}px` } }] : []
  })
})

function toggleCompare(): void {
  isComparing.value = !isComparing.value
}

function compareFromEvent(event: PointerEvent): void {
  const rect = viewportRef.value?.getBoundingClientRect()
  if (rect && rect.width > 0) {
    compareSplit.value = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  }
}

function startCompareDrag(event: PointerEvent): void {
  if (event.button !== 0) {
    return
  }
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  compareDrag = { pointerId: event.pointerId }
}

function moveCompareDrag(event: PointerEvent): void {
  if (compareDrag?.pointerId === event.pointerId) {
    compareFromEvent(event)
  }
}

function endCompareDrag(event: PointerEvent): void {
  if (compareDrag?.pointerId === event.pointerId) {
    compareDrag = null
  }
}

function onCompareKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.1 : 0.05
  if (event.key === 'ArrowLeft') {
    compareSplit.value = Math.max(0, compareSplit.value - step)
  } else if (event.key === 'ArrowRight') {
    compareSplit.value = Math.min(1, compareSplit.value + step)
  } else {
    return
  }
  event.preventDefault()
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
    compareSplit: isComparing.value ? compareSplit.value : null,
    hiddenAnnotationId: textDraft.value?.editingId ?? null,
    highlight: annotationTool.value === 'cutout' ? cutout.highlight.value : null,
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
watch([isComparing, compareSplit], scheduleRender)
watch(() => cutout.highlight.value, scheduleRender)
// 换了作用的图片（切换单图、拼接里选中另一张），面板里的参数跟着换成那张的。
watch(() => sharpenTarget.value?.id ?? null, syncSharpenDraft)
watch(
  () => [annotationTool.value, adjustSubject.value?.id ?? null] as const,
  () => {
    const draft = cropDraft.value
    if (draft && (annotationTool.value !== 'adjust' || adjustSubject.value?.id !== draft.targetId)) {
      cancelCrop()
    }
  },
)
watch([isSharpenOpen, () => props.sharpenEngine, aiState], probeSelectedModel)
// 换了模型、等级或目标图后，原来选的结果倍数做不到时退回能做的（默认 2 倍）。
watch(aiAllowedResolutions, (allowed) => {
  if (allowed.length > 0 && !allowed.includes(aiResolution.value)) {
    aiResolution.value = defaultResolution(allowed)
  }
})
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
    // 开关在工具栏上，工具栏收起后看不到，一并关掉。
    isSharpenOpen.value = false
    isComparing.value = false
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
        <template v-if="annotationTool === 'cutout'">
          <span class="annotation-group" role="group" aria-label="点选方式">
            <button
              v-tooltip="'点下去是要保留的物体（按住 Alt 临时改为排除）'"
              class="annotation-text-button"
              :class="{ 'is-active': cutoutPointMode === 'keep' }"
              type="button"
              :aria-pressed="cutoutPointMode === 'keep'"
              @click="cutoutPointMode = 'keep'"
            >
              <Plus :size="12" :stroke-width="2.2" />
              保留点
            </button>
            <button
              v-tooltip="'点下去是要排除的地方，用来修掉多选进来的部分（按住 Alt 临时改为保留）'"
              class="annotation-text-button"
              :class="{ 'is-active': cutoutPointMode === 'exclude' }"
              type="button"
              :aria-pressed="cutoutPointMode === 'exclude'"
              @click="cutoutPointMode = 'exclude'"
            >
              <Minus :size="12" :stroke-width="2.2" />
              排除点
            </button>
          </span>
          <template v-if="cutout.levelOptions.value.length > 0">
            <span class="annotation-separator" aria-hidden="true" />
            <button
              v-for="level in cutout.levelOptions.value"
              :key="level.index"
              v-tooltip="`选区范围：${level.name}（同一个点可以选物体的一小块、一个部位或整体）`"
              class="annotation-text-button"
              :class="{ 'is-active': cutout.levelIndex.value === level.index }"
              type="button"
              :aria-pressed="cutout.levelIndex.value === level.index"
              @click="cutout.setLevel(level.index)"
            >
              {{ level.name }}
            </button>
          </template>
          <span class="annotation-separator" aria-hidden="true" />
          <span class="annotation-group">
            <button
              v-tooltip="'只留下选中的部分，其余变透明（Enter）'"
              class="annotation-text-button is-primary"
              type="button"
              :disabled="!cutout.hasSelection.value"
              @click="applyCutout('keep')"
            >
              保留选中
            </button>
            <button
              v-tooltip="'把选中的部分变透明'"
              class="annotation-text-button"
              type="button"
              :disabled="!cutout.hasSelection.value"
              @click="applyCutout('remove')"
            >
              去掉选中
            </button>
            <button
              v-tooltip="'清掉选点重新选（Esc；Backspace 撤回最后一个点）'"
              class="annotation-text-button"
              type="button"
              :disabled="cutout.points.value.length === 0"
              @click="cutout.clear()"
            >
              清除选点
            </button>
            <button
              v-tooltip="'去掉抠图与去除背景的结果，回到原图'"
              class="annotation-text-button"
              type="button"
              :disabled="!cutoutTarget?.matte"
              @click="restoreMatte"
            >
              <RotateCcw :size="13" :stroke-width="1.9" />
              还原
            </button>
          </span>
          <span v-if="cutoutHint" class="annotation-hint tnum">{{ cutoutHint }}</span>
        </template>
        <template v-else-if="annotationTool !== 'adjust'">
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
        </template>
        <template v-else>
          <template v-if="!singleImage">
            <button
              v-tooltip="'调整选中的那张图'"
              class="annotation-text-button"
              :class="{ 'is-active': adjustScope === 'image' }"
              type="button"
              :aria-pressed="adjustScope === 'image'"
              @click="adjustScope = 'image'"
            >
              单张
            </button>
            <button
              v-tooltip="'调整整张拼接结果'"
              class="annotation-text-button"
              :class="{ 'is-active': adjustScope === 'whole' }"
              type="button"
              :aria-pressed="adjustScope === 'whole'"
              @click="adjustScope = 'whole'"
            >
              整张
            </button>
            <span class="annotation-separator" aria-hidden="true" />
          </template>
        </template>
        <template v-if="annotationTool === 'adjust' && !adjustSubject">
          <span class="annotation-hint">{{ activeBlank ? '空白页用空白页面板改尺寸' : '点选一张图片' }}</span>
        </template>
        <template v-else-if="cropDraft">
          <span class="annotation-hint tnum">裁剪 {{ formatDimensions(cropDraft.crop.width, cropDraft.crop.height) }}</span>
          <label v-tooltip="'裁剪框按原来的宽高比变化'" class="annotation-check">
            <input v-model="adjustKeepRatio" type="checkbox" />
            保持比例
          </label>
          <button v-tooltip="'放弃这次裁剪（Esc）'" class="annotation-text-button" type="button" @click="cancelCrop">
            取消
          </button>
          <button
            v-tooltip="'按框里的范围裁剪（Enter）；原图不变，可随时还原'"
            class="annotation-text-button is-primary"
            type="button"
            @click="applyCropDraft"
          >
            确定裁剪
          </button>
        </template>
        <template v-else-if="adjustInfo">
          <!-- 输入框、按钮按用途分组：工具栏换行时整组一起换，不把一组拆到两行。 -->
          <span v-if="movableMetrics" class="annotation-group" role="group" aria-label="在画布里的位置">
            <label class="annotation-hint" for="adjust-x">X</label>
            <input
              id="adjust-x"
              v-tooltip="'选中图片左上角在画布里的横坐标（像素），可输入；拖动图片也会变'"
              class="annotation-size-input annotation-size-input--wide tnum"
              type="number"
              step="1"
              :value="movableMetrics.x"
              @change="applyPositionInput('x', $event)"
            />
            <label class="annotation-hint" for="adjust-y">Y</label>
            <input
              id="adjust-y"
              v-tooltip="'选中图片左上角在画布里的纵坐标（像素），可输入'"
              class="annotation-size-input annotation-size-input--wide tnum"
              type="number"
              step="1"
              :value="movableMetrics.y"
              @change="applyPositionInput('y', $event)"
            />
          </span>
          <span class="annotation-group" role="group" aria-label="尺寸">
            <label class="annotation-hint" for="adjust-width">宽</label>
            <input
              id="adjust-width"
              v-tooltip="'显示与导出的宽度（像素）'"
              class="annotation-size-input annotation-size-input--wide tnum"
              type="number"
              min="8"
              step="1"
              :value="adjustInfo.width"
              @change="applyAdjustInput('width', $event)"
            />
            <label class="annotation-hint" for="adjust-height">高</label>
            <input
              id="adjust-height"
              v-tooltip="'显示与导出的高度（像素）'"
              class="annotation-size-input annotation-size-input--wide tnum"
              type="number"
              min="8"
              step="1"
              :value="adjustInfo.height"
              @change="applyAdjustInput('height', $event)"
            />
            <template v-if="adjustKeepRatio">
              <input
                v-tooltip="'按百分比等比缩放（相对原图）'"
                class="annotation-size-input annotation-size-input--wide tnum"
                type="number"
                min="1"
                step="1"
                aria-label="缩放百分比"
                :value="adjustInfo.percent"
                @change="applyAdjustInput('percent', $event)"
              />
              <span class="annotation-hint">%</span>
            </template>
            <label
              v-tooltip="adjustKeepRatio ? '拖任意手柄、输入宽或高都等比缩放' : '手柄和输入可分别改宽高（会变形）'"
              class="annotation-check"
            >
              <input v-model="adjustKeepRatio" type="checkbox" />
              保持比例
            </label>
          </span>
          <span class="annotation-group">
            <button
              v-tooltip="adjustScope === 'whole' && !singleImage ? '裁剪整张拼接图（可随时还原）' : '裁剪这张图（原图不变，可随时还原）'"
              class="annotation-text-button"
              type="button"
              @click="startCrop"
            >
              <Crop :size="13" :stroke-width="1.9" />
              裁剪
            </button>
            <button
              v-tooltip="'去掉缩放与裁剪，标注回到原位'"
              class="annotation-text-button"
              type="button"
              :disabled="!adjustInfo.isTransformed"
              @click="restoreTransform"
            >
              <RotateCcw :size="13" :stroke-width="1.9" />
              还原
            </button>
            <template v-if="movableImage">
              <button
                v-tooltip="'回到按拼接方向排好的位置（拖动画面里的图片可换位置）'"
                class="annotation-text-button"
                type="button"
                :disabled="!movableImage.position"
                @click="resetPosition"
              >
                归位
              </button>
              <label
                v-tooltip="'拖动时贴到其他图片和画布的边、中线上（按住 Alt 临时不吸附）'"
                class="annotation-check"
              >
                <input
                  type="checkbox"
                  :checked="snap"
                  @change="emit('update-snap', ($event.target as HTMLInputElement).checked)"
                />
                吸附
              </label>
            </template>
          </span>
          <template v-if="movableImage">
            <span class="annotation-separator" aria-hidden="true" />
            <!-- 图层四个按钮放成一组：工具栏换行时整组一起换，不拆开。 -->
            <span class="annotation-group" role="group" aria-label="图层">
              <button
                v-for="action in LAYER_ACTIONS"
                :key="action.value"
                v-tooltip="`${action.name}（图片重叠时谁在上面）`"
                class="annotation-tool"
                type="button"
                :disabled="!canMoveLayer(action.value)"
                :aria-label="action.name"
                @click="applyLayer(action.value)"
              >
                <component :is="action.icon" :size="14" :stroke-width="1.9" />
              </button>
            </span>
          </template>
        </template>
        <span class="annotation-separator" aria-hidden="true" />
        <button
          v-tooltip="'撤销标注与抠图（Ctrl+Z）'"
          class="annotation-tool"
          type="button"
          :disabled="!canUndo"
          aria-label="撤销标注与抠图"
          @click="undo"
        >
          <Undo2 :size="14" :stroke-width="1.9" />
        </button>
        <button
          v-tooltip="'重做标注与抠图（Ctrl+Shift+Z）'"
          class="annotation-tool"
          type="button"
          :disabled="!canRedo"
          aria-label="重做标注与抠图"
          @click="redo"
        >
          <Redo2 :size="14" :stroke-width="1.9" />
        </button>
        <span class="annotation-separator" aria-hidden="true" />
        <button
          v-tooltip="'清晰化：让发软的图片更清楚'"
          class="annotation-tool"
          :class="{ 'is-active': isSharpenOpen }"
          type="button"
          aria-label="清晰化"
          :aria-pressed="isSharpenOpen"
          @click="toggleSharpenPanel"
        >
          <Sparkles :size="14" :stroke-width="1.9" />
        </button>
        <button
          v-tooltip="removeDisabledReason || (matteModel.ready ? `去除背景：用 ${matteModel.label} 自动识别主体，背景变透明` : `去除背景：${matteModel.reason}`)"
          class="annotation-tool"
          :class="{ 'is-active': removingId !== null }"
          type="button"
          aria-label="去除背景"
          :disabled="Boolean(removeDisabledReason)"
          @click="runRemoveBackground"
        >
          <ImageMinus :size="14" :stroke-width="1.9" />
        </button>
        <button
          v-tooltip="isComparing ? '关闭前后对比' : '前后对比：左边原图，右边处理后'"
          class="annotation-tool"
          :class="{ 'is-active': isComparing }"
          type="button"
          aria-label="前后对比"
          :aria-pressed="isComparing"
          @click="toggleCompare"
        >
          <Columns2 :size="14" :stroke-width="1.9" />
        </button>
      </FloatingToolbar>

      <SharpenPanel
        v-if="isSharpenOpen && images.length > 0 && !annotationToolbar.collapsed"
        class="sharpen-popover"
        :target-name="sharpenTarget?.name ?? null"
        :disabled-reason="sharpenDisabledReason"
        :engine="sharpenEngine"
        :settings="sharpenDraft"
        :ai-level="aiSharpenLevel"
        :ai-state="aiState"
        :ai-models="aiModels"
        :ai-model-key="aiChoice?.key ?? ''"
        :ai-model-note="aiModelNote"
        :ai-resolution="aiResolution"
        :ai-allowed-resolutions="aiAllowedResolutions"
        :applied-model="sharpenTarget?.enhance?.model ?? null"
        :applied-resolution="sharpenTarget?.enhance?.resolution ?? 1"
        :applied-engine="sharpenTarget?.enhance?.engine ?? null"
        :applied-ai-level="sharpenTarget?.enhance?.aiLevel ?? null"
        :ai-estimate-seconds="aiEstimateSeconds"
        :busy="sharpenRunning > 0"
        :progress="sharpenProgress"
        @change="onSharpenChange"
        @update:engine="emit('update-sharpen-engine', $event)"
        @update:ai-level="aiSharpenLevel = $event"
        @update:ai-model="emit('update-sharpen-model', $event)"
        @update:ai-resolution="aiResolution = $event"
        @ai-start="startAiSharpen"
        @ai-stop="stopAiSharpen"
        @reset="resetSharpen"
        @close="isSharpenOpen = false"
      />

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
            class="stage-selection"
            :style="blankSelectionStyle"
            aria-hidden="true"
          >
            <span class="stage-selection__label">空白页</span>
            <button
              v-tooltip="'拖动调整空白页大小'"
              class="stage-handle stage-handle--se"
              type="button"
              aria-label="拖动调整空白页大小"
              @pointerdown="startBlankResize"
              @pointermove="moveBlankResize"
              @pointerup="endBlankResize"
              @pointercancel="endBlankResize"
            />
          </div>

          <div
            v-if="adjustSubject && adjustBoxStyle"
            class="stage-selection"
            :style="adjustBoxStyle"
          >
            <!-- 尺寸已在标注栏的宽、高输入框里；选框上不再挂标签，免得盖住上一张图。 -->
            <template v-if="cropDraft && cropFrameStyle">
              <div class="stage-crop-dim" aria-hidden="true">
                <span class="stage-crop-hole" :style="cropFrameStyle" />
              </div>
              <div
                class="stage-crop-frame"
                :style="cropFrameStyle"
                aria-label="裁剪框，拖动平移"
                @pointerdown="startAdjustDrag('move', $event)"
                @pointermove="moveAdjustDrag"
                @pointerup="endAdjustDrag"
                @pointercancel="endAdjustDrag"
              >
                <button
                  v-for="handle in RESIZE_HANDLES"
                  :key="handle"
                  class="stage-handle"
                  :class="`stage-handle--${handle}`"
                  type="button"
                  :aria-label="`拖动调整裁剪框（${handle}）`"
                  @pointerdown="startAdjustDrag(handle, $event)"
                  @pointermove="moveAdjustDrag"
                  @pointerup="endAdjustDrag"
                  @pointercancel="endAdjustDrag"
                />
              </div>
            </template>
            <template v-else>
              <div
                v-if="movableImage"
                class="stage-move-area"
                aria-hidden="true"
                @pointerdown="startMoveDrag"
                @pointermove="moveMoveDrag"
                @pointerup="endMoveDrag"
                @pointercancel="endMoveDrag"
              />
              <button
                v-for="handle in RESIZE_HANDLES"
                :key="handle"
                class="stage-handle"
                :class="`stage-handle--${handle}`"
                type="button"
                :aria-label="`拖动缩放图片（${handle}）`"
                @pointerdown="startAdjustDrag(handle, $event)"
                @pointermove="moveAdjustDrag"
                @pointerup="endAdjustDrag"
                @pointercancel="endAdjustDrag"
              />
            </template>
          </div>

          <div v-if="isComparing" class="preview-compare">
            <span class="compare-label compare-label--before">原图</span>
            <span class="compare-label compare-label--after">处理后</span>
            <div class="compare-divider" :style="{ left: `${comparePercent}%` }">
              <button
                class="compare-handle"
                type="button"
                role="slider"
                aria-label="对比位置：左边原图，右边处理后"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="comparePercent"
                :aria-valuetext="`${comparePercent}%`"
                @pointerdown.stop="startCompareDrag"
                @pointermove.stop="moveCompareDrag"
                @pointerup.stop="endCompareDrag"
                @pointercancel.stop="endCompareDrag"
                @dblclick.stop
                @keydown.stop="onCompareKeydown"
              >
                <span aria-hidden="true">‹ ›</span>
              </button>
            </div>
          </div>

          <span
            v-for="guide in snapGuideStyles"
            :key="guide.key"
            class="snap-guide"
            :class="`snap-guide--${guide.key}`"
            :style="guide.style"
            aria-hidden="true"
          />

          <div
            v-if="showCanvasPanel && canvasValue"
            class="stage-panel"
            role="group"
            aria-label="画布尺寸"
            @pointerdown.stop
            @click.stop
            @dblclick.stop
            @wheel.stop
          >
            <div class="stage-panel__head">
              <strong>画布</strong>
              <span class="tnum">{{ canvasSize ? '自定义' : '贴合内容' }}</span>
            </div>
            <div class="stage-panel__fields">
              <label>
                <span>宽</span>
                <input
                  type="number"
                  min="16"
                  max="65536"
                  step="10"
                  :value="canvasValue.width"
                  @change="applyCanvasInput('width', $event)"
                />
              </label>
              <label>
                <span>高</span>
                <input
                  type="number"
                  min="16"
                  max="65536"
                  step="10"
                  :value="canvasValue.height"
                  @change="applyCanvasInput('height', $event)"
                />
              </label>
            </div>
            <div class="canvas-anchor">
              <span class="stage-panel__hint">内容位置</span>
              <div class="canvas-anchor__grid" role="group" aria-label="内容在画布里的位置">
                <button
                  v-for="anchor in CANVAS_ANCHORS"
                  :key="anchor.name"
                  v-tooltip="`内容放在画布${anchor.name === '居中' ? '中间' : anchor.name}`"
                  class="canvas-anchor__cell"
                  :class="{ 'is-active': canvasValue.anchorX === anchor.x && canvasValue.anchorY === anchor.y }"
                  type="button"
                  :aria-label="anchor.name"
                  :aria-pressed="canvasValue.anchorX === anchor.x && canvasValue.anchorY === anchor.y"
                  @click="setCanvas({ anchorX: anchor.x, anchorY: anchor.y })"
                />
              </div>
              <div class="stage-panel__buttons canvas-anchor__fit">
                <button
                  v-tooltip="'画布回到刚好包住内容的大小'"
                  type="button"
                  :disabled="!canvasSize"
                  @click="fitCanvasToContent"
                >
                  贴合内容
                </button>
              </div>
            </div>
            <span class="stage-panel__hint">变大处填背景，超出画布的部分被裁掉</span>
          </div>

          <div
            v-if="activeBlank && !blankPanel.collapsed && !showCanvasPanel"
            class="stage-panel"
            @pointerdown.stop
            @click.stop
            @dblclick.stop
            @wheel.stop
          >
            <div class="stage-panel__head">
              <strong>空白页</strong>
              <span class="tnum">{{ blankSizeSummary }}</span>
              <button
                v-tooltip="'收起空白页面板（可在预览标题栏重新显示）'"
                class="stage-panel__collapse"
                type="button"
                aria-label="收起空白页面板（可在预览标题栏重新显示）"
                @click="collapsePanel('blankPanel')"
              >
                <ChevronsRight :size="14" :stroke-width="1.9" />
              </button>
            </div>
            <div class="stage-panel__fields">
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
            <div class="stage-panel__buttons">
              <button type="button" @click="applyBlankPreset(800, 800)">1:1</button>
              <button type="button" @click="applyBlankPreset(1200, 800)">3:2</button>
              <button type="button" @click="applyBlankPreset(1920, 1080)">16:9</button>
            </div>
            <span class="stage-panel__hint">也可拖动右下角调整</span>
          </div>

          <span
            v-for="marker in cutoutMarkers"
            :key="marker.index"
            class="cutout-marker"
            :class="marker.positive ? 'cutout-marker--keep' : 'cutout-marker--exclude'"
            :style="marker.style"
            aria-hidden="true"
          >
            <Plus v-if="marker.positive" :size="10" :stroke-width="3" />
            <Minus v-else :size="10" :stroke-width="3" />
          </span>

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

        <div v-if="removingId" class="stage-busy" role="status">
          <Loader2 class="spin" :size="13" :stroke-width="2" />
          <span class="tnum">正在用 {{ matteModel.label }} 去除背景 {{ removePercent }}</span>
          <button
            v-tooltip="'停止去除背景，图片保持原样'"
            class="heal-choice__switch"
            type="button"
            @click="stopRemoveBackground"
          >
            停止
          </button>
        </div>

        <div v-else-if="annotationTool === 'cutout' && cutout.phase.value === 'encoding'" class="stage-busy" role="status">
          <Loader2 class="spin" :size="13" :stroke-width="2" />
          <span class="tnum">正在用 {{ segmentModel.label }} 分析画面 {{ cutoutPercent }}，可以先点选</span>
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
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

/* 清晰化面板贴在标注栏下方、浮在画布左上角。 */
.sharpen-popover {
  position: absolute;
  z-index: 6;
  top: 43px;
  left: 0;
}

/* 前后对比的中线层铺满视口，只有把手接收指针，画布上的工具照常可用。 */
.preview-compare {
  position: absolute;
  z-index: 3;
  inset: 0;
  pointer-events: none;
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

.annotation-size-input--wide {
  width: 46px;
}

/* 调整工具在标注栏里的提示、开关与文字按钮 */
.annotation-hint {
  padding: 0 2px;
  color: var(--text-muted);
  font-size: 10.5px;
  white-space: nowrap;
}

.annotation-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 5px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 10.5px;
  white-space: nowrap;
  cursor: pointer;
}

.annotation-check:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.annotation-check input {
  margin: 0;
  accent-color: var(--accent);
}

.annotation-text-button {
  display: inline-flex;
  height: 24px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 10.5px;
  white-space: nowrap;
}

.annotation-text-button:hover:not(:disabled) {
  border-color: var(--accent-line-strong);
  color: var(--accent);
}

.annotation-text-button:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}

.annotation-text-button.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.annotation-text-button.is-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--surface);
}

.annotation-text-button.is-primary:hover {
  color: var(--surface);
  filter: brightness(1.05);
}

.stage-selection {
  position: absolute;
  z-index: 3;
  border: 1.5px dashed var(--accent);
  background: transparent;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.72) inset;
  pointer-events: none;
}

.stage-selection__label {
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

.stage-handle {
  position: absolute;
  width: 15px;
  height: 15px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-xs);
  pointer-events: auto;
  touch-action: none;
}

/* 手柄位置：四角与四边中点，光标方向跟着变 */
.stage-handle--nw { top: 0; left: 0; cursor: nwse-resize; transform: translate(-50%, -50%); }
.stage-handle--n { top: 0; left: 50%; cursor: ns-resize; transform: translate(-50%, -50%); }
.stage-handle--ne { top: 0; right: 0; cursor: nesw-resize; transform: translate(50%, -50%); }
.stage-handle--e { top: 50%; right: 0; cursor: ew-resize; transform: translate(50%, -50%); }
.stage-handle--se { right: 0; bottom: 0; cursor: nwse-resize; transform: translate(50%, 50%); }
.stage-handle--s { bottom: 0; left: 50%; cursor: ns-resize; transform: translate(-50%, 50%); }
.stage-handle--sw { bottom: 0; left: 0; cursor: nesw-resize; transform: translate(-50%, 50%); }
.stage-handle--w { top: 50%; left: 0; cursor: ew-resize; transform: translate(-50%, -50%); }

/* 裁剪：框外压暗（只在图片范围内），框可拖动平移，边角有手柄 */
.stage-crop-dim {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.stage-crop-hole {
  position: absolute;
  box-shadow: 0 0 0 9999px rgba(12, 20, 17, 0.52);
}

.cutout-marker {
  position: absolute;
  z-index: 4;
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  border: 2px solid var(--surface);
  border-radius: 50%;
  color: var(--surface);
  box-shadow: var(--shadow-xs);
  pointer-events: none;
  transform: translate(-50%, -50%);
}

.cutout-marker--keep {
  background: var(--accent);
}

.cutout-marker--exclude {
  background: var(--danger);
}

.annotation-group {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 1px;
}

.snap-guide {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}

.snap-guide--x {
  border-left: 1px dashed var(--danger);
}

.snap-guide--y {
  border-top: 1px dashed var(--danger);
}

.canvas-anchor {
  display: flex;
  align-items: center;
  gap: 8px;
}

.canvas-anchor__grid {
  display: grid;
  grid-template-columns: repeat(3, 12px);
  gap: 2px;
}

.canvas-anchor__fit {
  flex: 1;
}

.canvas-anchor__cell {
  width: 12px;
  height: 12px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background: var(--surface);
  cursor: pointer;
}

.canvas-anchor__cell:hover {
  border-color: var(--accent);
}

.canvas-anchor__cell.is-active {
  border-color: var(--accent);
  background: var(--accent);
}

.stage-move-area {
  position: absolute;
  inset: 0;
  cursor: move;
  pointer-events: auto;
  touch-action: none;
}

.stage-crop-frame {
  position: absolute;
  border: 1.5px solid var(--surface);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: move;
  pointer-events: auto;
  touch-action: none;
}



.stage-handle:hover {
  background: var(--accent-soft);
}

.stage-panel {
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

.stage-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stage-panel__head strong {
  color: var(--text-strong);
  font-size: 11px;
  font-weight: 650;
}

.stage-panel__head span {
  flex: 1;
  color: var(--text-faint);
  font-size: 9.5px;
  text-align: right;
}

.stage-panel__collapse {
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

.stage-panel__collapse:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.stage-panel__fields {
  display: flex;
  gap: 7px;
}

.stage-panel__fields label {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
  font-size: 9px;
}

.stage-panel__fields input {
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

.stage-panel__fields input:focus {
  border-color: var(--accent);
  outline: none;
}

.stage-panel__buttons {
  display: flex;
  gap: 4px;
}

.stage-panel__buttons button {
  height: 22px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 9px;
}

.stage-panel__buttons button:hover {
  border-color: var(--accent-line-strong);
  color: var(--accent);
}

.stage-panel__hint {
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

  .stage-panel {
    right: 8px;
    bottom: 8px;
    width: 190px;
    padding: 8px;
  }


  .stage-selection__label {
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
