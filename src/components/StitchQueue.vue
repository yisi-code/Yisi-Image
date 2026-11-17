<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  FilePlus2,
  GripVertical,
  ImagePlus,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  UploadCloud,
} from 'lucide-vue-next'
import { useFileDrop } from '../composables/useFileDrop'
import { SUPPORTED_FORMAT_LABEL, formatDimensions, formatFileSize } from '../core/image'
import type { ImportProgress, StitchImage } from '../core/types'

const props = defineProps<{
  images: StitchImage[]
  isImporting: boolean
  progress: ImportProgress
  clearedCount: number
  activeId?: string | null
}>()

const emit = defineEmits<{
  pick: []
  add: [files: File[]]
  remove: [id: string]
  reorder: [from: number, to: number]
  clear: []
  restore: []
  focus: [index: number]
  blank: []
}>()

const draggingIndex = ref<number | null>(null)
const dropTarget = ref<{ index: number; position: 'before' | 'after' } | null>(null)

const { isFileDragging, dropHandlers } = useFileDrop((files) => emit('add', files))

const progressLabel = computed(
  () => `正在读取 ${props.progress.done}/${props.progress.total}`,
)

function openFilePicker(): void {
  if (!props.isImporting) {
    emit('pick')
  }
}

function onDragStart(event: DragEvent, index: number): void {
  if (props.isImporting || props.images.length < 2) {
    event.preventDefault()
    return
  }

  if (event.target instanceof HTMLElement && event.target.closest('button')) {
    event.preventDefault()
    return
  }

  draggingIndex.value = index
  dropTarget.value = null

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/x-yisi-image', String(index))
    const card = event.currentTarget
    if (card instanceof HTMLElement) {
      event.dataTransfer.setDragImage(card, 24, 24)
    }
  }
}

function onDragOver(event: DragEvent, index: number): void {
  if (draggingIndex.value === null) {
    return
  }

  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }

  if (draggingIndex.value === index) {
    dropTarget.value = null
    return
  }

  const card = event.currentTarget
  if (!(card instanceof HTMLElement)) {
    return
  }

  const rect = card.getBoundingClientRect()
  const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  dropTarget.value = { index, position }
}

function onDragLeave(event: DragEvent, index: number): void {
  if (!dropTarget.value || dropTarget.value.index !== index) {
    return
  }

  const card = event.currentTarget
  const related = event.relatedTarget
  if (card instanceof HTMLElement && related instanceof Node && card.contains(related)) {
    return
  }

  dropTarget.value = null
}

function onDrop(event: DragEvent, index: number): void {
  if (draggingIndex.value === null) {
    return
  }

  event.preventDefault()
  const from = draggingIndex.value
  const position =
    dropTarget.value?.index === index ? dropTarget.value.position : 'before'
  const insertAt = index + (position === 'after' ? 1 : 0)
  const to = from < insertAt ? insertAt - 1 : insertAt

  resetDrag()

  if (from !== to) {
    emit('reorder', from, to)
  }
}

function resetDrag(): void {
  draggingIndex.value = null
  dropTarget.value = null
}

function onCardClick(event: MouseEvent, index: number): void {
  if (event.target instanceof HTMLElement && event.target.closest('.queue-remove')) {
    return
  }
  emit('focus', index)
}

function onCardKeydown(event: KeyboardEvent, index: number): void {
  if ((event.key === 'Enter' || event.key === ' ') && !event.altKey) {
    event.preventDefault()
    emit('focus', index)
    return
  }

  if (!event.altKey) {
    return
  }

  if (event.key === 'ArrowUp' && index > 0) {
    event.preventDefault()
    emit('reorder', index, index - 1)
  }

  if (event.key === 'ArrowDown' && index < props.images.length - 1) {
    event.preventDefault()
    emit('reorder', index, index + 1)
  }
}
</script>

