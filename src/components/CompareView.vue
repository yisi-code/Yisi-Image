<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { getCheckerPattern } from '../core/render'

/**
 * 前后对比视图：左边画「处理前」，右边画「处理后」，中间竖线可拖动。
 * 「适应」把整张图缩进视图；「100%」按实际像素显示，可按住拖动查看局部。
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

type ZoomMode = 'fit' | 'actual'

const SPLIT_STEP = 0.05

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewSize = ref({ width: 0, height: 0 })
const split = ref(0.5)
const zoomMode = ref<ZoomMode>('fit')
const offset = ref({ x: 0, y: 0 })
let dragState:
  | { kind: 'split'; pointerId: number }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; originX: number; originY: number }
  | null = null
let resizeObserver: ResizeObserver | null = null
let frame = 0

const scale = computed(() => {
  const { width, height } = viewSize.value
  if (zoomMode.value === 'actual' || props.width <= 0 || props.height <= 0) {
    return 1
  }
  return Math.min(1, width / props.width, height / props.height)
})

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
  // 100% 时按像素原样显示，方便看压缩块和锐化边缘。
  context.imageSmoothingEnabled = zoomMode.value === 'fit'
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

function setZoom(mode: ZoomMode): void {
  zoomMode.value = mode
  offset.value = { x: 0, y: 0 }
  scheduleDraw()
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
  // 适应模式下点哪里中线就到哪里；100% 模式下拖动画面平移，拖中线才改对比位置。
  if (onHandle || zoomMode.value === 'fit') {
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
      :class="{ 'is-actual': zoomMode === 'actual' }"
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
      <div class="segmented compare-zoom" role="group" aria-label="对比视图缩放">
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': zoomMode === 'fit' }"
          :aria-pressed="zoomMode === 'fit'"
          title="整张图缩进视图"
          @click="setZoom('fit')"
        >
          适应
        </button>
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': zoomMode === 'actual' }"
          :aria-pressed="zoomMode === 'actual'"
          title="按实际像素显示，按住拖动查看局部"
          @click="setZoom('actual')"
        >
          100%
        </button>
      </div>
      <span class="compare-tip">
        {{ zoomMode === 'fit' ? '点击或拖动画面移动中线' : '拖动画面平移，拖中线对比' }}
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

.compare-viewport.is-actual {
  cursor: grab;
}

.compare-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.compare-label {
  position: absolute;
  top: 8px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(19, 32, 28, 0.66);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  pointer-events: none;
}

.compare-label--before {
  left: 8px;
}

.compare-label--after {
  right: 8px;
}

.compare-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--surface);
  box-shadow: 0 0 0 1px rgba(19, 32, 28, 0.18);
  pointer-events: none;
}

.compare-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-xs);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
  cursor: ew-resize;
  pointer-events: auto;
  transform: translate(-50%, -50%);
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
  align-items: center;
  gap: 10px;
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
