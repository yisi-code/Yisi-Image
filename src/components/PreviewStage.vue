<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import {
  clampPreviewOffset,
  getFocusOffset,
  getImageFillZoom,
  getMaxPreviewZoom,
  getPreviewFit,
} from '../core/preview'
import { renderStitchView } from '../core/render'
import { THUMBNAIL_SIZE_PX } from '../core/settings'
import type {
  ThumbnailFit,
  ThumbnailOrientation,
  ThumbnailSize,
} from '../core/settings'
import type { ImportProgress, StitchImage, StitchLayout } from '../core/types'

const props = defineProps<{
  images: StitchImage[]
  layout: StitchLayout
  isImporting: boolean
  progress: ImportProgress
  thumbOrientation: ThumbnailOrientation
  thumbSize: ThumbnailSize
  thumbFit: ThumbnailFit
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const zoom = ref(1)
const maxZoom = ref(4)
const offset = ref({ x: 0, y: 0 })
const isPanning = ref(false)
const activeImageId = ref<string | null>(null)
const thumbnailRailRef = ref<HTMLElement | null>(null)
let renderFrame = 0
let panState: {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
} | null = null

const MIN_ZOOM = 0.5
const PREVIEW_MAX_DPR = 2
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

function resetView(): void {
  zoom.value = 1
  offset.value = { x: 0, y: 0 }
  isPanning.value = false
  panState = null
}

function updateActiveImage(): void {
  const viewport = viewportRef.value
  if (!viewport || !props.layout.items.length || displaySize.value.width <= 0) {
    activeImageId.value = null
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
}

function focusImage(index: number): void {
  const viewport = viewportRef.value
  const item = props.layout.items[index]
  if (!viewport || !item || displaySize.value.width <= 0) {
    return
  }

  const fitScale = displaySize.value.width / props.layout.width
  const fillZoom = getImageFillZoom(
    item,
    viewport.clientWidth,
    viewport.clientHeight,
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
  scheduleRender()
  updateActiveImage()
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
  const fit = getPreviewFit(props.layout, viewportWidth, viewportHeight)
  if (fit.scale <= 0) {
    return
  }

  displaySize.value = { width: fit.width, height: fit.height }
  maxZoom.value = getMaxPreviewZoom(props.layout, viewportWidth, viewportHeight)

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
  updateActiveImage()
}

function scheduleRender(): void {
  window.cancelAnimationFrame(renderFrame)
  renderFrame = window.requestAnimationFrame(renderPreview)
}

watch(() => props.layout, scheduleRender, { flush: 'post' })
watch(zoom, scheduleRender, { flush: 'post' })
watch(activeImageId, (id) => void scrollActiveThumbnail(id))
watch(
  [resolvedThumbOrientation, () => props.thumbSize],
  () => {
    scheduleRender()
    void scrollActiveThumbnail(activeImageId.value)
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
    }
    previousImageIds = [...nextIds]
    scheduleRender()
  },
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

defineExpose({ focusImage })
</script>

<template>
  <div
    class="preview-stage"
    :class="{ 'is-file-dragging': isFileDragging }"
    :style="thumbStyle"
    v-on="dropHandlers"
  >
    <div v-if="images.length > 0" class="preview-workbench">
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
          <img :src="image.url" alt="" draggable="false" />
          <span class="preview-thumbnail__index tnum">{{ index + 1 }}</span>
        </button>
      </nav>

      <div
        ref="viewportRef"
        class="stage-viewport"
        :class="{
          'stage-viewport--thumb-vertical': resolvedThumbOrientation === 'vertical',
          'is-panning': isPanning,
          'is-zoomed': zoom > 1,
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
        :disabled="zoom >= maxZoom - 0.001"
        :aria-label="`放大预览，最大 ${maxZoomPercent}`"
        :title="`放大预览（最大 ${maxZoomPercent}）`"
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

    <div
      v-if="isImporting && images.length > 0"
      class="stage-busy"
      :class="{ 'stage-busy--beside-rail': resolvedThumbOrientation === 'vertical' }"
      role="status"
    >
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
  --thumb-w: 92px;
  --thumb-h: 56px;
  --thumb-fit: contain;

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

.preview-workbench {
  position: absolute;
  inset: 0;
}

.stage-viewport {
  position: absolute;
  inset: calc(var(--thumb-h) + 36px) 24px 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  cursor: zoom-in;
  touch-action: none;
}

.stage-viewport--thumb-vertical {
  inset: 24px calc(var(--thumb-w) + 42px) 24px 24px;
}

.preview-thumbnails {
  position: absolute;
  z-index: 2;
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
  top: 14px;
  right: 24px;
  left: 24px;
  height: calc(var(--thumb-h) + 14px);
  flex-direction: row;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 2px 8px;
  scroll-snap-type: x proximity;
}

.preview-thumbnails--vertical {
  top: 24px;
  right: 24px;
  bottom: 24px;
  width: calc(var(--thumb-w) + 14px);
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

.stage-busy--beside-rail {
  right: calc(var(--thumb-w) + 42px);
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
    inset: calc(var(--thumb-h) + 28px) 16px 16px;
  }

  .stage-viewport--thumb-vertical {
    inset: 16px calc(var(--thumb-w) + 34px) 16px 16px;
  }

  .preview-thumbnails {
    gap: 4px;
  }

  .preview-thumbnails--horizontal {
    top: 10px;
    right: 16px;
    left: 16px;
    height: calc(var(--thumb-h) + 14px);
  }

  .preview-thumbnails--vertical {
    top: 16px;
    right: 16px;
    bottom: 16px;
    width: calc(var(--thumb-w) + 14px);
  }

  .zoom-toolbar {
    bottom: 11px;
    left: 11px;
  }

  .stage-busy {
    right: 16px;
    bottom: 46px;
  }

  .stage-busy--beside-rail {
    right: calc(var(--thumb-w) + 38px);
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
