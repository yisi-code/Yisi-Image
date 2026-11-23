<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { AlertTriangle, Download, Loader2, X } from 'lucide-vue-next'
import CompareView from './CompareView.vue'
import type { StitchBackground } from '../core/background'
import {
  buildExportFileName,
  getExportBackground,
  getExportFormat,
  getSaveTypes,
  isTransparencyDropped,
} from '../core/exportFormats'
import type { ExportFormat, ExportFormatOption } from '../core/exportFormats'
import { encodeCanvas, releaseCanvas } from '../core/exportJob'
import type { EncodedImage, ExportItem, ExportSummary } from '../core/exportJob'
import {
  MAX_LONG_EDGE,
  MAX_PERCENT,
  MAX_QUALITY,
  MAX_TARGET_KB,
  MIN_LONG_EDGE,
  MIN_PERCENT,
  MIN_QUALITY,
  MIN_TARGET_KB,
  getOutputSize,
  getSizeChangePercent,
  makeUniqueFileName,
  replaceExtension,
  usesTargetSize,
} from '../core/exportOptions'
import type { CompressMode, ExportOptions, ResizeMode } from '../core/exportOptions'
import { formatDimensions, formatFileSize } from '../core/image'
import { inspectOutputSize } from '../core/layout'
import { UnsupportedExportFormatError } from '../core/render'
import {
  downloadBlob,
  getDirectoryPicker,
  getSavePicker,
  hasEntry,
  isSaveCanceled,
  writeBlobToHandle,
} from '../core/save'
import type { SaveDirectoryHandle, SaveFileHandle } from '../core/save'

/**
 * 导出对话框：拼接与单图编辑共用。
 * 左边是导出效果的前后对比（真实编码后再解码），右边是格式、压缩与尺寸设置；
 * 点「保存」时才打开系统保存窗口（必须由点击直接触发），单图模式可按同一设置批量导出全部。
 */
const props = defineProps<{
  open: boolean
  mode: 'stitch' | 'single'
  items: ExportItem[]
  /** 预览与「导出当前」针对的那一项；为空时取第一项 */
  currentId: string | null
  options: ExportOptions
  formats: readonly ExportFormatOption[]
  /** 拼接用设置里的背景；单图传 transparent，PNG / WebP 保留原图透明 */
  background: StitchBackground
}>()

const emit = defineEmits<{
  close: []
  'update:options': [options: ExportOptions]
  exported: [summary: ExportSummary]
}>()

type ExportScope = 'current' | 'all'

interface PreviewResult extends EncodedImage {
  key: string
  bitmap: ImageBitmap
}

const PREVIEW_DELAY_MS = 260
const DOWNLOAD_GAP_MS = 260

const RESIZE_OPTIONS: Array<{ value: ResizeMode; label: string; title: string }> = [
  { value: 'none', label: '原尺寸', title: '保持原始像素尺寸' },
  { value: 'percent', label: '百分比', title: '按百分比等比缩小' },
  { value: 'longEdge', label: '最长边', title: '把最长边限制在指定像素以内，原本更小的不放大' },
]

const COMPRESS_OPTIONS: Array<{ value: CompressMode; label: string; title: string }> = [
  { value: 'quality', label: '按质量', title: '用滑块直接设定质量' },
  { value: 'target', label: '目标大小', title: '输入想要的文件大小，自动找不超过它的最高质量' },
]

const dialogRef = ref<HTMLDialogElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
const scope = ref<ExportScope>('current')
const isSaving = ref(false)
const saveProgress = ref({ done: 0, total: 0 })
const saveError = ref('')
const isPreviewing = ref(false)
const previewError = ref('')
const previewSource = shallowRef<HTMLCanvasElement | null>(null)
const previewResult = shallowRef<PreviewResult | null>(null)
let sourceKey = ''
let previewToken = 0
let previewTimer: ReturnType<typeof setTimeout> | undefined
let cancelRequested = false

