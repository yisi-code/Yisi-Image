import { onBeforeUnmount, ref } from 'vue'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  tone: ToastTone
  title: string
  message?: string
}

export interface ToastInput {
  tone: ToastTone
  title: string
  message?: string
  duration?: number
}

const MAX_VISIBLE_TOASTS = 4

export function useToasts() {
  const toasts = ref<ToastItem[]>([])
  const timers = new Map<string, number>()
  let sequence = 0

  function dismiss(id: string): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.delete(id)
    }
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function dismissAll(): void {
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
    toasts.value = []
  }

  function push(input: ToastInput): string {
    sequence += 1
    const id = `toast-${Date.now()}-${sequence}`

    if (toasts.value.length >= MAX_VISIBLE_TOASTS) {
      const oldest = toasts.value[0]
      if (oldest) {
        dismiss(oldest.id)
      }
    }

    toasts.value = [
      ...toasts.value,
      {
        id,
        tone: input.tone,
        title: input.title,
        ...(input.message ? { message: input.message } : {}),
      },
    ]

    const duration = input.duration ?? (input.tone === 'error' ? 5600 : 3200)
    // duration 为 0 表示保留到用户手动关闭。
    if (duration > 0) {
      const timer = window.setTimeout(() => dismiss(id), duration)
      timers.set(id, timer)
    }

    return id
  }

  onBeforeUnmount(() => {
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
    toasts.value = []
  })

  return {
    toasts,
    push,
    dismiss,
    dismissAll,
  }
}
