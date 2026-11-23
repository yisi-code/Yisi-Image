<script setup lang="ts">
import { computed } from 'vue'
import { Download, Pause, Play, Trash2 } from 'lucide-vue-next'
import type { ModelId, ModelStatus } from '../core/modelApi'

/**
 * 设置页里一个 AI 模型的下载行：名称、状态文字、进度条，以及下载 / 暂停 / 继续 / 删除。
 * 局部修瑕与清晰化两个分类共用。
 */
const props = defineProps<{
  label: string
  status: ModelStatus | null
  stateText: string
  busy: boolean
}>()

const emit = defineEmits<{
  download: [id: ModelId]
  pause: [id: ModelId]
  delete: [id: ModelId]
}>()

const percent = computed(() =>
  props.status && props.status.total > 0
    ? Math.floor((props.status.downloaded / props.status.total) * 100)
    : 0,
)
</script>

<template>
  <div class="model-row">
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

<style scoped>
.model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 14px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
}

.model-row__info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.model-row__name {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 650;
}

.model-row__state {
  color: var(--text-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.model-row__state.is-error {
  color: var(--danger);
}

.model-row__actions {
  display: flex;
  grid-column: 2;
  grid-row: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.model-progress {
  grid-column: 1 / -1;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border);
}

.model-progress__bar {
  display: block;
  width: var(--model-progress, 0%);
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.3s var(--ease);
}

@media (max-width: 620px) {
  .model-row {
    grid-template-columns: 1fr;
  }

  .model-row__actions {
    grid-column: 1;
    grid-row: auto;
    justify-content: flex-start;
  }
}
</style>
