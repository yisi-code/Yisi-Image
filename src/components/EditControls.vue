<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import BackgroundPicker from './BackgroundPicker.vue'
import { TRANSPARENT_BACKGROUND } from '../core/background'
import type { ExportFormat } from '../core/exportFormats'
import { formatDimensions, formatFileSize, getFormatLabel } from '../core/image'
import type { StitchImage } from '../core/types'
import { vTooltip } from '../directives/tooltip'

/**
 * 单图编辑的底部条：当前图片的格式、尺寸、大小，上一张 / 下一张，以及这张图透明处的底色。
 * 与拼接的底部控制条同高、同样式，切换模式时预览区不跳动。
 */
const props = withDefaults(
  defineProps<{
    images: StitchImage[]
    current: StitchImage | null
    /** 正在修瑕等计算时不能切换 */
    locked?: boolean
    /** 导出对话框里选的格式，只用来提示 JPG 不支持透明 */
    format: ExportFormat
  }>(),
  {
    locked: false,
  },
)

const emit = defineEmits<{
  select: [index: number]
  /** 改这张图透明处的底色（每张图各自记） */
  'update-background': [id: string, background: string]
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
const currentBackground = computed(() => props.current?.editBackground ?? TRANSPARENT_BACKGROUND)

function updateBackground(background: string): void {
  if (props.current) {
    emit('update-background', props.current.id, background)
  }
}
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

    <template v-if="current">
      <span class="control-divider" aria-hidden="true" />
      <BackgroundPicker
        :background="currentBackground"
        :format="format"
        fill-target="这张图透明的地方"
        group-label="这张图透明处的底色"
        @update:background="updateBackground"
      />
    </template>

    <span class="edit-hint">底色只对这张图生效 · 导出时可转换格式、压缩或缩小尺寸</span>
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
  margin: 0;
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

/* 加了背景选择后一行放下提示约要 1500 宽；更窄时藏起提示，底栏与拼接时同高、预览不跳。 */
@media (max-width: 1500px) {
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
