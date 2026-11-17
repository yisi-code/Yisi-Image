<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Info,
  Layers3,
  Loader2,
  ShieldCheck,
} from 'lucide-vue-next'
import AboutPage from './components/AboutPage.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import PreviewStage from './components/PreviewStage.vue'
import StitchControls from './components/StitchControls.vue'
import StitchQueue from './components/StitchQueue.vue'
import ToastStack from './components/ToastStack.vue'
import { useImageQueue } from './composables/useImageQueue'
import { useToasts } from './composables/useToasts'
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_QUALITY,
  buildExportFileName,
  getExportFormat,
  getSaveTypes,
  getSupportedExportFormats,
} from './core/exportFormats'
import type { ExportFormat } from './core/exportFormats'
import { IMAGE_ACCEPT, SUPPORTED_FORMAT_LABEL, formatDimensions } from './core/image'
import { DEFAULT_GAP, calculateStitchLayout, inspectOutputSize } from './core/layout'
import { UnsupportedExportFormatError, canvasToBlob, renderStitch } from './core/render'
import {
  downloadBlob,
  getSavePicker,
  isSaveCanceled,
  writeBlobToHandle,
} from './core/save'
import type { SaveFileHandle } from './core/save'
import type { StitchDirection } from './core/types'

const direction = ref<StitchDirection>('vertical')
const gap = ref(DEFAULT_GAP)
const exportFormat = ref<ExportFormat>(DEFAULT_EXPORT_FORMAT)
const supportedFormats = getSupportedExportFormats()
const activeFormat = computed(() => getExportFormat(exportFormat.value))
const isExporting = ref(false)
const isClearDialogOpen = ref(false)
const activeView = ref<'workspace' | 'about'>('workspace')
const fileInputRef = ref<HTMLInputElement | null>(null)
const aboutButtonRef = ref<HTMLButtonElement | null>(null)
const aboutPageRef = ref<{ focusTitle: () => void } | null>(null)
const canChooseSaveLocation = getSavePicker() !== null

const {
  images,
  isImporting,
  progress,
  clearedCount,
  addFiles,
  removeImage,
  moveImage,
  clearImages,
  restoreCleared,
} = useImageQueue()
const { toasts, push, dismiss, dismissAll } = useToasts()

const layout = computed(() =>
  calculateStitchLayout(images.value, direction.value, gap.value),
)

const outputCheck = computed(() =>
  inspectOutputSize(layout.value.width, layout.value.height),
)

const canExport = computed(
  () => images.value.length >= 2 && outputCheck.value.ok && !isExporting.value,
)

const previewStatus = computed(() => {
  if (images.value.length === 0) {
    return isImporting.value
      ? `正在读取 ${progress.value.done}/${progress.value.total}`
      : '等待添加图片'
  }
  if (!outputCheck.value.ok) {
    return outputCheck.value.reason
  }
  if (images.value.length === 1) {
    return '再添加 1 张即可拼接'
  }
  if (outputCheck.value.isLarge) {
    return '尺寸较大，导出可能需要几秒'
  }
  return canChooseSaveLocation
    ? `${activeFormat.value.label} · 可选择保存位置`
    : `${activeFormat.value.label} · 下载到默认目录`
})

const statusTone = computed<'neutral' | 'ready' | 'warning'>(() => {
  if (images.value.length < 2) {
    return 'neutral'
  }
  if (!outputCheck.value.ok || outputCheck.value.isLarge) {
    return 'warning'
  }
  return 'ready'
})

const exportHint = computed(() => {
  if (images.value.length < 2) {
    return '至少需要两张图片才能导出'
  }
  if (!outputCheck.value.ok) {
    return outputCheck.value.reason
  }
  if (isExporting.value) {
    return '正在生成图片'
  }
  const qualityNote = activeFormat.value.supportsQuality
    ? `，质量 ${Math.round(EXPORT_QUALITY * 100)}%`
    : ''
  return canChooseSaveLocation
    ? `导出 ${activeFormat.value.longLabel}${qualityNote}，可选择保存位置`
    : `按原图尺寸导出 ${activeFormat.value.longLabel}${qualityNote}（浏览器默认下载目录）`
})

const clearDialogDescription = computed(
  () =>
    `队列中的 ${images.value.length} 张图片会从画布上移除，电脑里的原图不会被删除。`,
)

function summarize(names: string[]): string {
  const head = names.slice(0, 3).join('、')
  return names.length > 3 ? `${head} 等 ${names.length} 张` : head
}

