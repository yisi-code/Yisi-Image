<script setup lang="ts">
import { computed } from 'vue'
import { Check, Download, Pause, Play, Trash2 } from 'lucide-vue-next'
import type { ModelId, ModelStatus } from '../core/modelApi'

/**
 * 设置页里一个 AI 模型的下载行：名称、状态文字、进度条，以及下载 / 暂停 / 继续 / 删除。
 * 局部修瑕与清晰化两个分类共用；清晰化里还能「设为默认」。行的样式在 base.css（与自定义模型行共用）。
 */
const props = withDefaults(
  defineProps<{
    label: string
    status: ModelStatus | null
    stateText: string
    busy: boolean
    /** 显示「设为默认」 */
    selectable?: boolean
    selected?: boolean
  }>(),
  {
    selectable: false,
    selected: false,
  },
)

const emit = defineEmits<{
  download: [id: ModelId]
  pause: [id: ModelId]
  delete: [id: ModelId]
  select: [id: ModelId]
}>()

const percent = computed(() =>
  props.status && props.status.total > 0
    ? Math.floor((props.status.downloaded / props.status.total) * 100)
    : 0,
)
</script>

<template>
  <div class="model-row" :class="{ 'is-selected': selected }">
    <div class="model-row__info">
      <span class="model-row__name">{{ label }}</span>
      <span class="model-row__state" :class="{ 'is-error': status?.state === 'error' }">
        {{ stateText }}
      </span>
    </div>
    <div
      v-if="(status?.state ?? 'missing') !== 'missing'"
      class="model-progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
      :aria-label="`${label} 下载进度`"
      :style="{ '--model-progress': `${percent}%` }"
    >
      <span class="model-progress__bar" />
    </div>
    <div v-if="status" class="model-row__actions">
      <span v-if="selectable && selected" class="model-row__badge">
        <Check :size="12" :stroke-width="2.2" />
        默认
      </span>
      <button
        v-else-if="selectable"
        class="button button-secondary"
        type="button"
        :disabled="busy"
        title="清晰化面板选 AI 时默认用这个模型"
        @click="emit('select', status.id)"
      >
        设为默认
      </button>
      <button
        v-if="status.state === 'downloading' || status.state === 'queued'"
        class="button button-secondary"
        type="button"
        :disabled="busy"
        @click="emit('pause', status.id)"
      >
        <Pause :size="14" :stroke-width="1.9" />
        暂停
      </button>
      <button
        v-else-if="status.state === 'paused'"
        class="button button-secondary"
        type="button"
        :disabled="busy"
        @click="emit('download', status.id)"
      >
        <Play :size="14" :stroke-width="1.9" />
        继续下载
      </button>
      <button
        v-else-if="status.state === 'missing' || status.state === 'error'"
        class="button button-secondary"
        type="button"
        :disabled="busy"
        @click="emit('download', status.id)"
      >
        <Download :size="14" :stroke-width="1.9" />
        {{ status.state === 'error' ? '重新下载' : '下载' }}
      </button>
      <button
        v-if="status.modelDownloaded > 0 && status.state !== 'verifying'"
        class="button button-secondary"
        type="button"
        :disabled="busy"
        @click="emit('delete', status.id)"
      >
        <Trash2 :size="14" :stroke-width="1.9" />
        删除
      </button>
    </div>
  </div>
</template>
