<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ImagePlus,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  UploadCloud,
} from 'lucide-vue-next'
import { useFileDrop } from '../composables/useFileDrop'
import { formatDimensions } from '../core/image'
import { renderStitch } from '../core/render'
import type { ImportProgress, StitchImage, StitchLayout } from '../core/types'

const props = defineProps<{
  images: StitchImage[]
  layout: StitchLayout
  isImporting: boolean
  progress: ImportProgress
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const zoom = ref(1)
const offset = ref({ x: 0, y: 0 })
const isPanning = ref(false)
let renderFrame = 0
let panState: {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
} | null = null

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const PREVIEW_MAX_SIDE = 4096
const PREVIEW_MAX_PIXELS = 16_000_000
const PREVIEW_MAX_DPR = 2
const displaySize = ref({ width: 0, height: 0 })

const { isFileDragging, dropHandlers } = useFileDrop((files) => emit('add', files))

const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)

const canvasTransform = computed(
  () => `translate3d(${offset.value.x}px, ${offset.value.y}px, 0)`,
)

const canvasStyle = computed(() => ({
  width: `${Math.max(1, displaySize.value.width * zoom.value)}px`,
  height: `${Math.max(1, displaySize.value.height * zoom.value)}px`,
  transform: canvasTransform.value,
}))

const previewLabel = computed(
  () =>
    `拼接效果预览，共 ${props.images.length} 张图片，输出尺寸 ${formatDimensions(props.layout.width, props.layout.height)} 像素`,
)

function resetView(): void {
  zoom.value = 1
  offset.value = { x: 0, y: 0 }
  isPanning.value = false
  panState = null
}

function clampOffset(next: { x: number; y: number }) {
  const viewport = viewportRef.value
  const canvas = canvasRef.value
  if (!viewport || !canvas) {
    return next
  }

  const canvasWidth = displaySize.value.width
    ? displaySize.value.width * zoom.value
    : canvas.clientWidth
  const canvasHeight = displaySize.value.height
    ? displaySize.value.height * zoom.value
    : canvas.clientHeight
  const maxX = Math.max(0, (canvasWidth - viewport.clientWidth) / 2)
  const maxY = Math.max(0, (canvasHeight - viewport.clientHeight) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, next.x)),
    y: Math.min(maxY, Math.max(-maxY, next.y)),
  }
}

function applyZoom(nextZoom: number, anchorX?: number, anchorY?: number): void {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
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
  if (props.images.length === 0) {
    return
  }
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  const delta = Math.max(-240, Math.min(240, event.deltaY * unit))
  applyZoom(zoom.value * Math.exp(-delta * 0.0018), event.clientX, event.clientY)
}

function onPointerDown(event: PointerEvent): void {
  if (zoom.value <= 1 || event.button !== 0) {
    return
  }
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) {
    return
  }

  event.preventDefault()
  target.setPointerCapture(event.pointerId)
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
  if (!panState || event.pointerId !== panState.pointerId) {
    return
  }

  offset.value = clampOffset({
    x: panState.originX + event.clientX - panState.startX,
    y: panState.originY + event.clientY - panState.startY,
  })
}

function onPointerUp(event: PointerEvent): void {
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

function onViewportKeydown(event: KeyboardEvent): void {
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
  const next = { ...offset.value }
  if (event.key === 'ArrowLeft') next.x -= step
  else if (event.key === 'ArrowRight') next.x += step
  else if (event.key === 'ArrowUp') next.y -= step
  else if (event.key === 'ArrowDown') next.y += step
  else return

  event.preventDefault()
  offset.value = clampOffset(next)
}

function handleResize(): void {
  if (zoom.value <= 1) {
    resetView()
  } else {
    offset.value = clampOffset(offset.value)
  }
  scheduleRender()
}

function renderPreview(): void {
  const canvas = canvasRef.value
  const viewport = viewportRef.value
  if (!canvas || !viewport || props.layout.width <= 0 || props.layout.height <= 0) {
    return
  }

  const availableWidth = Math.max(1, viewport.clientWidth)
  const availableHeight = Math.max(1, viewport.clientHeight)
  const fitScale = Math.min(
    1,
    availableWidth / props.layout.width,
    availableHeight / props.layout.height,
  )
  const baseWidth = Math.max(1, props.layout.width * fitScale)
  const baseHeight = Math.max(1, props.layout.height * fitScale)
  displaySize.value = { width: baseWidth, height: baseHeight }

  const visualWidth = baseWidth * zoom.value
  const visualHeight = baseHeight * zoom.value
  const dpr = Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR)
  // 按屏幕实际显示像素重绘，避免先缩小画布再用 CSS 放大导致发虚。
  const scaleForDisplay = Math.min(
    (visualWidth * dpr) / props.layout.width,
    (visualHeight * dpr) / props.layout.height,
  )
  const scaleForSide = PREVIEW_MAX_SIDE / Math.max(props.layout.width, props.layout.height)
  const scaleForPixels = Math.sqrt(
    PREVIEW_MAX_PIXELS / (props.layout.width * props.layout.height),
  )
  const renderScale = Math.max(
    0.01,
    Math.min(1, scaleForDisplay, scaleForSide, scaleForPixels),
  )

  renderStitch(canvas, props.layout, props.images, { scale: renderScale })
  if (zoom.value > 1) {
    offset.value = clampOffset(offset.value)
  }
}