<template>
  <aside
    class="queue-panel"
    :class="{ 'is-file-dragging': isFileDragging }"
    aria-label="图片拼接队列"
    v-on="dropHandlers"
  >
    <header class="queue-header">
      <div class="queue-heading">
        <h2>拼接队列</h2>
        <span class="queue-count">{{ images.length }} 张</span>
      </div>
      <button
        v-if="images.length > 0"
        class="queue-clear"
        type="button"
        :disabled="isImporting"
        :title="isImporting ? '读取图片时不能清空' : '清空队列'"
        @click="emit('clear')"
      >
        清空
      </button>
    </header>

    <div class="queue-body">
      <div v-if="images.length === 0 && clearedCount > 0" class="queue-restore">
        <span class="queue-restore-icon" aria-hidden="true">
          <RotateCcw :size="16" :stroke-width="1.9" />
        </span>
        <div class="queue-restore-copy">
          <strong>已清空 {{ clearedCount }} 张图片</strong>
          <span>可以恢复到清空前</span>
        </div>
        <button
          class="queue-restore-button"
          type="button"
          :disabled="isImporting"
          :title="isImporting ? '读取图片时不能恢复' : '恢复上次清空的图片'"
          @click="emit('restore')"
        >
          恢复
        </button>
      </div>

      <ol v-if="images.length > 0" class="queue-list">
        <li
          v-for="(image, index) in images"
          :key="image.id"
          class="queue-card"
          :class="{
            'is-active': image.id === activeId,
            'is-dragging': draggingIndex === index,
            'drop-before': dropTarget?.index === index && dropTarget.position === 'before',
            'drop-after': dropTarget?.index === index && dropTarget.position === 'after',
          }"
          :draggable="!isImporting && images.length > 1"
          tabindex="0"
          :aria-label="`第 ${index + 1} 张，${image.name}，${formatDimensions(image.width, image.height)} 像素。点击定位并放大到预览，按 Alt 加上下方向键调整顺序`"
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title="点击定位并放大到预览中的这张图片"
          @click="onCardClick($event, index)"
          @dragstart="onDragStart($event, index)"
          @dragend="resetDrag"
          @dragover="onDragOver($event, index)"
          @dragleave="onDragLeave($event, index)"
          @drop="onDrop($event, index)"
          @keydown="onCardKeydown($event, index)"
        >
          <span class="drag-handle" aria-hidden="true">
            <GripVertical :size="14" :stroke-width="1.8" />
          </span>

          <span class="queue-thumb" :class="{ 'queue-thumb--blank': image.kind === 'blank' }">
            <span v-if="image.kind === 'blank'" class="queue-blank-art" aria-hidden="true">
              <FilePlus2 :size="20" :stroke-width="1.6" />
              <span>空白</span>
            </span>
            <img v-else :src="image.url" :alt="image.name" draggable="false" />
            <span class="queue-index">{{ String(index + 1).padStart(2, '0') }}</span>
          </span>

          <span class="queue-info">
            <span class="queue-name" :title="image.name">{{ image.name }}</span>
            <span class="queue-meta tnum">
              {{ formatDimensions(image.width, image.height) }}
              <span aria-hidden="true">·</span>
              {{ image.kind === 'blank' ? '空白页' : formatFileSize(image.size) }}
            </span>
          </span>

          <button
            class="icon-button icon-button--danger queue-remove"
            type="button"
            :disabled="isImporting"
            :aria-label="`移除 ${image.name}`"
            :title="isImporting ? '读取图片时不能移除' : '移除这张图片'"
            @click.stop="emit('remove', image.id)"
          >
            <Trash2 :size="15" :stroke-width="1.8" />
          </button>
        </li>
      </ol>

      <div
        v-else
        class="queue-empty"
        :class="{ 'queue-empty--compact': clearedCount > 0 }"
      >
        <span class="queue-empty-icon" aria-hidden="true">
          <ImagePlus :size="20" :stroke-width="1.7" />
        </span>
        <p>添加的图片会显示在这里</p>
        <span>可以一次选择或拖入多张</span>
      </div>
    </div>

    <div class="queue-footer">
      <div class="queue-add-actions">
        <button
          class="queue-add-button"
          type="button"
          :disabled="isImporting"
          @click="openFilePicker"
        >
          <Loader2 v-if="isImporting" class="spin" :size="16" />
          <Plus v-else :size="16" :stroke-width="2" />
          <span>{{ isImporting ? progressLabel : '添加图片' }}</span>
          <span v-if="!isImporting" class="queue-add-hint">拖入也可</span>
        </button>
        <button
          class="queue-blank-button"
          type="button"
          :disabled="isImporting"
          :title="isImporting ? '读取图片时不能添加空白页' : '在当前选中图片后插入空白页'"
          @click="emit('blank')"
        >
          <FilePlus2 :size="15" :stroke-width="1.9" />
          <span>空白页</span>
        </button>
      </div>

      <p v-if="images.length > 1" class="queue-tip">
        拖动卡片调整顺序，或选中后按 <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd>
      </p>
      <p v-else class="queue-tip">支持 {{ SUPPORTED_FORMAT_LABEL }}</p>
    </div>

    <div v-if="isFileDragging" class="queue-drop-overlay" aria-hidden="true">
      <span class="drop-icon"><UploadCloud :size="22" :stroke-width="1.7" /></span>
      <strong>松开以添加图片</strong>
      <span>支持一次拖入多张</span>
    </div>
  </aside>
</template>

<style scoped>
.queue-panel {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}