const previewItem = computed(
  () => props.items.find((item) => item.id === props.currentId) ?? props.items[0] ?? null,
)
const format = computed(() => getExportFormat(props.options.format))
const exportBackground = computed(() => getExportBackground(props.background, format.value))
const transparencyDropped = computed(() => isTransparencyDropped(props.background, format.value))
const outputSize = computed(() =>
  previewItem.value
    ? getOutputSize(previewItem.value.width, previewItem.value.height, props.options)
    : null,
)
const sizeCheck = computed(() =>
  outputSize.value ? inspectOutputSize(outputSize.value.width, outputSize.value.height) : null,
)
const isBatch = computed(
  () => props.mode === 'single' && scope.value === 'all' && props.items.length > 1,
)
const targetActive = computed(() => usesTargetSize(props.options))
const currentResult = computed(() =>
  previewResult.value && previewItem.value && previewResult.value.key === resultKey(previewItem.value)
    ? previewResult.value
    : null,
)
const sizeChange = computed(() =>
  currentResult.value && previewItem.value
    ? getSizeChangePercent(previewItem.value.originalSize, currentResult.value.blob.size)
    : null,
)

const title = computed(() => (props.mode === 'stitch' ? '导出拼接图片' : '导出图片'))
const subtitle = computed(() => {
  const item = previewItem.value
  if (!item) {
    return ''
  }
  return props.mode === 'stitch'
    ? `拼接结果 ${formatDimensions(item.width, item.height)} px`
    : `${item.name} · ${formatDimensions(item.width, item.height)} px`
})
const beforeLabel = computed(() => (props.mode === 'stitch' ? '未压缩' : '原图'))
const afterLabel = computed(() => `导出 ${format.value.label}`)
const canSave = computed(
  () => !isSaving.value && previewItem.value !== null && (isBatch.value || sizeCheck.value?.ok === true),
)
const saveLabel = computed(() => {
  if (isSaving.value) {
    return isBatch.value
      ? `正在保存 ${saveProgress.value.done}/${saveProgress.value.total}`
      : '正在保存'
  }
  return isBatch.value ? `保存全部 ${props.items.length} 张` : '保存'
})
const locationNote = computed(() => {
  if (isBatch.value) {
    return getDirectoryPicker()
      ? '保存时选择文件夹；同名文件不会被覆盖，会自动加序号'
      : '当前浏览器不能选文件夹，会逐个下载到默认下载目录'
  }
  return getSavePicker() ? '保存时可选择位置和文件名' : '保存到浏览器默认下载目录'
})
const qualityStyle = computed(
  () =>
    ({
      '--range-progress': `${((props.options.quality - MIN_QUALITY) / (MAX_QUALITY - MIN_QUALITY)) * 100}%`,
    }) as CSSProperties,
)
const percentStyle = computed(
  () =>
    ({
      '--range-progress': `${((props.options.percent - MIN_PERCENT) / (MAX_PERCENT - MIN_PERCENT)) * 100}%`,
    }) as CSSProperties,
)

function resultKey(item: ExportItem): string {
  return `${item.id}|${JSON.stringify(props.options)}|${props.background}`
}

function update(patch: Partial<ExportOptions>): void {
  emit('update:options', { ...props.options, ...patch })
}

function setFormat(value: ExportFormat): void {
  if (!isSaving.value && value !== props.options.format) {
    update({ format: value })
  }
}

type NumberKey = 'quality' | 'percent' | 'longEdge' | 'targetKb'

const NUMBER_RANGES: Record<NumberKey, [number, number]> = {
  quality: [MIN_QUALITY, MAX_QUALITY],
  percent: [MIN_PERCENT, MAX_PERCENT],
  longEdge: [MIN_LONG_EDGE, MAX_LONG_EDGE],
  targetKb: [MIN_TARGET_KB, MAX_TARGET_KB],
}

/**
 * 输入过程中只把超过上限的值压回上限；低于下限的先不动（例如输入 40 时先出现的 4），
 * 等离开输入框时再按范围收口，避免打一个数字就被改成下限。
 */
function applyNumber(event: Event, key: NumberKey): void {
  const input = event.target as HTMLInputElement
  const [min, max] = NUMBER_RANGES[key]
  const parsed = Number(input.value)
  if (input.value.trim() === '' || !Number.isFinite(parsed) || parsed < min) {
    return
  }
  const safe = Math.min(max, Math.round(parsed))
  if (parsed > max) {
    input.value = String(safe)
  }
  if (safe !== props.options[key]) {
    update({ [key]: safe })
  }
}

