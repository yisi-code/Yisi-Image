<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, Minus, Plus } from 'lucide-vue-next'
import { getCheckerPattern } from '../core/render'

/**
 * 前后对比视图：左边画「处理前」，右边画「处理后」，中间竖线可拖动。
 * 可滚轮缩放（以指针处为中心）、按 − / + 逐级缩放，「适应」把整张图缩进视图，「100%」按实际像素显示；
 * 画面比视图大时按住拖动平移，拖中线才改对比位置；双击在适应与 100% 之间切换。
 */
const props = withDefaults(
  defineProps<{
    before: CanvasImageSource | null
    after: CanvasImageSource | null
    /** 内容的实际像素尺寸，两边相同 */
    width: number
    height: number
    beforeLabel?: string
    afterLabel?: string
    busy?: boolean
  }>(),
  {
    beforeLabel: '原图',
    afterLabel: '处理后',
    busy: false,
  },
)

const SPLIT_STEP = 0.05
const MAX_SCALE = 8
const ZOOM_STEP = 1.25
/** 滚轮每单位 deltaY 对应的缩放指数 */
const WHEEL_ZOOM_SPEED = 0.0015

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewSize = ref({ width: 0, height: 0 })
const split = ref(0.5)
/** 用户选的缩放比例；null 表示「适应」，跟着视图大小变 */
const customScale = ref<number | null>(null)
const offset = ref({ x: 0, y: 0 })
let dragState:
  | { kind: 'split'; pointerId: number }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; originX: number; originY: number }
  | null = null
let resizeObserver: ResizeObserver | null = null
let frame = 0

/** 整张图放进视图的比例；小图不放大，最多 100%。 */
const fitScale = computed(() => {
  const { width, height } = viewSize.value
  if (props.width <= 0 || props.height <= 0 || width <= 0 || height <= 0) {
    return 1
  }
  return Math.min(1, width / props.width, height / props.height)
})
const minScale = computed(() => Math.min(fitScale.value, 1))
const scale = computed(() => customScale.value ?? fitScale.value)
const scalePercent = computed(() => `${Math.round(scale.value * 100)}%`)
const isFit = computed(() => customScale.value === null)
const isActual = computed(() => Math.abs(scale.value - 1) < 0.001)
/** 画面超出视图时可以拖动平移 */
const canPan = computed(
  () =>
    props.width * scale.value > viewSize.value.width + 0.5 ||
    props.height * scale.value > viewSize.value.height + 0.5,
)

const splitPercent = computed(() => Math.round(split.value * 100))

/** 内容比视图大时只能平移到边缘为止，比视图小时居中。 */
function clampOffset(next: { x: number; y: number }): { x: number; y: number } {
  const limitX = Math.max(0, (props.width * scale.value - viewSize.value.width) / 2)
  const limitY = Math.max(0, (props.height * scale.value - viewSize.value.height) / 2)
  return {
    x: Math.max(-limitX, Math.min(limitX, next.x)),
    y: Math.max(-limitY, Math.min(limitY, next.y)),
  }
}