async function openAbout(): Promise<void> {
  // 工作区提示不该跟着进入关于页，避免遮住项目地址与联系方式。
  dismissAll()
  activeView.value = 'about'
  await nextTick()
  aboutPageRef.value?.focusTitle()
}

async function closeAbout(): Promise<void> {
  activeView.value = 'workspace'
  await nextTick()
  aboutButtonRef.value?.focus()
}

function openFilePicker(): void {
  if (!isImporting.value) {
    fileInputRef.value?.click()
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  void handleAdd(files)
}

async function handleAdd(files: File[]): Promise<void> {
  if (files.length === 0) {
    return
  }

  // 新一批图片开始导入后，旧的导出结果提示不再需要保留。
  dismissAll()

  let report
  try {
    report = await addFiles(files)
  } catch (error) {    console.error('读取图片失败', error)
    push({
      tone: 'error',
      title: '图片读取失败',
      message: '请稍后重试，或换一张图片。',
    })
    return
  }

  if (report.busy) {
    push({ tone: 'info', title: '正在读取上一批图片', message: '请等读取完成后再添加。' })
    return
  }

  if (report.added > 0) {
    push({
      tone: 'success',
      title: `已添加 ${report.added} 张图片`,
      message: report.added > 1 ? '可以拖动卡片调整拼接顺序。' : undefined,
    })
  }

  if (report.skipped.length > 0) {
    push({
      tone: 'error',
      title: '有图片格式不支持',
      message: `${summarize(report.skipped)}。支持 ${SUPPORTED_FORMAT_LABEL}。`,
    })
  }

  if (report.failed.length > 0) {
    push({
      tone: 'error',
      title: '有图片读取失败',
      message: `${summarize(report.failed)}。请确认文件完整后重试。`,
    })
  }
}

function requestClear(): void {
  if (isImporting.value || images.value.length === 0) {
    return
  }
  isClearDialogOpen.value = true
}

function cancelClear(): void {
  isClearDialogOpen.value = false
}

function confirmClear(): void {
  isClearDialogOpen.value = false
  if (isImporting.value) {
    return
  }
  const cleared = clearImages()
  push({
    tone: 'info',
    title: '拼接队列已清空',
    message: cleared > 0 ? `可在左侧恢复这 ${cleared} 张图片。` : undefined,
  })
}

function restoreLastCleared(): void {
  const restored = restoreCleared()
  if (restored === 0) {
    return
  }
  // 恢复后旧导出提示已过时，避免与恢复提示同时堆叠。
  dismissAll()
  push({
    tone: 'info',
    title: `已恢复 ${restored} 张图片`,
    message: '顺序和间距保持不变，可以继续调整或再次导出。',
  })
}

async function handleExport(): Promise<void> {
  if (!canExport.value) {
    return
  }

  const format = activeFormat.value
  const fileName = buildExportFileName(new Date(), format.value)
  const picker = getSavePicker()
  isExporting.value = true
  // 导出开始后，上一条“已恢复”或旧导出提示已经过时。
  dismissAll()

  try {
    let target: SaveFileHandle | null = null
    if (picker) {
      // 保存对话框必须在点击手势内打开；先选位置，再生成大图。
      try {
        target = await picker({
          suggestedName: fileName,
          types: getSaveTypes(format),
        })
      } catch (error) {
        if (isSaveCanceled(error)) {
          return
        }
        throw error
      }
    }

    const exportLayout = layout.value
    const exportImages = images.value.slice()

    // 先让按钮的“导出中”状态完成一次绘制，再开始同步生成画布。
    await new Promise<void>((resolve) => window.setTimeout(resolve, 30))

    const canvas = renderStitch(document.createElement('canvas'), exportLayout, exportImages)
    const blob = await canvasToBlob(
      canvas,
      format.mime,
      format.supportsQuality ? EXPORT_QUALITY : undefined,
    )

    if (target) {
      await writeBlobToHandle(target, blob)
    } else {
      downloadBlob(blob, fileName)
    }

    const cleared = clearImages()
    const locationText = target ? '已保存到所选位置' : '已下载到默认下载目录'
    const restoreText = cleared > 0 ? `；队列已清空，可恢复 ${cleared} 张` : ''
    push({
      tone: 'success',
      title: '图片已导出',
      message: `${formatDimensions(exportLayout.width, exportLayout.height)} px · ${format.longLabel} · ${locationText}${restoreText}`,
      // 导出结果需要用户看清格式、尺寸和恢复入口，不自动消失。
      duration: 0,
    })
  } catch (error) {
    console.error('导出拼接图片失败', error)
    const unsupported = error instanceof UnsupportedExportFormatError
    push({
      tone: 'error',
      title: '导出失败',
      message: unsupported
        ? '当前浏览器不支持所选格式，请改用 PNG、JPG 或更新浏览器。'
        : '请稍后重试；如果无法选择保存位置，可以改用浏览器默认下载目录。',
    })
  } finally {
    isExporting.value = false
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="header-inner">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            <Layers3 :size="19" :stroke-width="1.9" />
          </span>
          <div class="brand-line">
            <h1 class="brand-name">Yisi 图像工具</h1>
            <span class="brand-divider" aria-hidden="true" />
            <span class="brand-sub">图片拼接</span>
          </div>
        </div>

        <div class="header-actions">
          <span
            class="privacy-note"
            title="所有图片只在当前浏览器中处理，不会上传到任何服务器"
          >
            <ShieldCheck :size="14" :stroke-width="1.8" />
            <span>本地处理 · 不会上传</span>
          </span>

          <button
            v-if="activeView === 'workspace'"
            ref="aboutButtonRef"
            class="button button-secondary header-page-button header-page-button--collapse"
            type="button"
            title="查看版本、快捷键与隐私说明"
            aria-label="关于"
            @click="openAbout"
          >
            <Info :size="14" :stroke-width="1.9" />
            <span class="header-page-label header-page-label--collapse">关于</span>
          </button>
          <button
            v-else
            class="button button-secondary header-page-button"
            type="button"
            title="返回拼接工作区"
            @click="closeAbout"
          >
            <ArrowLeft :size="14" :stroke-width="1.9" />
            <span class="header-page-label">返回拼接</span>
          </button>

          <button
            v-if="activeView === 'workspace'"
            class="button button-primary export-button"
            type="button"
            :disabled="!canExport"
            :title="
              canExport
                ? canChooseSaveLocation
                  ? `导出 ${activeFormat.longLabel}，可选择保存位置`
                  : `按原图尺寸导出 ${activeFormat.longLabel}（浏览器默认下载目录）`
                : exportHint
            "
            :aria-describedby="canExport ? undefined : 'export-hint'"
            :aria-busy="isExporting"
            @click="handleExport"
          >
            <Loader2 v-if="isExporting" class="spin" :size="15" :stroke-width="2" />
            <Download v-else :size="15" :stroke-width="2" />
            <span>{{ isExporting ? '导出中' : '导出图片' }}</span>
          </button>
          <span id="export-hint" class="sr-only">{{ exportHint }}</span>
        </div>
      </div>
    </header>

    <main v-if="activeView === 'workspace'" class="workspace">
      <StitchQueue
        :images="images"
        :is-importing="isImporting"
        :progress="progress"
        :cleared-count="clearedCount"
        @pick="openFilePicker"
        @add="handleAdd"
        @remove="removeImage"
        @reorder="moveImage"
        @clear="requestClear"
        @restore="restoreLastCleared"
      />

      <section class="preview-panel" aria-label="拼接预览与设置">
        <header class="preview-header">
          <div class="preview-heading">
            <h2>拼图预览</h2>
            <span v-if="images.length > 0" class="preview-meta tnum">
              {{ images.length }} 张 · {{ formatDimensions(layout.width, layout.height) }} px
            </span>
          </div>
          <span
            class="status-chip"
            :class="`status-chip--${statusTone}`"
            role="status"
            :title="previewStatus"
          >
            <AlertTriangle
              v-if="statusTone === 'warning'"
              :size="13"
              :stroke-width="1.9"
              aria-hidden="true"
            />
            <span v-else-if="statusTone === 'ready'" class="status-dot" aria-hidden="true" />
            <span class="status-text">{{ previewStatus }}</span>
          </span>
        </header>

        <PreviewStage
          :images="images"
          :layout="layout"
          :is-importing="isImporting"
          :progress="progress"
          @pick="openFilePicker"
          @add="handleAdd"
        />

        <StitchControls
          v-model:direction="direction"
          v-model:gap="gap"
          v-model:format="exportFormat"
          :formats="supportedFormats"
          :disabled="isExporting"
        />
      </section>
    </main>

    <main v-else class="about-main">
      <AboutPage ref="aboutPageRef" />
    </main>

    <input
      ref="fileInputRef"
      type="file"
      :accept="IMAGE_ACCEPT"
      multiple
      hidden
      @change="onFileChange"
    />

    <ToastStack :toasts="toasts" @dismiss="dismiss" />

    <ConfirmDialog
      :open="isClearDialogOpen"
      title="清空拼接队列？"
      :description="clearDialogDescription"
      confirm-label="清空队列"
      cancel-label="保留图片"
      @confirm="confirmClear"
      @cancel="cancelClear"
    />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100dvh;
  min-height: 560px;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(1100px 420px at 88% -160px, rgba(15, 118, 110, 0.075), transparent 65%),
    var(--bg-app);
}

.app-header {
  position: relative;
  z-index: 10;
  flex: 0 0 var(--header-height);
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(14px);
}

.header-inner {
  display: flex;
  width: 100%;
  max-width: 1640px;
  height: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: 0 auto;
  padding: 0 24px;
}

.brand {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 11px;
}

.brand-mark {
  display: inline-flex;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  background: linear-gradient(145deg, var(--brand-start), var(--brand-end));
  color: var(--surface);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.24),
    0 6px 14px -8px rgba(15, 118, 110, 0.62);
}

.brand-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.brand-name {
  color: var(--text-strong);
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: -0.012em;
  white-space: nowrap;
}

.brand-divider {
  width: 1px;
  height: 11px;
  flex: 0 0 1px;
  background: var(--border-strong);
}

.brand-sub {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
}

.privacy-note {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--accent-line);
  border-radius: 8px;
  background: rgba(230, 243, 240, 0.72);
  color: var(--accent-ink);
  font-size: 10.5px;
  font-weight: 550;
  white-space: nowrap;
}

