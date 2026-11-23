<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { formatDimensions, formatFileSize, getFormatLabel } from '../core/image'
import type { StitchImage } from '../core/types'
import { vTooltip } from '../directives/tooltip'

/**
 * 单图编辑的底部条：当前图片的格式、尺寸、大小，以及上一张 / 下一张。
 * 与拼接的底部控制条同高、同样式，切换模式时预览区不跳动。
 */
const props = withDefaults(
  defineProps<{
    images: StitchImage[]
    current: StitchImage | null
    /** 正在修瑕等计算时不能切换 */
    locked?: boolean
  }>(),
  {
    locked: false,
  },
)

const emit = defineEmits<{
  select: [index: number]
}>()

const index = computed(() =>
  props.current ? props.images.findIndex((image) => image.id === props.current?.id) : -1,
)
const formatLabel = computed(() =>
  props.current?.file ? getFormatLabel(props.current.file.type, props.current.name) : '',
)
const canPrev = computed(() => !props.locked && index.value > 0)
const canNext = computed(() => !props.locked && index.value >= 0 && index.value < props.images.length - 1)
const lockedTip = '正在处理当前图片，完成后再切换'
</script>

<template>
  <div class="edit-controls">
    <div class="edit-nav" role="group" aria-label="切换图片">
      <button
        v-tooltip="locked ? lockedTip : '上一张'"
        class="icon-button edit-nav__button"
        type="button"
        :disabled="!canPrev"
        aria-label="上一张"
        @click="emit('select', index - 1)"
      >
        <ChevronLeft :size="16" :stroke-width="1.9" />
      </button>
      <span class="edit-nav__count tnum">
        {{ current ? `${index + 1} / ${images.length}` : '0 / 0' }}
      </span>
      <button
        v-tooltip="locked ? lockedTip : '下一张'"
        class="icon-button edit-nav__button"
        type="button"
        :disabled="!canNext"
        aria-label="下一张"
        @click="emit('select', index + 1)"
      >
        <ChevronRight :size="16" :stroke-width="1.9" />
      </button>
    </div>

    <span class="control-divider" aria-hidden="true" />

    <dl v-if="current" class="edit-info tnum">
      <div>
        <dt class="control-label">原格式</dt>
        <dd>{{ formatLabel || '—' }}</dd>
      </div>
      <div>
        <dt class="control-label">尺寸</dt>
        <dd>{{ formatDimensions(current.width, current.height) }} px</dd>
      </div>
      <div>
        <dt class="control-label">大小</dt>
        <dd>{{ formatFileSize(current.size) }}</dd>
      </div>
    </dl>
    <span v-else class="control-label">还没有图片</span>

    <span class="edit-hint">导出时可转换格式、压缩或缩小尺寸</span>
  </div>
</template>

<style scoped>
.edit-controls {
  display: flex;
  min-height: 82px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 24px;
  padding: 13px 20px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface);
}

.edit-nav {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.edit-nav__count {
  min-width: 52px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.edit-info {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 26px;
}

.edit-info > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.edit-info dd {
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 650;
}

.edit-hint {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

@media (max-width: 1000px) {
  .edit-hint {
    display: none;
  }
}

@media (max-width: 700px) {
  .edit-controls {
    padding: 12px 14px;
  }

  .control-divider {
    display: none;
  }
}
</style>