function draw(): void {
  const canvas = canvasRef.value
  const { width: viewWidth, height: viewHeight } = viewSize.value
  if (!canvas || viewWidth <= 0 || viewHeight <= 0) {
    return
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(viewWidth * dpr)
  canvas.height = Math.round(viewHeight * dpr)
  const context = canvas.getContext('2d')
  if (!context) {
    return
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, viewWidth, viewHeight)
  if (props.width <= 0 || props.height <= 0) {
    return
  }

  const contentWidth = props.width * scale.value
  const contentHeight = props.height * scale.value
  const left = (viewWidth - contentWidth) / 2 + offset.value.x
  const top = (viewHeight - contentHeight) / 2 + offset.value.y
  const splitX = viewWidth * split.value

  context.fillStyle = getCheckerPattern(context)
  context.fillRect(left, top, contentWidth, contentHeight)
  // 放大到 100% 及以上时按像素原样显示，方便看压缩块和锐化边缘。
  context.imageSmoothingEnabled = scale.value < 1
  context.imageSmoothingQuality = 'high'

  if (props.before) {
    context.save()
    context.beginPath()
    context.rect(0, 0, splitX, viewHeight)
    context.clip()
    context.drawImage(props.before, left, top, contentWidth, contentHeight)
    context.restore()
  }
  if (props.after) {
    context.save()
    context.beginPath()
    context.rect(splitX, 0, viewWidth - splitX, viewHeight)
    context.clip()
    context.drawImage(props.after, left, top, contentWidth, contentHeight)
    context.restore()
  }
}

function scheduleDraw(): void {
  window.cancelAnimationFrame(frame)
  frame = window.requestAnimationFrame(draw)
}

function measure(): void {
  const container = containerRef.value
  if (!container) {
    return
  }
  viewSize.value = { width: container.clientWidth, height: container.clientHeight }
  offset.value = clampOffset(offset.value)
  scheduleDraw()
}

function fitView(): void {
  customScale.value = null
  offset.value = { x: 0, y: 0 }
  scheduleDraw()
}

/** 缩放到 next，并让视图里 (anchorX, anchorY) 处的那一点保持不动；不给锚点时以视图中心为准。 */
function zoomTo(next: number, anchorX = viewSize.value.width / 2, anchorY = viewSize.value.height / 2): void {
  const previous = scale.value
  const target = Math.min(MAX_SCALE, Math.max(minScale.value, next))
  if (Math.abs(target - previous) < 0.0001) {
    return
  }
  const { width: viewWidth, height: viewHeight } = viewSize.value
  const left = (viewWidth - props.width * previous) / 2 + offset.value.x
  const top = (viewHeight - props.height * previous) / 2 + offset.value.y
  const contentX = (anchorX - left) / previous
  const contentY = (anchorY - top) / previous
  customScale.value = target
  offset.value = clampOffset({
    x: anchorX - contentX * target - (viewWidth - props.width * target) / 2,
    y: anchorY - contentY * target - (viewHeight - props.height * target) / 2,
  })
  scheduleDraw()
}

function onWheel(event: WheelEvent): void {
  if (props.width <= 0 || props.height <= 0) {
    return
  }
  event.preventDefault()
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) {
    return
  }
  zoomTo(
    scale.value * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED),
    event.clientX - rect.left,
    event.clientY - rect.top,
  )
}

function onDoubleClick(event: MouseEvent): void {
  if (event.target instanceof HTMLElement && event.target.closest('.compare-handle')) {
    return
  }
  if (isActual.value) {
    fitView()
    return
  }
  const rect = containerRef.value?.getBoundingClientRect()
  zoomTo(1, rect ? event.clientX - rect.left : undefined, rect ? event.clientY - rect.top : undefined)
}

function splitFromEvent(event: PointerEvent): number {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) {
    return split.value
  }
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) {
    return
  }
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const onHandle = event.target instanceof HTMLElement && event.target.closest('.compare-handle')
  // 画面完整放得下时点哪里中线就到哪里；超出视图时拖动画面平移，拖中线才改对比位置。
  if (onHandle || !canPan.value) {
    dragState = { kind: 'split', pointerId: event.pointerId }
    split.value = splitFromEvent(event)
  } else {
    dragState = {
      kind: 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.value.x,
      originY: offset.value.y,
    }
  }
  scheduleDraw()
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return
  }
  if (dragState.kind === 'split') {
    split.value = splitFromEvent(event)
  } else {
    offset.value = clampOffset({
      x: dragState.originX + event.clientX - dragState.startX,
      y: dragState.originY + event.clientY - dragState.startY,
    })
  }
  scheduleDraw()
}

function onPointerUp(event: PointerEvent): void {
  if (dragState?.pointerId === event.pointerId) {
    dragState = null
  }
}

function onHandleKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? SPLIT_STEP * 2 : SPLIT_STEP
  if (event.key === 'ArrowLeft') {
    split.value = Math.max(0, split.value - step)
  } else if (event.key === 'ArrowRight') {
    split.value = Math.min(1, split.value + step)
  } else if (event.key === 'Home') {
    split.value = 0
  } else if (event.key === 'End') {
    split.value = 1
  } else {
    return
  }
  event.preventDefault()
  scheduleDraw()
}

watch(
  () => [props.before, props.after, props.width, props.height],
  () => {
    offset.value = clampOffset(offset.value)
    scheduleDraw()
  },
)

onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value)
  }
  measure()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.cancelAnimationFrame(frame)
})
</script>

<template>
  <div class="compare-view">
    <div
      ref="containerRef"
      class="compare-viewport"
      :class="{ 'can-pan': canPan }"
      @wheel="onWheel"
      @dblclick="onDoubleClick"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <canvas ref="canvasRef" class="compare-canvas" aria-hidden="true" />
      <span class="compare-label compare-label--before">{{ beforeLabel }}</span>
      <span class="compare-label compare-label--after">{{ afterLabel }}</span>
      <div class="compare-divider" :style="{ left: `${splitPercent}%` }">
        <button
          class="compare-handle"
          type="button"
          role="slider"
          :aria-label="`对比位置：左边${beforeLabel}，右边${afterLabel}`"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="splitPercent"
          :aria-valuetext="`${splitPercent}%`"
          @keydown="onHandleKeydown"
        >
          <span aria-hidden="true">‹ ›</span>
        </button>
      </div>
      <div v-if="busy" class="compare-busy" role="status">
        <Loader2 class="spin" :size="16" :stroke-width="2" />
        <span>正在生成预览</span>
      </div>
    </div>

    <div class="compare-toolbar">
      <div class="compare-zoom-steps" role="group" aria-label="对比视图缩放">
        <button
          class="icon-button compare-zoom-button"
          type="button"
          :disabled="scale <= minScale + 0.0001"
          title="缩小"
          aria-label="缩小对比视图"
          @click="zoomTo(scale / ZOOM_STEP)"
        >
          <Minus :size="14" :stroke-width="2" />
        </button>
        <span class="compare-zoom-value tnum" aria-live="polite">{{ scalePercent }}</span>
        <button
          class="icon-button compare-zoom-button"
          type="button"
          :disabled="scale >= MAX_SCALE - 0.0001"
          title="放大"
          aria-label="放大对比视图"
          @click="zoomTo(scale * ZOOM_STEP)"
        >
          <Plus :size="14" :stroke-width="2" />
        </button>
      </div>
      <div class="segmented compare-zoom" role="group" aria-label="对比视图快捷缩放">
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': isFit }"
          :aria-pressed="isFit"
          title="整张图缩进视图"
          @click="fitView"
        >
          适应
        </button>
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': !isFit && isActual }"
          :aria-pressed="!isFit && isActual"
          title="按实际像素显示，按住拖动查看局部"
          @click="zoomTo(1)"
        >
          100%
        </button>
      </div>
      <span class="compare-tip">
        {{ canPan ? '滚轮缩放，拖动画面平移，拖中线对比' : '滚轮缩放，点击或拖动画面移动中线' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.compare-view {
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.compare-viewport {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background-color: var(--surface-inset);
  background-image: radial-gradient(rgba(29, 64, 54, 0.13) 1px, transparent 1px);
  background-size: 16px 16px;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}

.compare-viewport.can-pan {
  cursor: grab;
}

.compare-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.compare-busy {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--shadow-xs);
  color: var(--text-muted);
  font-size: 11px;
}

.compare-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.compare-zoom-steps {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.compare-zoom-button {
  width: 28px;
  height: 28px;
}

.compare-zoom-value {
  min-width: 46px;
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 650;
  text-align: center;
}

.compare-zoom .segment {
  height: 26px;
  padding: 0 10px;
}

.compare-tip {
  color: var(--text-faint);
  font-size: 10.5px;
}
</style>
