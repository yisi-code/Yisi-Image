import { computed, onBeforeUnmount, ref } from 'vue'
import {
  createBlankPage,
  decodeImageFile,
  isSupportedImage,
  releaseImage,
} from '../core/image'
import type { ImportProgress, ImportReport, StitchImage } from '../core/types'
import type { ContentTransform } from '../core/imageTransform'

type Outcome =
  | { kind: 'image'; image: StitchImage }
  | { kind: 'skipped'; name: string }
  | { kind: 'failed'; name: string }

const DECODE_CONCURRENCY = 3

export function useImageQueue() {
  const images = ref<StitchImage[]>([])
  const isImporting = ref(false)
  const progress = ref<ImportProgress>({ done: 0, total: 0 })
  const clearedImages = ref<StitchImage[]>([])
  const clearedCount = computed(() => clearedImages.value.length)
  let blankSequence = 0
  let disposed = false

  async function addFiles(files: readonly File[]): Promise<ImportReport> {
    if (isImporting.value) {
      return { added: 0, skipped: [], failed: [], busy: true }
    }

    const pending = Array.from(files)
    if (pending.length === 0) {
      return { added: 0, skipped: [], failed: [], busy: false }
    }

    isImporting.value = true
    progress.value = { done: 0, total: pending.length }

    const outcomes: Outcome[] = new Array(pending.length)
    let cursor = 0
    let done = 0

    const worker = async () => {
      while (cursor < pending.length) {
        const index = cursor
        cursor += 1
        const file = pending[index]

        if (!isSupportedImage(file)) {
          outcomes[index] = { kind: 'skipped', name: file.name }
        } else {
          try {
            const image = await decodeImageFile(file)
            outcomes[index] = { kind: 'image', image }
          } catch {
            outcomes[index] = { kind: 'failed', name: file.name }
          }
        }

        done += 1
        progress.value = { done, total: pending.length }
      }
    }

    try {
      const workers = Array.from(
        { length: Math.min(DECODE_CONCURRENCY, pending.length) },
        () => worker(),
      )
      await Promise.all(workers)
    } finally {
      isImporting.value = false
    }

    const loaded = outcomes.flatMap((outcome) =>
      outcome?.kind === 'image' ? [outcome.image] : [],
    )
    const skipped = outcomes.flatMap((outcome) =>
      outcome?.kind === 'skipped' ? [outcome.name] : [],
    )
    const failed = outcomes.flatMap((outcome) =>
      outcome?.kind === 'failed' ? [outcome.name] : [],
    )

    if (disposed) {
      loaded.forEach(releaseImage)
      return { added: 0, skipped, failed, busy: false }
    }

    if (loaded.length > 0) {
      images.value = [...images.value, ...loaded]
    }

    return { added: loaded.length, skipped, failed, busy: false }
  }

  function removeImage(id: string): void {
    const target = images.value.find((image) => image.id === id)
    if (!target) {
      return
    }
    releaseImage(target)
    images.value = images.value.filter((image) => image.id !== id)
  }

  function addBlankAt(index = images.value.length): number {
    blankSequence += 1
    const target = Math.max(0, Math.min(index, images.value.length))
    const blank = createBlankPage(`空白页 ${blankSequence}`)
    const next = [...images.value]
    next.splice(target, 0, blank)
    images.value = next
    return target
  }

  function resizeBlank(id: string, width: number, height: number): void {
    const target = images.value.find((image) => image.id === id && image.kind === 'blank')
    if (!target) {
      return
    }
    target.width = Math.max(40, Math.min(16_384, Math.round(width)))
    target.height = Math.max(40, Math.min(16_384, Math.round(height)))
  }

  /** 调整工具：设置一张图的缩放 / 裁剪；null 表示还原。空白页不用。 */
  function setTransform(id: string, transform: ContentTransform | null): void {
    const target = images.value.find((image) => image.id === id && image.kind === 'image')
    if (target) {
      target.transform = transform ?? undefined
    }
  }

  /** 拼接时拖动一张图：position 是相对自动位置的位移（布局像素）；null 表示归位。 */
  function setPosition(id: string, position: { x: number; y: number } | null): void {
    const target = images.value.find((image) => image.id === id)
    if (target) {
      target.position = position && (position.x !== 0 || position.y !== 0) ? { ...position } : undefined
    }
  }

  /** 按从下往上的编号顺序重排图层：每张图的图层就是它在顺序里的位置。 */
  function setLayerOrder(order: readonly string[]): void {
    const rank = new Map(order.map((id, index) => [id, index]))
    for (const image of images.value) {
      const layer = rank.get(image.id)
      if (layer !== undefined) {
        image.layer = layer
      }
    }
  }

  /** 单图编辑：这张图透明处填的底色；transparent 时去掉。 */
  function setEditBackground(id: string, background: string): void {
    const target = images.value.find((image) => image.id === id)
    if (target) {
      target.editBackground = background === 'transparent' ? undefined : background
    }
  }

  function moveImage(from: number, to: number): void {
    const lastIndex = images.value.length - 1
    if (from === to || from < 0 || to < 0 || from > lastIndex || to > lastIndex) {
      return
    }

    const next = [...images.value]
    const [moved] = next.splice(from, 1)
    if (!moved) {
      return
    }
    next.splice(to, 0, moved)
    images.value = next
  }

  function clearImages(): number {
    if (images.value.length === 0) {
      return 0
    }

    // 清空后图片对象仍要留给“恢复”，只释放上一次的快照，避免反复清空导致 URL 泄漏。
    clearedImages.value.forEach(releaseImage)
    const removed = images.value
    images.value = []
    clearedImages.value = removed
    return removed.length
  }

  function restoreCleared(): number {
    if (clearedImages.value.length === 0 || images.value.length > 0) {
      return 0
    }

    const restored = clearedImages.value
    clearedImages.value = []
    images.value = restored
    return restored.length
  }

  onBeforeUnmount(() => {
    disposed = true
    images.value.forEach(releaseImage)
    clearedImages.value.forEach(releaseImage)
    images.value = []
    clearedImages.value = []
  })

  return {
    images,
    isImporting,
    progress,
    clearedCount,
    addFiles,
    addBlankAt,
    resizeBlank,
    setTransform,
    setPosition,
    setLayerOrder,
    setEditBackground,
    removeImage,
    moveImage,
    clearImages,
    restoreCleared,
  }
}
