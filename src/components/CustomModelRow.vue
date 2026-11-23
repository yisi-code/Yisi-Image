<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { Check, PencilLine, Trash2 } from 'lucide-vue-next'
import type { CustomModel } from '../core/modelApi'
import { formatFileSize } from '../core/image'

/**
 * 设置页里一个自定义模型（清晰化或局部修瑕）：名称（可就地改名）、大小与 SHA-256 前几位、能不能用，
 * 以及设为默认、删除。行的样式与内置模型行共用（base.css 的 model-row）。
 */
const props = defineProps<{
  model: CustomModel
  /** 能不能用的说明，例如「可以使用」或缺运行库的原因 */
  stateText: string
  stateError: boolean
  selected: boolean
  busy: boolean
  /** 「设为默认」的说明，按用途写 */
  selectTitle: string
}>()

const emit = defineEmits<{
  select: [id: string]
  rename: [id: string, name: string]
  delete: [id: string]
}>()

const isEditing = ref(false)
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

async function startEdit(): Promise<void> {
  draft.value = props.model.name
  isEditing.value = true
  await nextTick()
  inputRef.value?.select()
}

function commitEdit(): void {
  const name = draft.value.trim()
  isEditing.value = false
  if (name && name !== props.model.name) {
    emit('rename', props.model.id, name)
  }
}

function cancelEdit(): void {
  isEditing.value = false
}
</script>

<template>
  <div class="model-row" :class="{ 'is-selected': selected }">
    <div class="model-row__info">
      <input
        v-if="isEditing"
        ref="inputRef"
        v-model="draft"
        class="custom-model__input"
        type="text"
        maxlength="60"
        aria-label="模型名称"
        @keydown.enter.prevent="commitEdit"
        @keydown.esc.prevent="cancelEdit"
        @blur="commitEdit"
      />
      <span v-else class="model-row__name">{{ model.name }}</span>
      <span class="model-row__state tnum" :class="{ 'is-error': stateError }">
        {{ formatFileSize(model.size) }} · SHA-256 {{ model.sha256.slice(0, 12) }} · {{ stateText }}
      </span>
    </div>
    <div class="model-row__actions">
      <span v-if="selected" class="model-row__badge">
        <Check :size="12" :stroke-width="2.2" />
        默认
      </span>
      <button
        v-else
        class="button button-secondary"
        type="button"
        :disabled="busy"
        :title="selectTitle"
        @click="emit('select', model.id)"
      >
        设为默认
      </button>
      <button
        class="button button-secondary"
        type="button"
        :disabled="busy || isEditing"
        @click="startEdit"
      >
        <PencilLine :size="14" :stroke-width="1.9" />
        改名
      </button>
      <button
        class="button button-secondary"
        type="button"
        :disabled="busy"
        @click="emit('delete', model.id)"
      >
        <Trash2 :size="14" :stroke-width="1.9" />
        删除
      </button>
    </div>
  </div>
</template>

<style scoped>
.custom-model__input {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 650;
}
</style>
