<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { AlertTriangle, Download } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    /** danger：删除、清空等不可撤销操作（红色确认按钮）；download：下载等普通确认 */
    tone?: 'danger' | 'download'
  }>(),
  {
    confirmLabel: '确认',
    cancelLabel: '取消',
    tone: 'danger',
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialogRef = ref<HTMLDialogElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    const dialog = dialogRef.value
    if (!dialog) {
      return
    }

    if (open && !dialog.open) {
      dialog.showModal()
      await nextTick()
      cancelRef.value?.focus()
      return
    }

    if (!open && dialog.open) {
      dialog.close()
    }
  },
  { immediate: true },
)

function cancel(event?: Event): void {
  event?.preventDefault()
  emit('cancel')
}

function onBackdropClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) {
    cancel()
  }
}

function onClosed(): void {
  if (props.open) {
    emit('cancel')
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialogRef"
      class="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      @cancel="cancel"
      @close="onClosed"
      @click="onBackdropClick"
    >
      <div class="confirm-card">
        <div class="confirm-heading">
          <span class="confirm-icon" :class="`confirm-icon--${tone}`" aria-hidden="true">
            <Download v-if="tone === 'download'" :size="20" :stroke-width="1.9" />
            <AlertTriangle v-else :size="20" :stroke-width="1.9" />
          </span>
          <div>
            <h2 id="confirm-title">{{ title }}</h2>
            <p id="confirm-description">{{ description }}</p>
          </div>
        </div>

        <div class="confirm-actions">
          <button
            ref="cancelRef"
            class="button button-secondary"
            type="button"
            @click="cancel()"
          >
            {{ cancelLabel }}
          </button>
          <button
            class="button"
            :class="tone === 'download' ? 'button-primary' : 'button-danger'"
            type="button"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.confirm-dialog {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 40px);
  margin: auto;
  padding: 0;
  overflow: visible;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--text);
}

.confirm-dialog::backdrop {
  background: rgba(16, 31, 27, 0.44);
  backdrop-filter: blur(2px);
}

.confirm-card {
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 30px 80px -24px rgba(10, 26, 22, 0.45);
}

.confirm-dialog[open] .confirm-card {
  animation: confirm-in 0.18s var(--ease);
}

@keyframes confirm-in {
  from {
    opacity: 0;
    transform: translateY(7px) scale(0.985);
  }
}

.confirm-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.confirm-icon {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  background: var(--danger-soft);
  color: var(--danger);
}

.confirm-icon--download {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.confirm-heading h2 {
  margin-top: 1px;
  color: var(--text-strong);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.015em;
}

.confirm-heading p {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}

.confirm-actions .button {
  height: 36px;
  padding: 0 15px;
}
</style>