.header-page-button {
  height: 34px;
  padding: 0 11px;
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.header-page-button svg {
  flex: 0 0 auto;
}

.export-button {
  height: 36px;
  padding: 0 15px;
  border-radius: 9px;
  font-size: 12px;
}

.workspace {
  display: grid;
  width: 100%;
  max-width: 1640px;
  min-height: 0;
  flex: 1;
  grid-template-columns: 332px minmax(0, 1fr);
  gap: 20px;
  margin: 0 auto;
  padding: 22px 24px 24px;
}

.about-main {
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 24px 24px 34px;
}

.preview-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}

.preview-header {
  display: flex;
  min-height: 58px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 18px 9px 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.preview-heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.preview-heading h2 {
  color: var(--text-strong);
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: -0.008em;
}

.preview-meta {
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
}

.status-chip {
  display: inline-flex;
  min-width: 0;
  max-width: min(440px, 54%);
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  font-size: 10.5px;
  font-weight: 550;
  line-height: 1.45;
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-chip--neutral {
  background: var(--surface-subtle);
  color: var(--text-muted);
}

.status-chip--ready {
  background: var(--accent-soft);
  color: var(--accent);
}

.status-chip--warning {
  border-color: var(--warning-line);
  background: var(--warning-soft);
  color: var(--warning);
}

.status-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--success);
}

