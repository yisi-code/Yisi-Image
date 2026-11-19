<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronsLeft, ChevronsRight, GripVertical } from 'lucide-vue-next'
import {
  anchorFloatingPosition,
  clampFloatingBox,
  resolveFloatingPosition,
} from '../core/floating'
import type { FloatingBox } from '../core/floating'
import type { ToolbarState } from '../core/settings'
import { vTooltip } from '../directives/tooltip'

/**
 * 预览区的浮动工具栏外壳：左侧拖动手柄、右侧收起按钮，收起后只留一个「显示」按钮。
 * 默认位置由使用方的 class 决定（如左上、左下）；拖动后改为贴最近两条边的内联位置，
 * 在所在定位容器（offsetParent）内限制范围。工具栏内容通过默认插槽传入，收起按钮的内容用 collapsed 插槽。
 */
const props = defineProps<{
  /** 工具栏名称，如「标注工具栏」；用于 aria-label 和提示文字 */
  label: string
  state: ToolbarState
}>()

const emit = defineEmits<{
  'update:state': [state: ToolbarState]
}>()

const DRAG_THRESHOLD_PX = 3

const rootRef = ref<HTMLElement | null>(null)
const expandRef = ref<HTMLButtonElement | null>(null)
const collapseRef = ref<HTMLButtonElement | null>(null)
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

const collapseLabel = computed(() => `收起${props.label}`)
const expandLabel = computed(() => `显示${props.label}`)
const isAnchoredRight = computed(() => props.state.position?.x === 'right')

const positionStyle = computed<Record<string, string> | undefined>(() => {
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

async function setCollapsed(collapsed: boolean): Promise<void> {
  emit('update:state', { ...props.state, collapsed })
  await nextTick()
  // 被点击的按钮已经卸载，把焦点交给替换它的按钮，键盘用户不会丢失位置。
  ;(collapsed ? expandRef.value : collapseRef.value)?.focus()
}

onMounted(() => {
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
    :class="{ 'is-collapsed': state.collapsed, 'is-dragging': dragBox !== null }"
    :style="positionStyle"
    role="toolbar"
    :aria-label="label"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
    @wheel.stop
  >
    <button
      v-if="state.collapsed"
      ref="expandRef"
      v-tooltip="expandLabel"
      class="floating-toolbar__expand"
      type="button"
      :aria-label="expandLabel"
      aria-expanded="false"
      @click="setCollapsed(false)"
    >
      <slot name="collapsed" />
    </button>

    <template v-else>
      <span
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
        ref="collapseRef"
        v-tooltip="collapseLabel"
        class="floating-toolbar__collapse"
        type="button"
        :aria-label="collapseLabel"
        aria-expanded="true"
        @click="setCollapsed(true)"
      >
        <ChevronsRight v-if="isAnchoredRight" :size="14" :stroke-width="1.9" />
        <ChevronsLeft v-else :size="14" :stroke-width="1.9" />
      </button>
    </template>
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

.floating-toolbar.is-collapsed {
  padding: 3px;
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

.floating-toolbar__collapse,
.floating-toolbar__expand {
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

.floating-toolbar__collapse {
  width: 26px;
}

.floating-toolbar__expand {
  gap: 5px;
  padding: 0 8px 0 7px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.floating-toolbar__collapse:hover,
.floating-toolbar__expand:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}
</style>