.queue-header {
  display: flex;
  height: 58px;
  flex: 0 0 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px 0 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.queue-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.queue-heading h2 {
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.queue-count {
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  white-space: nowrap;
}

.queue-clear {
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 11.5px;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.queue-clear:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}

.queue-clear:disabled {
  opacity: 0.4;
}

.queue-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  scrollbar-gutter: stable;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-restore {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
  padding: 9px 10px;
  border: 1px solid var(--accent-line);
  border-radius: 10px;
  background: var(--surface-accent);
}

.queue-restore-icon {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}

.queue-restore-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.queue-restore-copy strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-restore-copy span {
  color: var(--text-muted);
  font-size: 10.5px;
  line-height: 1.45;
}

.queue-restore-button {
  height: 28px;
  flex: 0 0 auto;
  padding: 0 10px;
  border: 1px solid var(--accent-line-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  transition:
    background-color 0.15s var(--ease),
    border-color 0.15s var(--ease);
}

.queue-restore-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.queue-restore-button:disabled {
  opacity: 0.45;
}

.queue-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 3px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.15s var(--ease),
    background-color 0.15s var(--ease),
    box-shadow 0.15s var(--ease),
    opacity 0.15s var(--ease);
}

.queue-card:hover {
  border-color: var(--border-strong);
  background: var(--surface-raised);
}

.queue-card.is-active {
  border-color: var(--accent-line-strong);
  background: var(--surface-accent);
}

.queue-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.queue-card.is-dragging {
  opacity: 0.38;
  cursor: grabbing;
}

.queue-card.drop-before::before,
.queue-card.drop-after::after {
  position: absolute;
  right: 7px;
  left: 7px;
  height: 2px;
  border-radius: 999px;
  background: var(--accent);
  content: '';
  pointer-events: none;
}

.queue-card.drop-before::before {
  top: -5px;
}

.queue-card.drop-after::after {
  bottom: -5px;
}

.drag-handle {
  display: inline-flex;
  width: 16px;
  flex: 0 0 16px;
  align-items: center;
  justify-content: center;
  color: var(--icon-ghost);
  cursor: grab;
}

.queue-card:hover .drag-handle {
  color: var(--text-faint);
}

.queue-thumb {
  position: relative;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background-color: var(--surface-hover);
  background-image:
    linear-gradient(45deg, var(--checker) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker) 75%);
  background-position:
    0 0,
    0 6px,
    6px -6px,
    -6px 0;
  background-size: 12px 12px;
}

.queue-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.queue-thumb--blank {
  background: var(--surface);
}

.queue-blank-art {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--text-faint);
  font-size: 8px;
  letter-spacing: 0.02em;
}

.queue-index {
  position: absolute;
  bottom: 3px;
  left: 3px;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(19, 32, 28, 0.72);
  color: var(--surface);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1;
}

.queue-info {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}

.queue-name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-meta {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-remove {
  opacity: 0.55;
}

.queue-card:hover .queue-remove,
.queue-remove:focus-visible {
  opacity: 1;
}

.queue-empty {
  display: flex;
  min-height: 220px;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 20px;
  text-align: center;
}

.queue-empty--compact {
  min-height: 150px;
}

.queue-empty-icon {
  display: inline-flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  margin-bottom: 7px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface-subtle);
  color: var(--text-faint);
}

.queue-empty p {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.queue-empty > span:last-child {
  color: var(--text-faint);
  font-size: 10.5px;
}

.queue-footer {
  padding: 12px 14px 13px;
  border-top: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--surface), var(--surface-raised));
}

.queue-add-actions {
  display: flex;
  gap: 8px;
}

.queue-add-button {
  position: relative;
  display: flex;
  min-width: 0;
  height: 38px;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: var(--surface-subtle);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  transition:
    border-color 0.15s var(--ease),
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.queue-blank-button {
  display: flex;
  height: 38px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    border-color 0.15s var(--ease),
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.queue-blank-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.queue-blank-button:disabled {
  opacity: 0.45;
}

.queue-add-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.queue-add-button:disabled {
  color: var(--text-muted);
}

.queue-add-hint {
  position: absolute;
  right: 12px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 500;
}

.queue-tip {
  margin-top: 8px;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
}

kbd {
  display: inline-block;
  min-width: 16px;
  padding: 0 3px;
  border: 1px solid var(--border);
  border-bottom-color: var(--border-strong);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 9px;
  line-height: 14px;
}

.queue-drop-overlay {
  position: absolute;
  z-index: 5;
  inset: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  border: 2px dashed var(--accent);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.95);
  color: var(--accent);
  pointer-events: none;
}

.drop-icon {
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  margin-bottom: 5px;
  border-radius: 12px;
  background: var(--accent-soft);
}

.queue-drop-overlay strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
}

.queue-drop-overlay > span:last-child {
  color: var(--text-muted);
  font-size: 11px;
}
</style>
