<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronsLeft, ChevronsRight, ChevronsUp, GripVertical } from 'lucide-vue-next'
import {
  anchorFloatingPosition,
  clampFloatingBox,
  resolveFloatingPosition,
} from '../core/floating'
import type { FloatingBox } from '../core/floating'
import type { PanelState } from '../core/settings'
import { vTooltip } from '../directives/tooltip'

/**
 * 预览区的浮动工具栏外壳：左侧拖动手柄、右侧收起按钮。
 * 默认位置由使用方的 class 决定（如左上、左下）；拖动后改为贴最近两条边的内联位置，
 * 在所在定位容器（offsetParent）内限制范围。工具栏内容通过默认插槽传入。
 * 收起后整个工具栏从画布隐去（由使用方 v-if 卸载），从预览标题栏的「显示」开关恢复，不在画布里留按钮。
 * docked 时固定在画布外的文档流里：没有拖动手柄、不读写位置，只保留收起按钮。
 */
const props = defineProps<{
  /** 工具栏名称，如「标注工具栏」；用于 aria-label 和提示文字 */
  label: string
  state: PanelState
  /** 固定在画布外（不浮动、不可拖动） */
  docked?: boolean
}>()

const emit = defineEmits<{
  'update:state': [state: PanelState]
}>()

const DRAG_THRESHOLD_PX = 3

const rootRef = ref<HTMLElement | null>(null)
const containerSize = ref({ width: 0, height: 0 })
const barSize = ref({ width: 0, height: 0 })
const dragBox = ref<FloatingBox | null>(null)
let dragState: {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  hasMoved: boolean
} | null = null
let resizeObserver: ResizeObserver | null = null

const collapseLabel = computed(() => `收起${props.label}（可在预览标题栏重新显示）`)
const isAnchoredRight = computed(() => props.state.position?.x === 'right')

const positionStyle = computed<Record<string, string> | undefined>(() => {
  if (props.docked) {
    return undefined
  }
  if (dragBox.value) {
    return {
      left: `${dragBox.value.left}px`,
      top: `${dragBox.value.top}px`,
      right: 'auto',
      bottom: 'auto',
    }
  }
  const position = props.state.position
  if (!position) {
    return undefined
  }
  const { width, height } = containerSize.value
  const resolved =
    width > 0 && height > 0
      ? resolveFloatingPosition(
          position,
          barSize.value.width,
          barSize.value.height,
          width,
          height,
        )
      : position
  return {
    left: resolved.x === 'left' ? `${resolved.dx}px` : 'auto',
    right: resolved.x === 'right' ? `${resolved.dx}px` : 'auto',
    top: resolved.y === 'top' ? `${resolved.dy}px` : 'auto',
    bottom: resolved.y === 'bottom' ? `${resolved.dy}px` : 'auto',
  }
})

function getContainer(): HTMLElement | null {
  const container = rootRef.value?.offsetParent
  return container instanceof HTMLElement ? container : null
}

function measure(): void {
  const root = rootRef.value
  if (!root) {
    return
  }
  barSize.value = { width: root.offsetWidth, height: root.offsetHeight }
  const container = getContainer()
  if (container) {
    containerSize.value = { width: container.clientWidth, height: container.clientHeight }
  }
}

function startDrag(event: PointerEvent): void {
  const root = rootRef.value
  const container = getContainer()
  if (event.button !== 0 || !root || !container) {
    return
  }
  event.preventDefault()
  const handle = event.currentTarget
  if (handle instanceof HTMLElement) {
    handle.setPointerCapture(event.pointerId)
  }
  measure()
  const rootRect = root.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    // 绝对定位以容器的内边距盒为基准，要扣掉容器边框。
    originLeft: rootRect.left - containerRect.left - container.clientLeft,
    originTop: rootRect.top - containerRect.top - container.clientTop,
    hasMoved: false,
  }
}

function moveDrag(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return
  }
  const dx = event.clientX - dragState.startX
  const dy = event.clientY - dragState.startY
  if (!dragState.hasMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
    return
  }
  dragState.hasMoved = true
  dragBox.value = clampFloatingBox(
    { left: dragState.originLeft + dx, top: dragState.originTop + dy },
    barSize.value.width,
    barSize.value.height,
    containerSize.value.width,
    containerSize.value.height,
  )
}

function endDrag(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return
  }
  const handle = event.currentTarget
  if (handle instanceof HTMLElement && handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId)
  }
  const box = dragBox.value
  const hasMoved = dragState.hasMoved
  dragState = null
  if (hasMoved && box) {
    emit('update:state', {
      ...props.state,
      position: anchorFloatingPosition(
        box,
        barSize.value.width,
        barSize.value.height,
        containerSize.value.width,
        containerSize.value.height,
      ),
    })
  }
  dragBox.value = null
}

function resetPosition(): void {
  if (props.state.position) {
    emit('update:state', { ...props.state, position: null })
  }
}

function collapse(): void {
  emit('update:state', { ...props.state, collapsed: true })
}

onMounted(() => {
  if (props.docked) {
    return
  }
  measure()
  resizeObserver = new ResizeObserver(measure)
  if (rootRef.value) {
    resizeObserver.observe(rootRef.value)
  }
  const container = getContainer()
  if (container) {
    resizeObserver.observe(container)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    ref="rootRef"
    class="floating-toolbar"
    :class="{ 'is-dragging': dragBox !== null, 'is-docked': docked }"
    :style="positionStyle"
    role="toolbar"
    :aria-label="label"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
    @wheel.stop
  >
    <span
      v-if="!docked"
      v-tooltip="'拖动移动 · 双击复位'"
      class="floating-toolbar__grip"
      aria-hidden="true"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @dblclick="resetPosition"
    >
      <GripVertical :size="13" :stroke-width="1.9" />
    </span>
    <slot />
    <span class="floating-toolbar__separator" aria-hidden="true" />
    <button
      v-tooltip="collapseLabel"
      class="floating-toolbar__collapse"
      type="button"
      :aria-label="collapseLabel"
      @click="collapse"
    >
      <ChevronsUp v-if="docked" :size="14" :stroke-width="1.9" />
      <ChevronsRight v-else-if="isAnchoredRight" :size="14" :stroke-width="1.9" />
      <ChevronsLeft v-else :size="14" :stroke-width="1.9" />
    </button>
  </div>
</template>

<style scoped>
.floating-toolbar {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 4px 3px 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow-xs);
  backdrop-filter: blur(8px);
  user-select: none;
}

/* 固定在画布外：放进文档流，宽度不够时换行，不压到画布上。 */
.floating-toolbar.is-docked {
  position: relative;
  max-width: 100%;
  flex-wrap: wrap;
  padding: 3px 4px;
  background: var(--surface);
  backdrop-filter: none;
}

.floating-toolbar.is-dragging {
  box-shadow: var(--shadow-float);
}

.floating-toolbar__grip {
  display: inline-flex;
  width: 14px;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--icon-ghost);
  cursor: grab;
  touch-action: none;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.floating-toolbar__grip:hover {
  background: var(--surface-hover);
  color: var(--text-muted);
}

.floating-toolbar.is-dragging .floating-toolbar__grip {
  cursor: grabbing;
}

.floating-toolbar__separator {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--border);
}

.floating-toolbar__collapse {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-muted);
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.floating-toolbar__collapse:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}
</style>