@media (max-width: 1200px) {
  .workspace {
    grid-template-columns: 300px minmax(0, 1fr);
  }
}

@media (max-width: 980px) {
  .app-shell {
    height: auto;
    min-height: 100dvh;
    overflow: visible;
  }

  .app-header {
    position: sticky;
    top: 0;
  }

  .workspace {
    flex: none;
    grid-template-columns: minmax(0, 1fr);
    padding: 14px;
    gap: 14px;
  }

  .about-main {
    flex: none;
    overflow: visible;
    padding: 14px;
  }

  .queue-panel {
    max-height: 420px;
  }

  .preview-panel {
    min-height: 560px;
  }
}

@media (max-width: 640px) {
  .header-inner {
    gap: 10px;
    padding: 0 12px;
  }

  .brand-divider,
  .brand-sub {
    display: none;
  }

  .brand-mark {
    width: 32px;
    height: 32px;
    flex-basis: 32px;
    border-radius: 9px;
  }

  .brand-name {
    font-size: 13.5px;
  }

  .header-actions {
    gap: 7px;
  }

  .privacy-note {
    width: 30px;
    justify-content: center;
    padding: 0;
  }

  .privacy-note span {
    display: none;
  }

  .header-page-button--collapse {
    width: 34px;
    padding: 0;
  }

  .header-page-label--collapse {
    display: none;
  }

  .export-button {
    padding: 0 12px;
  }

  .workspace {
    padding: 10px;
    gap: 10px;
  }

  .about-main {
    padding: 10px;
  }

  .queue-panel {
    max-height: 360px;
  }

  .preview-panel {
    min-height: 520px;
  }

  .preview-header {
    padding: 9px 12px;
  }

  .status-chip {
    max-width: 58%;
  }
}
</style>