function commitNumber(event: FocusEvent, key: NumberKey): void {
  const input = event.target as HTMLInputElement
  const [min, max] = NUMBER_RANGES[key]
  const parsed = Number(input.value)
  if (input.value.trim() === '' || !Number.isFinite(parsed)) {
    input.value = String(props.options[key])
    return
  }
  const safe = Math.min(max, Math.max(min, Math.round(parsed)))
  input.value = String(safe)
  if (safe !== props.options[key]) {
    update({ [key]: safe })
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function clearPreview(): void {
  previewToken += 1
  window.clearTimeout(previewTimer)
  releaseCanvas(previewSource.value)
  previewSource.value = null
  sourceKey = ''
  previewResult.value?.bitmap.close()
  previewResult.value = null
  isPreviewing.value = false
  previewError.value = ''
}

function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  if (!props.open) {
    return
  }
  // 设置变了旧结果就过时了，立刻显示「正在生成」，避免看着旧图读新数字。
  isPreviewing.value = true
  previewTimer = setTimeout(() => void runPreview(), PREVIEW_DELAY_MS)
}

async function runPreview(): Promise<void> {
  const item = previewItem.value
  const output = outputSize.value
  const check = sizeCheck.value
  const token = ++previewToken
  if (!props.open || !item || !output || !check) {
    isPreviewing.value = false
    return
  }
  if (!check.ok) {
    previewError.value = check.reason
    isPreviewing.value = false
    return
  }
  previewError.value = ''
  isPreviewing.value = true
  await nextFrame()
  if (token !== previewToken) {
    return
  }
  try {
    const key = `${item.id}|${output.scale}|${exportBackground.value ?? 'none'}`
    if (key !== sourceKey || !previewSource.value) {
      releaseCanvas(previewSource.value)
      previewSource.value = item.render(output.scale, exportBackground.value)
      sourceKey = key
    }
    const encoded = await encodeCanvas(previewSource.value, format.value, props.options)
    if (token !== previewToken) {
      return
    }
    const bitmap = await createImageBitmap(encoded.blob)
    if (token !== previewToken) {
      bitmap.close()
      return
    }
    previewResult.value?.bitmap.close()
    previewResult.value = { ...encoded, key: resultKey(item), bitmap }
  } catch (error) {
    if (token === previewToken) {
      console.error('生成导出预览失败', error)
      previewError.value =
        error instanceof UnsupportedExportFormatError
          ? '当前浏览器不支持所选格式，请换一种格式'
          : '生成预览失败，可以换个设置再试'
    }
  } finally {
    if (token === previewToken) {
      isPreviewing.value = false
    }
  }
}

/** 编码一项；与当前预览完全相同时直接用预览结果，不重复编码。 */
async function encodeItem(item: ExportItem): Promise<EncodedImage & { width: number; height: number }> {
  const output = getOutputSize(item.width, item.height, props.options)
  const cached = previewResult.value
  if (cached && cached.key === resultKey(item) && !isPreviewing.value) {
    return { blob: cached.blob, quality: cached.quality, fits: cached.fits, ...output }
  }
  await nextFrame()
  const canvas = item.render(output.scale, exportBackground.value)
  try {
    const encoded = await encodeCanvas(canvas, format.value, props.options)
    return { ...encoded, width: output.width, height: output.height }
  } finally {
    releaseCanvas(canvas)
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsupportedExportFormatError) {
    return '当前浏览器不支持所选格式，请换一种格式'
  }
  return '保存失败，请稍后重试；无法选择位置时会改存到默认下载目录'
}

async function saveCurrent(): Promise<void> {
  const item = previewItem.value
  if (!item || sizeCheck.value?.ok !== true) {
    return
  }
  const formatOption = format.value
  const fileName =
    props.mode === 'stitch'
      ? buildExportFileName(new Date(), formatOption.value)
      : replaceExtension(item.name, formatOption.extension)
  const picker = getSavePicker()
  let target: SaveFileHandle | null = null
  if (picker) {
    // 保存窗口必须在点击里直接打开，先选位置再编码。
    try {
      target = await picker({ suggestedName: fileName, types: getSaveTypes(formatOption) })
    } catch (error) {
      if (!isSaveCanceled(error)) {
        console.error('打开保存窗口失败', error)
        saveError.value = describeError(error)
      }
      return
    }
  }

  isSaving.value = true
  saveError.value = ''
  try {
    const encoded = await encodeItem(item)
    if (target) {
      await writeBlobToHandle(target, encoded.blob)
    } else {
      downloadBlob(encoded.blob, fileName)
    }
    emit('exported', {
      count: 1,
      failed: [],
      canceled: false,
      format: formatOption,
      location: target ? 'file' : 'download',
      totalBefore: item.originalSize,
      totalAfter: encoded.blob.size,
      width: encoded.width,
      height: encoded.height,
      transparencyDropped: transparencyDropped.value,
      unmetTarget: encoded.fits ? 0 : 1,
    })
  } catch (error) {
    console.error('导出图片失败', error)
    saveError.value = describeError(error)
  } finally {
    isSaving.value = false
  }
}

/** 在已用名单和目标文件夹里都避开同名，绝不覆盖已有文件。 */
async function pickFileName(
  base: string,
  taken: Set<string>,
  directory: SaveDirectoryHandle | null,
): Promise<string> {
  const isTaken = (name: string) => taken.has(name.toLowerCase())
  let name = makeUniqueFileName(base, isTaken)
  while (directory && (await hasEntry(directory, name))) {
    taken.add(name.toLowerCase())
    name = makeUniqueFileName(base, isTaken)
  }
  taken.add(name.toLowerCase())
  return name
}

async function saveAll(): Promise<void> {
  const items = props.items.slice()
  const formatOption = format.value
  const picker = getDirectoryPicker()
  let directory: SaveDirectoryHandle | null = null
  if (picker) {
    try {
      directory = await picker()
    } catch (error) {
      if (!isSaveCanceled(error)) {
        console.error('打开文件夹选择窗口失败', error)
        saveError.value = describeError(error)
      }
      return
    }
  }

  isSaving.value = true
  saveError.value = ''
  cancelRequested = false
  saveProgress.value = { done: 0, total: items.length }
  const taken = new Set<string>()
  const failed: string[] = []
  let count = 0
  let totalBefore = 0
  let totalAfter = 0
  let unmetTarget = 0
  let last = { width: 0, height: 0 }

  for (const item of items) {
    if (cancelRequested) {
      break
    }
    const output = getOutputSize(item.width, item.height, props.options)
    if (!inspectOutputSize(output.width, output.height).ok) {
      failed.push(item.name)
    } else {
      try {
        const encoded = await encodeItem(item)
        const name = await pickFileName(
          replaceExtension(item.name, formatOption.extension),
          taken,
          directory,
        )
        if (directory) {
          const handle = await directory.getFileHandle(name, { create: true })
          await writeBlobToHandle(handle, encoded.blob)
        } else {
          downloadBlob(encoded.blob, name)
          // 连续触发下载太快时浏览器会丢掉一部分，留一点间隔。
          await delay(DOWNLOAD_GAP_MS)
        }
        count += 1
        totalBefore += item.originalSize
        totalAfter += encoded.blob.size
        unmetTarget += encoded.fits ? 0 : 1
        last = { width: encoded.width, height: encoded.height }
      } catch (error) {
        console.error('批量导出失败', item.name, error)
        failed.push(item.name)
      }
    }
    saveProgress.value = { done: saveProgress.value.done + 1, total: items.length }
  }

  isSaving.value = false
  emit('exported', {
    count,
    failed,
    canceled: cancelRequested,
    format: formatOption,
    location: directory ? 'folder' : 'download',
    totalBefore,
    totalAfter,
    width: last.width,
    height: last.height,
    transparencyDropped: transparencyDropped.value,
    unmetTarget,
  })
}

function save(): void {
  if (!canSave.value) {
    return
  }
  void (isBatch.value ? saveAll() : saveCurrent())
}

function requestClose(event?: Event): void {
  event?.preventDefault()
  if (isSaving.value) {
    // 批量保存中「取消」等于停止：已保存的保留，剩下的不再处理。
    cancelRequested = true
    return
  }
  emit('close')
}

function onBackdropClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) {
    requestClose()
  }
}

