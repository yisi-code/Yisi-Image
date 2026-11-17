import { onBeforeUnmount, ref } from 'vue'

function containsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * 只接管从系统拖入的文件，不干扰队列内部拖动排序。
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const isFileDragging = ref(false)
  let dragDepth = 0

  function reset(): void {
    dragDepth = 0
    isFileDragging.value = false
  }

  function onDragEnter(event: DragEvent): void {
    if (!containsFiles(event)) {
      return
    }
    event.preventDefault()
    dragDepth += 1
    isFileDragging.value = true
  }

  function onDragOver(event: DragEvent): void {
    if (!containsFiles(event)) {
      return
    }
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
    isFileDragging.value = true
  }

  function onDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) {
      isFileDragging.value = false
    }
  }

  function onDrop(event: DragEvent): void {
    if (!containsFiles(event)) {
      return
    }
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files ?? [])
    reset()
    if (files.length > 0) {
      onFiles(files)
    }
  }

  onBeforeUnmount(reset)

  return {
    isFileDragging,
    dropHandlers: {
      dragenter: onDragEnter,
      dragover: onDragOver,
      dragleave: onDragLeave,
      drop: onDrop,
    },
  }
}
