import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import { AiCanceledError } from '../core/aiWorkerClient'
import { getBaseSource } from '../core/image'
import { SEGMENT_NOT_ENCODED } from '../core/matte'
import type { SegmentPoint } from '../core/matte'
import {
  accentRgb,
  alphaToCanvas,
  decodeSegment,
  encodeForSegment,
  highlightCanvas,
  segmentImageKey,
} from '../core/matteEngine'
import type { SegmentInput, SegmentModelChoice } from '../core/matteEngine'
import type { StitchImage } from '../core/types'

/** 几档选区的叫法：按面积从小到大，最多三档 */
const LEVEL_NAMES = ['细部', '部位', '整体'] as const

/**
 * 点选抠图的状态：选「抠图」工具后先在后台分析当前图片（编码，每张图一次），
 * 之后每点一下（保留点或排除点）解码出几档选区，预览里高亮当前这一档。
 * 提示点记在原图坐标里，清晰化换了画面也不用重点。
 */
export function useCutout(options: {
  /** 抠图作用的图片（单图是当前这张，拼接是选中的那张） */
  target: Ref<StitchImage | null>
  /** 「抠图」工具是否选中；没选中时不分析、不保留选点 */
  active: Ref<boolean>
  choice: Ref<SegmentModelChoice>
  onError: (message: string) => void
}) {
  const points = ref<SegmentPoint[]>([])
  /** 选点属于哪张图 */
  const pointImageId = ref<string | null>(null)
  /** 解码出的几档选区（编码尺寸的 0–255 透明度），从小到大 */
  const levels = shallowRef<Uint8ClampedArray[]>([])
  /** 用户选的档位；null 表示默认用最大的那档（整个物体） */
  const preferredLevel = ref<number | null>(null)
  const input = shallowRef<SegmentInput | null>(null)
  const phase = ref<'idle' | 'encoding' | 'decoding'>('idle')
  const progress = ref(0)
  let token = 0
  let encoding: { key: string; promise: Promise<SegmentInput> } | null = null

  const levelIndex = computed(() =>
    levels.value.length === 0
      ? -1
      : Math.min(levels.value.length - 1, preferredLevel.value ?? levels.value.length - 1),
  )
  /** 档位按钮：只有一档时不显示 */
  const levelOptions = computed(() => {
    const names = LEVEL_NAMES.slice(LEVEL_NAMES.length - Math.min(3, levels.value.length))
    return levels.value.length > 1 ? names.map((name, index) => ({ index, name })) : []
  })
  const hasSelection = computed(() => levelIndex.value >= 0 && input.value !== null)

  const highlight = computed(() => {
    const size = input.value
    const alpha = levels.value[levelIndex.value]
    if (!size || !alpha || !pointImageId.value) {
      return null
    }
    return {
      imageId: pointImageId.value,
      overlay: markRaw(highlightCanvas(alpha, size.width, size.height, accentRgb())),
    }
  })

  function messageOf(error: unknown): string {
    return error instanceof Error && error.message ? error.message : '抠图计算失败'
  }

  /** 分析这张图当前的画面；同一份画面只分析一次，分析中再要就等同一个结果。 */
  function ensureEncoded(image: StitchImage): Promise<SegmentInput> {
    const state = options.choice.value
    const source = getBaseSource(image)
    if (!state.ready || !source) {
      return Promise.reject(new Error(state.ready ? '这张图没有可分析的画面' : state.reason))
    }
    const key = segmentImageKey(image.id, source)
    if (input.value?.imageKey === key) {
      return Promise.resolve(input.value)
    }
    if (encoding?.key === key) {
      return encoding.promise
    }
    phase.value = 'encoding'
    progress.value = 0
    const promise = encodeForSegment(key, source, image.width, image.height, state, (fraction) => {
      if (encoding?.key === key) {
        progress.value = fraction
      }
    })
      .then((result) => {
        input.value = result
        return result
      })
      .finally(() => {
        if (encoding?.key === key) {
          encoding = null
          if (phase.value === 'encoding') {
            phase.value = 'idle'
          }
        }
      })
    encoding = { key, promise }
    return promise
  }

  async function decode(image: StitchImage): Promise<void> {
    const state = options.choice.value
    if (!state.ready || points.value.length === 0) {
      return
    }
    const current = (token += 1)
    try {
      let size = await ensureEncoded(image)
      if (current !== token) {
        return
      }
      phase.value = 'decoding'
      let masks: Uint8ClampedArray[]
      try {
        masks = await decodeSegment(size, points.value, state)
      } catch (error) {
        // Worker 重建或换了模型后编码结果没了：重新分析一次再解码。
        if (!(error instanceof Error) || error.message !== SEGMENT_NOT_ENCODED) {
          throw error
        }
        input.value = null
        size = await ensureEncoded(image)
        masks = await decodeSegment(size, points.value, state)
      }
      if (current === token) {
        levels.value = masks
      }
    } catch (error) {
      if (current === token && !(error instanceof AiCanceledError)) {
        console.error('抠图失败', error)
        options.onError(messageOf(error))
      }
    } finally {
      if (current === token && phase.value === 'decoding') {
        phase.value = 'idle'
      }
    }
  }

  /** 点一下：在原图坐标 point 处加一个保留点或排除点，换了图片就从头选。 */
  function addPoint(image: StitchImage, point: SegmentPoint): void {
    if (pointImageId.value !== image.id) {
      clear()
      pointImageId.value = image.id
    }
    points.value = [...points.value, point]
    void decode(image)
  }

  /** 去掉最后一个点（选错时退一步）。 */
  function undoPoint(image: StitchImage): void {
    if (points.value.length <= 1) {
      clear()
      return
    }
    points.value = points.value.slice(0, -1)
    void decode(image)
  }

  function setLevel(index: number): void {
    preferredLevel.value = index
  }

  /** 清掉选点和选区；正在算的结果到了也丢掉。分析结果保留，下次点选不用重新分析。 */
  function clear(): void {
    token += 1
    points.value = []
    pointImageId.value = null
    levels.value = []
    preferredLevel.value = null
    if (phase.value === 'decoding') {
      phase.value = 'idle'
    }
  }

  /** 当前这一档选区做成画布（编码尺寸，按 alpha 表示），交给调用方合到遮罩上。 */
  function selectionCanvas(): HTMLCanvasElement | null {
    const size = input.value
    const alpha = levels.value[levelIndex.value]
    return size && alpha ? alphaToCanvas(alpha, size.width, size.height) : null
  }

  // 选中「抠图」工具后先在后台分析当前图片，点下去时就不用等编码。
  watch(
    [options.active, () => options.target.value?.id ?? null, () => options.choice.value.ready],
    ([active]) => {
      const image = options.target.value
      if (!active) {
        clear()
        return
      }
      if (pointImageId.value && pointImageId.value !== image?.id) {
        clear()
      }
      if (image?.kind === 'image' && options.choice.value.ready) {
        ensureEncoded(image).catch((error: unknown) => {
          if (!(error instanceof AiCanceledError)) {
            console.error('抠图分析画面失败', error)
            options.onError(messageOf(error))
          }
        })
      }
    },
  )

  return {
    points,
    pointImageId,
    levelIndex,
    levelOptions,
    hasSelection,
    highlight,
    phase,
    progress,
    addPoint,
    undoPoint,
    setLevel,
    clear,
    selectionCanvas,
  }
}