function onClosed(): void {
  if (props.open) {
    emit('close')
  }
}

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    const dialog = dialogRef.value
    if (!dialog) {
      return
    }
    if (open && !dialog.open) {
      scope.value = 'current'
      saveError.value = ''
      dialog.showModal()
      await nextTick()
      closeButtonRef.value?.focus()
      schedulePreview()
      return
    }
    if (!open) {
      clearPreview()
      if (dialog.open) {
        dialog.close()
      }
    }
  },
  { immediate: true },
)

watch(
  [previewItem, () => props.options, () => props.background],
  () => {
    saveError.value = ''
    schedulePreview()
  },
  { deep: true },
)

onBeforeUnmount(clearPreview)
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialogRef"
      class="export-dialog"
      aria-labelledby="export-title"
      @cancel="requestClose"
      @close="onClosed"
      @click="onBackdropClick"
    >
      <div class="export-card">
        <header class="export-header">
          <span class="export-icon" aria-hidden="true">
            <Download :size="18" :stroke-width="1.9" />
          </span>
          <div class="export-heading">
            <h2 id="export-title">{{ title }}</h2>
            <p class="tnum">{{ subtitle }}</p>
          </div>
          <button
            ref="closeButtonRef"
            class="icon-button export-close"
            type="button"
            :aria-label="isSaving ? '停止保存' : '关闭'"
            :title="isSaving ? '停止保存' : '关闭（Esc）'"
            @click="requestClose()"
          >
            <X :size="16" :stroke-width="1.9" />
          </button>
        </header>

        <div class="export-body">
          <section class="export-preview" aria-label="导出效果对比">
            <CompareView
              :before="previewSource"
              :after="currentResult?.bitmap ?? null"
              :width="outputSize?.width ?? 0"
              :height="outputSize?.height ?? 0"
              :before-label="beforeLabel"
              :after-label="afterLabel"
              :busy="isPreviewing"
            />
          </section>

          <section class="export-settings" aria-label="导出设置">
            <div v-if="mode === 'single' && items.length > 1" class="export-field">
              <span class="control-label">导出范围</span>
              <div class="segmented" role="group" aria-label="导出范围">
                <button
                  type="button"
                  class="segment"
                  :class="{ 'is-active': scope === 'current' }"
                  :aria-pressed="scope === 'current'"
                  :disabled="isSaving"
                  @click="scope = 'current'"
                >
                  当前这张
                </button>
                <button
                  type="button"
                  class="segment"
                  :class="{ 'is-active': scope === 'all' }"
                  :aria-pressed="scope === 'all'"
                  :disabled="isSaving"
                  @click="scope = 'all'"
                >
                  全部 {{ items.length }} 张
                </button>
              </div>
            </div>

            <div class="export-field">
              <span class="control-label">格式</span>
              <div class="segmented" role="group" aria-label="导出格式">
                <button
                  v-for="option in formats"
                  :key="option.value"
                  type="button"
                  class="segment"
                  :class="{ 'is-active': options.format === option.value }"
                  :aria-pressed="options.format === option.value"
                  :disabled="isSaving"
                  :title="`导出为 ${option.longLabel}`"
                  @click="setFormat(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>

            <div class="export-field">
              <span class="control-label">压缩</span>
              <template v-if="format.supportsQuality">
                <div class="segmented" role="group" aria-label="压缩方式">
                  <button
                    v-for="option in COMPRESS_OPTIONS"
                    :key="option.value"
                    type="button"
                    class="segment"
                    :class="{ 'is-active': options.compressBy === option.value }"
                    :aria-pressed="options.compressBy === option.value"
                    :disabled="isSaving"
                    :title="option.title"
                    @click="update({ compressBy: option.value })"
                  >
                    {{ option.label }}
                  </button>
                </div>
                <div v-if="options.compressBy === 'quality'" class="export-range">
                  <input
                    class="range-slider"
                    type="range"
                    :value="options.quality"
                    :min="MIN_QUALITY"
                    :max="MAX_QUALITY"
                    step="1"
                    :style="qualityStyle"
                    :disabled="isSaving"
                    aria-label="质量"
                    :aria-valuetext="`${options.quality}%`"
                    @input="applyNumber($event, 'quality')"
                  />
                  <span class="number-field">
                    <input
                      type="number"
                      :value="options.quality"
                      :min="MIN_QUALITY"
                      :max="MAX_QUALITY"
                      step="1"
                      inputmode="numeric"
                      :disabled="isSaving"
                      aria-label="质量，百分比"
                      @input="applyNumber($event, 'quality')"
                      @blur="commitNumber($event, 'quality')"
                    />
                    <span>%</span>
                  </span>
                </div>
                <div v-else class="export-inline">
                  <span class="number-field number-field--wide">
                    <input
                      type="number"
                      :value="options.targetKb"
                      :min="MIN_TARGET_KB"
                      :max="MAX_TARGET_KB"
                      step="10"
                      inputmode="numeric"
                      :disabled="isSaving"
                      aria-label="目标大小，单位 KB"
                      @input="applyNumber($event, 'targetKb')"
                      @blur="commitNumber($event, 'targetKb')"
                    />
                    <span>KB 以内</span>
                  </span>
                </div>
              </template>
              <p v-else class="export-note">
                {{ format.label }} 是无损格式，没有质量可调；要减小文件请缩小尺寸，或改用 JPG / WebP。
              </p>
            </div>

            <div class="export-field">
              <span class="control-label">尺寸</span>
              <div class="segmented" role="group" aria-label="缩小尺寸">
                <button
                  v-for="option in RESIZE_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="segment"
                  :class="{ 'is-active': options.resize === option.value }"
                  :aria-pressed="options.resize === option.value"
                  :disabled="isSaving"
                  :title="option.title"
                  @click="update({ resize: option.value })"
                >
                  {{ option.label }}
                </button>
              </div>
              <div v-if="options.resize === 'percent'" class="export-range">
                <input
                  class="range-slider"
                  type="range"
                  :value="options.percent"
                  :min="MIN_PERCENT"
                  :max="MAX_PERCENT"
                  step="1"
                  :style="percentStyle"
                  :disabled="isSaving"
                  aria-label="缩放百分比"
                  :aria-valuetext="`${options.percent}%`"
                  @input="applyNumber($event, 'percent')"
                />
                <span class="number-field">
                  <input
                    type="number"
                    :value="options.percent"
                    :min="MIN_PERCENT"
                    :max="MAX_PERCENT"
                    step="1"
                    inputmode="numeric"
                    :disabled="isSaving"
                    aria-label="缩放百分比"
                    @input="applyNumber($event, 'percent')"
                    @blur="commitNumber($event, 'percent')"
                  />
                  <span>%</span>
                </span>
              </div>
              <div v-else-if="options.resize === 'longEdge'" class="export-inline">
                <span class="number-field number-field--wide">
                  <input
                    type="number"
                    :value="options.longEdge"
                    :min="MIN_LONG_EDGE"
                    :max="MAX_LONG_EDGE"
                    step="10"
                    inputmode="numeric"
                    :disabled="isSaving"
                    aria-label="最长边，单位像素"
                    @input="applyNumber($event, 'longEdge')"
                    @blur="commitNumber($event, 'longEdge')"
                  />
                  <span>px 以内</span>
                </span>
              </div>
            </div>

            <dl class="export-result tnum" aria-live="polite">
              <div>
                <dt>输出尺寸</dt>
                <dd>
                  {{ outputSize ? `${formatDimensions(outputSize.width, outputSize.height)} px` : '—' }}
                </dd>
              </div>
              <div>
                <dt>文件大小</dt>
                <dd>
                  <template v-if="currentResult">
                    {{ formatFileSize(currentResult.blob.size) }}
                    <span v-if="previewItem && previewItem.originalSize > 0" class="export-result__sub">
                      原图 {{ formatFileSize(previewItem.originalSize) }}<template v-if="sizeChange !== null">
                        · {{ sizeChange > 0 ? '+' : '' }}{{ sizeChange }}%</template>
                    </span>
                  </template>
                  <template v-else>{{ isPreviewing ? '计算中…' : '—' }}</template>
                </dd>
              </div>
              <div v-if="targetActive && currentResult?.quality !== null && currentResult">
                <dt>自动质量</dt>
                <dd>{{ Math.round((currentResult.quality ?? 0) * 100) }}%</dd>
              </div>
            </dl>

            <p v-if="isBatch" class="export-note">
              按同样的设置逐张导出全部 {{ items.length }} 张，文件名沿用原名并换成 .{{ format.extension }}；预览显示的是当前这张。
            </p>
            <p v-if="targetActive && currentResult && !currentResult.fits" class="export-warning">
              <AlertTriangle :size="13" :stroke-width="1.9" aria-hidden="true" />
              质量降到最低仍超过 {{ options.targetKb }} KB，请再缩小尺寸。
            </p>
            <p v-if="transparencyDropped" class="export-warning">
              <AlertTriangle :size="13" :stroke-width="1.9" aria-hidden="true" />
              JPG 不支持透明，透明部分会按白底导出。
            </p>
            <p v-if="previewError" class="export-warning">
              <AlertTriangle :size="13" :stroke-width="1.9" aria-hidden="true" />
              {{ previewError }}
            </p>
            <p v-if="saveError" class="export-warning" role="alert">
              <AlertTriangle :size="13" :stroke-width="1.9" aria-hidden="true" />
              {{ saveError }}
            </p>
          </section>
        </div>

        <footer class="export-footer">
          <span class="export-location">{{ locationNote }}</span>
          <button class="button button-secondary" type="button" @click="requestClose()">
            {{ isSaving ? (isBatch ? '停止' : '请稍候') : '取消' }}
          </button>
          <button
            class="button button-primary"
            type="button"
            :disabled="!canSave"
            :aria-busy="isSaving"
            @click="save"
          >
            <Loader2 v-if="isSaving" class="spin" :size="15" :stroke-width="2" />
            <Download v-else :size="15" :stroke-width="2" />
            <span class="tnum">{{ saveLabel }}</span>
          </button>
        </footer>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.export-dialog {
  width: min(1000px, calc(100vw - 32px));
  height: min(680px, calc(100dvh - 32px));
  max-width: none;
  max-height: none;
  margin: auto;
  padding: 0;
  overflow: visible;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--text);
}