function scheduleRender(): void {
  window.cancelAnimationFrame(renderFrame)
  renderFrame = window.requestAnimationFrame(renderPreview)
}

watch(() => props.layout, scheduleRender, { flush: 'post' })
watch(zoom, scheduleRender, { flush: 'post' })
watch(
  () => props.images.map((image) => image.id).join('|'),
  () => resetView(),
  { flush: 'post' },
)
onMounted(() => {
  scheduleRender()
  window.addEventListener('resize', handleResize)
})
onBeforeUnmount(() => {
  window.cancelAnimationFrame(renderFrame)
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <div
    class="preview-stage"
    :class="{ 'is-file-dragging': isFileDragging }"
    v-on="dropHandlers"
  >
    <div
      v-if="images.length > 0"
      ref="viewportRef"
      class="stage-viewport"
      :class="{ 'is-panning': isPanning, 'is-zoomed': zoom > 1 }"
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
        :style="canvasStyle"
      />
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

    <div v-if="images.length > 0" class="zoom-toolbar" role="toolbar" aria-label="预览缩放">
      <button
        class="zoom-button"
        type="button"
        :disabled="zoom <= MIN_ZOOM + 0.001"
        aria-label="缩小预览"
        title="缩小预览"
        @click="zoomBy(0.8)"
      >
        <Minus :size="14" :stroke-width="2" />
      </button>
      <button
        class="zoom-value tnum"
        type="button"
        :aria-label="`当前缩放 ${zoomPercent}，点击恢复适应窗口`"
        title="恢复到适应窗口"
        @click="resetView"
      >
        {{ zoomPercent }}
      </button>
      <button
        class="zoom-button"
        type="button"
        :disabled="zoom >= MAX_ZOOM - 0.001"
        aria-label="放大预览"
        title="放大预览"
        @click="zoomBy(1.25)"
      >
        <Plus :size="14" :stroke-width="2" />
      </button>
      <span class="zoom-separator" aria-hidden="true" />
      <button
        class="zoom-fit"
        type="button"
        title="恢复适应窗口"
        @click="resetView"
      >
        <Maximize2 :size="13" :stroke-width="1.9" />
        <span>适应</span>
      </button>
      <span class="zoom-hint" aria-hidden="true">滚轮缩放 · 拖动查看</span>
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
</template>

<style scoped>
.preview-stage {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  margin: 12px;
  padding: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: 13px;
  background-color: var(--surface-inset);
  background-image: radial-gradient(rgba(29, 64, 54, 0.13) 1px, transparent 1px);
  background-size: 16px 16px;
}

.stage-viewport {
  position: absolute;
  inset: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  cursor: zoom-in;
  touch-action: none;
}

.stage-viewport.is-zoomed {
  cursor: grab;
}

.stage-viewport.is-panning {
  cursor: grabbing;
}

.stage-viewport:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.preview-canvas {
  display: block;
  width: auto;
  height: auto;
  border-radius: 2px;
  background: var(--surface);
  cursor: inherit;
  transform-origin: center center;
  transition: transform 0.12s var(--ease);
  will-change: transform;
  box-shadow:
    0 0 0 1px rgba(19, 32, 28, 0.05),
    0 18px 44px -24px rgba(19, 32, 28, 0.34);
}

.stage-viewport.is-panning .preview-canvas {
  transition: none;
}

.zoom-toolbar {
  position: absolute;
  z-index: 3;
  bottom: 15px;
  left: 15px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--shadow-xs);
  backdrop-filter: blur(8px);
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
  top: 12px;
  right: 12px;
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
  .preview-stage {
    margin: 10px;
    padding: 16px;
  }

  .stage-viewport {
    inset: 16px;
  }

  .zoom-toolbar {
    bottom: 11px;
    left: 11px;
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
