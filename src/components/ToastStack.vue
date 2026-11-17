<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-vue-next'
import type { ToastItem } from '../composables/useToasts'

defineProps<{
  toasts: ToastItem[]
}>()

const emit = defineEmits<{
  dismiss: [id: string]
}>()

const toneIcons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-region" aria-label="操作提示">
      <TransitionGroup name="toast" tag="div" class="toast-list">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          :class="`toast--${toast.tone}`"
          :role="toast.tone === 'error' ? 'alert' : 'status'"
        >
          <span class="toast-icon" aria-hidden="true">
            <component :is="toneIcons[toast.tone]" :size="17" :stroke-width="1.9" />
          </span>
          <div class="toast-copy">
            <p class="toast-title">{{ toast.title }}</p>
            <p v-if="toast.message" class="toast-message">{{ toast.message }}</p>
          </div>
          <button
            class="toast-close"
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            @click="emit('dismiss', toast.id)"
          >
            <X :size="14" :stroke-width="2" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-region {
  position: fixed;
  z-index: 60;
  /* 让开右侧缩略图轨，提示不能压住缩略图与当前项高亮。 */
  right: 128px;
  /* 避开底部拼接控制条，避免提示遮住间距输入与导出说明。 */
  bottom: 108px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}

.toast-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 11px 12px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: var(--shadow-float);
  pointer-events: auto;
  backdrop-filter: blur(8px);
}

.toast-icon {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border-radius: 8px;
}

.toast--success .toast-icon {
  background: var(--success-soft);
  color: var(--success);
}

.toast--error .toast-icon {
  background: var(--danger-soft);
  color: var(--danger);
}

.toast--info .toast-icon {
  background: var(--info-soft);
  color: var(--info);
}

.toast-copy {
  min-width: 0;
  flex: 1;
}

.toast-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.5;
}

.toast-message {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.toast-close {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border-radius: 5px;
  color: var(--text-faint);
  opacity: 0.6;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease),
    opacity 0.15s var(--ease);
}

.toast-close:hover {
  background: var(--surface-inset);
  color: var(--text);
  opacity: 1;
}

.toast-enter-active,
.toast-leave-active,
.toast-move {
  transition:
    opacity 0.22s var(--ease),
    transform 0.22s var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.toast-leave-active {
  position: absolute;
  right: 0;
  left: 0;
}

@media (max-width: 600px) {
  .toast-region {
    right: 12px;
    bottom: 12px;
    width: calc(100vw - 24px);
  }
}
</style>