.export-dialog::backdrop {
  background: rgba(16, 31, 27, 0.44);
  backdrop-filter: blur(2px);
}

.export-card {
  display: flex;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 30px 80px -24px rgba(10, 26, 22, 0.45);
}

.export-dialog[open] .export-card {
  animation: export-in 0.18s var(--ease);
}

@keyframes export-in {
  from {
    opacity: 0;
    transform: translateY(7px) scale(0.985);
  }
}

.export-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 14px 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.export-icon {
  display: inline-flex;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.export-heading {
  min-width: 0;
  flex: 1;
}

.export-heading h2 {
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.012em;
}

.export-heading p {
  overflow: hidden;
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export-close {
  flex: 0 0 auto;
}

.export-body {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) 300px;
}

.export-preview {
  display: flex;
  min-width: 0;
  min-height: 0;
  padding: 14px 14px 14px 18px;
}

.export-settings {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding: 16px 18px;
  border-left: 1px solid var(--border-subtle);
  background: var(--surface-subtle);
}

.export-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.export-field .segmented {
  align-self: flex-start;
  max-width: 100%;
}

.export-field .segment {
  height: 28px;
  padding: 0 10px;
  white-space: nowrap;
}

.export-range {
  display: flex;
  align-items: center;
  gap: 10px;
}

.export-range .range-slider {
  min-width: 0;
  flex: 1;
}

.export-inline {
  display: flex;
  align-items: center;
}

.number-field--wide input {
  width: 64px;
}

.export-note {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.65;
}

.export-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--warning);
  font-size: 11px;
  line-height: 1.6;
}

.export-warning svg {
  flex: 0 0 auto;
  margin-top: 2px;
}

.export-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.export-result > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.export-result dt {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: 11px;
}

.export-result dd {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 650;
  text-align: right;
}

.export-result__sub {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 500;
}

.export-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-subtle);
}

.export-location {
  min-width: 0;
  flex: 1;
  color: var(--text-faint);
  font-size: 11px;
}

.export-footer .button {
  height: 36px;
  padding: 0 15px;
}

@media (max-width: 820px) {
  .export-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 300px auto;
    overflow-y: auto;
  }

  .export-settings {
    overflow: visible;
    border-top: 1px solid var(--border-subtle);
    border-left: 0;
  }

  .export-location {
    display: none;
  }
}
</style>
