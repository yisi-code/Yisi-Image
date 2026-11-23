<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FilePlus2,
  ImageIcon,
  Images,
  Info,
  Layers3,
  PenLine,
  Settings,
  ShieldCheck,
  ZoomIn,
} from 'lucide-vue-next'
import AboutPage from './components/AboutPage.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import EditControls from './components/EditControls.vue'
import ExportDialog from './components/ExportDialog.vue'
import PreviewStage from './components/PreviewStage.vue'
import SettingsPage from './components/SettingsPage.vue'
import StitchControls from './components/StitchControls.vue'
import StitchQueue from './components/StitchQueue.vue'
import ToastStack from './components/ToastStack.vue'
import { useImageQueue } from './composables/useImageQueue'
import { useModels } from './composables/useModels'
import { useSettings } from './composables/useSettings'
import type { InitialSettings } from './composables/useSettings'
import { useToasts } from './composables/useToasts'
import { TRANSPARENT_BACKGROUND } from './core/background'
import { getExportFormat, getSupportedExportFormats } from './core/exportFormats'
import type { ExportItem, ExportSummary } from './core/exportJob'
import { getSizeChangePercent } from './core/exportOptions'
import type { ExportOptions } from './core/exportOptions'
import { IS_DESKTOP_APP } from './core/appInfo'
import type { HealEngineChoice } from './core/healEngine'
import type { SharpenAiState } from './core/sharpenEngine'
import {
  IMAGE_ACCEPT,
  SUPPORTED_FORMAT_LABEL,
  formatDimensions,
  formatFileSize,
} from './core/image'
import { calculateStitchLayout, inspectOutputSize } from './core/layout'
import { renderStitch } from './core/render'
import { getSavePicker } from './core/save'
import { isModelBusy } from './core/modelApi'
import { HEAL_ENGINE_OPTIONS, THUMBNAIL_SIZE_PX } from './core/settings'
import type { PanelKey, PanelState, WorkMode } from './core/settings'
import type { StitchDirection, StitchImage } from './core/types'
import { vTooltip } from './directives/tooltip'

const props = defineProps<{
  /** main.ts 在挂载前读好的设置，避免先按默认值渲染再跳变 */
  initialSettings: InitialSettings
}>()

const {
  settings,
  storage: settingsStorage,
  location: configLocation,
  saveError: settingsSaveError,
  isMovingDir: isMovingConfigDir,
  dirStatus: configDirStatus,
  update: updateSettings,
  updatePanel,
  reset: resetSettings,
  changeDir: changeConfigDir,
  resetDir: resetConfigDir,
  openDir: openConfigDir,
} = useSettings(props.initialSettings)

const models = useModels(IS_DESKTOP_APP)

/** 按设置与模型下载状态决定这次修瑕用什么；选了 AI 但模型还不能用时退回经典算法，并说明原因。 */
const healEngineChoice = computed<HealEngineChoice>(() => {
  const engine = settings.value.healEngine
  if (engine === 'classic') {
    return { kind: 'classic' }
  }
  const label = HEAL_ENGINE_OPTIONS.find((option) => option.value === engine)?.label ?? engine
  if (!models.isAvailable) {
    return { kind: 'classic', notice: `${label} 只能在免安装 EXE 版里使用，这次用经典算法` }
  }
  const status = models.statusOf(engine)
  if (status?.state === 'ready') {
    return { kind: 'ai', model: engine, label, modelUrl: status.modelUrl, runtimeUrl: status.runtimeUrl }
  }
  let reason = '模型还没有下载完'
  if (!status) {
    reason = '读不到模型状态'
  } else if (isModelBusy(status.state) && status.total > 0) {
    reason = `模型还在下载（${Math.floor((status.downloaded / status.total) * 100)}%）`
  }
  return { kind: 'classic', notice: `${label} ${reason}，这次用经典算法；可在「设置 · 局部修瑕」里查看下载` }
})

/** AI 清晰化能不能用：只在 EXE 版、且 Real-ESRGAN 模型下好时可用，否则说明原因。 */
const sharpenAiState = computed<SharpenAiState>(() => {
  if (!models.isAvailable) {
    return { ready: false, reason: 'AI 清晰化只能在免安装 EXE 版里使用，浏览器页面请用经典锐化。' }
  }
  const status = models.statusOf('realesrgan')
  if (status?.state === 'ready') {
    return { ready: true, files: { modelUrl: status.modelUrl, runtimeUrl: status.runtimeUrl } }
  }
  let reason = '模型还没下载'
  if (!status) {
    reason = '读不到模型状态'
  } else if (isModelBusy(status.state) && status.total > 0) {
    reason = `模型还在下载（${Math.floor((status.downloaded / status.total) * 100)}%）`
  }
  return { ready: false, reason: `${reason}，可在「设置 · 清晰化」里下载（约 19 MB）。` }
})

const direction = ref<StitchDirection>('vertical')
/** 间距随设置一起保存到配置文件；底部滑块与数字框通过它读写。 */
const gap = computed({
  get: () => settings.value.gap,
  set: (value: number) => updateSettings({ gap: value }),
})
/** 拼接背景同样随设置保存；预览与导出都按它填充空位和间距。 */
const background = computed({
  get: () => settings.value.background,
  set: (value: string) => updateSettings({ background: value }),
})
/** 当前工作区随设置保存，下次打开沿用。 */
const workMode = computed({
  get: () => settings.value.workMode,
  set: (value: WorkMode) => updateSettings({ workMode: value }),
})
const isStitchMode = computed(() => workMode.value === 'stitch')
const supportedFormats = getSupportedExportFormats()
const activeFormat = computed(() => getExportFormat(settings.value.exportOptions.format))
const isExportDialogOpen = ref(false)
const isClearDialogOpen = ref(false)
/** 预览里正在修瑕：期间不能切换模式和单图编辑的当前图片，否则结果写不回去。 */
const isPreviewBusy = ref(false)
const activeView = ref<'workspace' | 'about' | 'settings'>('workspace')
const fileInputRef = ref<HTMLInputElement | null>(null)
const aboutButtonRef = ref<HTMLButtonElement | null>(null)
const settingsButtonRef = ref<HTMLButtonElement | null>(null)
const aboutPageRef = ref<{ focusTitle: () => void } | null>(null)
const settingsPageRef = ref<{ focusTitle: () => void } | null>(null)
const previewStageRef = ref<{ focusImage: (index: number) => void } | null>(null)
const activeImageId = ref<string | null>(null)
const canChooseSaveLocation = getSavePicker() !== null
const resolvedThumbOrientation = computed(() =>
  settings.value.thumbnailOrientation === 'auto'
    ? direction.value
    : settings.value.thumbnailOrientation,
)
// 纵向排列且缩略图展开时，右下角提示要给右侧缩略图面板让位；单图编辑没有缩略图条。
const toastRightOffset = computed(() =>
  isStitchMode.value &&
  resolvedThumbOrientation.value === 'vertical' &&
  !settings.value.thumbnailPanel.collapsed
    ? THUMBNAIL_SIZE_PX[settings.value.thumbnailSize].width + 80
    : 22,
)

const {
  images,
  isImporting,
  progress,
  clearedCount,
  addFiles,
  addBlankAt,
  resizeBlank,
  removeImage,
  moveImage,
  clearImages,
  restoreCleared,
} = useImageQueue()
/** 单图编辑有自己的一份列表，与拼接队列互不影响。 */
const {
  images: editImages,
  isImporting: isEditImporting,
  progress: editProgress,
  clearedCount: editClearedCount,
  addFiles: addEditFiles,
  removeImage: removeEditImage,
  clearImages: clearEditImages,
  restoreCleared: restoreEditCleared,
} = useImageQueue()
const editActiveId = ref<string | null>(null)
const { toasts, push, dismiss, dismissAll } = useToasts()

// 配置写不进去时提示一次；之后连续失败不重复弹，恢复正常后再失败才会再提示。
watch(
  settingsSaveError,
  (message, previous) => {
    if (message && !previous) {
      push({
        tone: 'error',
        title: '设置未能保存',
        message: `${message}。可在「设置 · 配置文件」里更换配置目录。`,
      })
    }
  },
  { immediate: true },
)

const activeIndex = computed(() =>
  images.value.findIndex((image) => image.id === activeImageId.value),
)

/** 单图编辑正在编辑的那张；没选过或被移除时取第一张。 */
const editCurrent = computed<StitchImage | null>(
  () => editImages.value.find((image) => image.id === editActiveId.value) ?? editImages.value[0] ?? null,
)

// 左侧列表、预览、清空与恢复按当前工作区取对应的一份。
const listImages = computed(() => (isStitchMode.value ? images.value : editImages.value))
const listImporting = computed(() =>
  isStitchMode.value ? isImporting.value : isEditImporting.value,
)
const listProgress = computed(() => (isStitchMode.value ? progress.value : editProgress.value))
const listClearedCount = computed(() =>
  isStitchMode.value ? clearedCount.value : editClearedCount.value,
)
const listActiveId = computed(() =>
  isStitchMode.value ? activeImageId.value : (editCurrent.value?.id ?? null),
)

interface PanelToggle {
  key: PanelKey
  /** 完整名称，用于提示与无障碍名称 */
  name: string
  /** 标题栏上显示的短名 */
  label: string
  icon: Component
}

/** 预览标题栏的「显示」开关：面板收起后从画布隐去，只能从这里恢复。空白页开关只在队列里有空白页时出现。 */
const panelToggles = computed<PanelToggle[]>(() => [
  { key: 'annotationToolbar', name: '标注工具栏', label: '标注', icon: PenLine },
  { key: 'zoomToolbar', name: '缩放栏', label: '缩放', icon: ZoomIn },
  ...(isStitchMode.value && images.value.some((image) => image.kind === 'blank')
    ? [{ key: 'blankPanel' as const, name: '空白页面板', label: '空白页', icon: FilePlus2 }]
    : []),
  ...(isStitchMode.value
    ? [{ key: 'thumbnailPanel' as const, name: '缩略图', label: '缩略图', icon: Images }]
    : []),
])
const panelToggleRefs = new Map<PanelKey, HTMLButtonElement>()

function setPanelToggleRef(key: PanelKey, element: unknown): void {
  if (element instanceof HTMLButtonElement) {
    panelToggleRefs.set(key, element)
  } else {
    panelToggleRefs.delete(key)
  }
}

function isPanelVisible(key: PanelKey): boolean {
  return !settings.value[key].collapsed
}

function togglePanel(key: PanelKey): void {
  updatePanel(key, { ...settings.value[key], collapsed: !settings.value[key].collapsed })
}

/** 画布里的收起按钮会随面板一起卸载；焦点丢失时交给标题栏对应的开关，键盘用户还能接着操作。 */
async function onPanelUpdate(key: PanelKey, state: PanelState): Promise<void> {
  updatePanel(key, state)
  if (!state.collapsed) {
    return
  }
  await nextTick()
  if (!document.activeElement || document.activeElement === document.body) {
    panelToggleRefs.get(key)?.focus()
  }
}

const layout = computed(() =>
  calculateStitchLayout(images.value, direction.value, gap.value),
)

const outputCheck = computed(() =>
  inspectOutputSize(layout.value.width, layout.value.height),
)

const previewImages = computed<StitchImage[]>(() => {
  if (isStitchMode.value) {
    return images.value
  }
  return editCurrent.value ? [editCurrent.value] : []
})
const previewLayout = computed(() =>
  isStitchMode.value ? layout.value : calculateStitchLayout(previewImages.value, 'vertical', 0),
)

const canExport = computed(() =>
  isStitchMode.value
    ? images.value.length >= 2 && outputCheck.value.ok
    : editCurrent.value !== null && !isEditImporting.value,
)

const previewStatus = computed(() => {
  if (listImages.value.length === 0) {
    return listImporting.value
      ? `正在读取 ${listProgress.value.done}/${listProgress.value.total}`
      : '等待添加图片'
  }
  if (!isStitchMode.value) {
    return `导出 ${activeFormat.value.label} · 可预览对比`
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
  if (!isStitchMode.value) {
    return editCurrent.value ? 'ready' : 'neutral'
  }
  if (images.value.length < 2) {
    return 'neutral'
  }
  if (!outputCheck.value.ok || outputCheck.value.isLarge) {
    return 'warning'
  }
  return 'ready'
})

const exportHint = computed(() => {
  if (!isStitchMode.value) {
    return editCurrent.value ? '选择格式、压缩并预览对比后保存' : '先添加要编辑的图片'
  }
  if (images.value.length < 2) {
    return '至少需要两张图片才能导出'
  }
  if (!outputCheck.value.ok) {
    return outputCheck.value.reason
  }
  return canChooseSaveLocation
    ? '选择格式、压缩并预览对比后保存，可选择保存位置'
    : '选择格式、压缩并预览对比后保存（浏览器默认下载目录）'
})

const clearDialogTitle = computed(() => (isStitchMode.value ? '清空拼接队列？' : '清空图片列表？'))
const clearDialogDescription = computed(
  () =>
    `${isStitchMode.value ? '队列' : '列表'}中的 ${listImages.value.length} 张图片会从画布上移除，电脑里的原图不会被删除。`,
)
const workspaceName = computed(() => (isStitchMode.value ? '拼接' : '编辑'))

/** 导出对话框的内容：拼接是整张拼接图，单图编辑是列表里的每一张。 */
const exportItems = computed<ExportItem[]>(() => {
  if (isStitchMode.value) {
    const stitchLayout = layout.value
    const stitchImages = images.value.slice()
    return [
      {
        id: 'stitch',
        name: '',
        width: stitchLayout.width,
        height: stitchLayout.height,
        originalSize: 0,
        render: (scale, background) =>
          renderStitch(document.createElement('canvas'), stitchLayout, stitchImages, {
            scale,
            background,
          }),
      },
    ]
  }
  return editImages.value.map((image) => ({
    id: image.id,
    name: image.name,
    width: image.width,
    height: image.height,
    originalSize: image.size,
    render: (scale: number, background: string | null) =>
      renderStitch(
        document.createElement('canvas'),
        calculateStitchLayout([image], 'vertical', 0),
        [image],
        { scale, background },
      ),
  }))
})
const exportCurrentId = computed(() =>
  isStitchMode.value ? 'stitch' : (editCurrent.value?.id ?? null),
)
// 单图导出保留原图透明（JPG 例外，按白底）；拼接用底栏选的背景。
const exportBackground = computed(() =>
  isStitchMode.value ? background.value : TRANSPARENT_BACKGROUND,
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

async function openSettings(): Promise<void> {
  // 设置页不显示工作区提示，避免遮住选项。
  dismissAll()
  activeView.value = 'settings'
  await nextTick()
  settingsPageRef.value?.focusTitle()
}

async function closeSettings(): Promise<void> {
  activeView.value = 'workspace'
  await nextTick()
  settingsButtonRef.value?.focus()
}

function warnBusy(): void {
  push({ tone: 'info', title: '正在修瑕', message: '等这次修瑕算完再切换。' })
}

function switchMode(mode: WorkMode): void {
  if (mode === workMode.value) {
    return
  }
  if (isPreviewBusy.value) {
    warnBusy()
    return
  }
  // 上一个工作区的提示（导入结果、导出结果）对新工作区没有意义。
  dismissAll()
  workMode.value = mode
}

function selectEditImage(index: number): void {
  const target = editImages.value[index]
  if (!target || target.id === editCurrent.value?.id) {
    return
  }
  if (isPreviewBusy.value) {
    warnBusy()
    return
  }
  editActiveId.value = target.id
}

function onQueueFocus(index: number): void {
  if (isStitchMode.value) {
    previewStageRef.value?.focusImage(index)
  } else {
    selectEditImage(index)
  }
}

function onActiveChange(id: string | null): void {
  // 单图编辑的当前图片由列表决定，预览里的「当前」只在拼接时有意义。
  if (isStitchMode.value) {
    activeImageId.value = id
  }
}

function removeListImage(id: string): void {
  if (isStitchMode.value) {
    removeImage(id)
    return
  }
  // 移除正在编辑的那张时，改编辑它后面一张（没有就前一张）。
  if (id === editCurrent.value?.id) {
    const index = editImages.value.findIndex((image) => image.id === id)
    const next = editImages.value[index + 1] ?? editImages.value[index - 1] ?? null
    editActiveId.value = next?.id ?? null
  }
  removeEditImage(id)
}

function openFilePicker(): void {
  if (!listImporting.value) {
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

  const isStitch = isStitchMode.value
  let report
  try {
    report = await (isStitch ? addFiles(files) : addEditFiles(files))
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
      message: isStitch
        ? report.added > 1
          ? '可以拖动卡片调整拼接顺序。'
          : undefined
        : '点左侧图片切换编辑，导出时可转换格式、压缩。',
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

function onHealFailed(message: string): void {
  push({ tone: 'error', title: '修瑕失败', message: `${message}。这次涂抹已撤回，可以缩小范围后重试。` })
}

function onSharpenFailed(message: string): void {
  push({ tone: 'error', title: '清晰化失败', message: `${message}。可以换小一点的强度或半径再试。` })
}

function onHealNotice(message: string): void {
  push({ tone: 'info', title: '修瑕', message })
}

function insertBlankPage(): void {
  if (isImporting.value) {
    return
  }
  const insertAt = activeIndex.value >= 0 ? activeIndex.value + 1 : images.value.length
  const index = addBlankAt(insertAt)
  void nextTick(() => previewStageRef.value?.focusImage(index))
}

function resizeBlankPage(id: string, width: number, height: number): void {
  resizeBlank(id, width, height)
}

function requestClear(): void {
  if (listImporting.value || listImages.value.length === 0) {
    return
  }
  isClearDialogOpen.value = true
}

function cancelClear(): void {
  isClearDialogOpen.value = false
}

function confirmClear(): void {
  isClearDialogOpen.value = false
  if (listImporting.value) {
    return
  }
  const cleared = isStitchMode.value ? clearImages() : clearEditImages()
  push({
    tone: 'info',
    title: isStitchMode.value ? '拼接队列已清空' : '图片列表已清空',
    message: cleared > 0 ? `可在左侧恢复这 ${cleared} 张图片。` : undefined,
  })
}

function restoreLastCleared(): void {
  const restored = isStitchMode.value ? restoreCleared() : restoreEditCleared()
  if (restored === 0) {
    return
  }
  // 恢复后旧导出提示已过时，避免与恢复提示同时堆叠。
  dismissAll()
  push({
    tone: 'info',
    title: `已恢复 ${restored} 张图片`,
    message: isStitchMode.value
      ? '顺序和间距保持不变，可以继续调整或再次导出。'
      : '标注和修瑕都保留，可以继续编辑或再次导出。',
  })
}

function openExportDialog(): void {
  if (!canExport.value) {
    return
  }
  // 旧的导出结果、恢复提示已经过时。
  dismissAll()
  isExportDialogOpen.value = true
}

function updateExportOptions(options: ExportOptions): void {
  updateSettings({ exportOptions: options })
}

const LOCATION_TEXT: Record<ExportSummary['location'], string> = {
  file: '已保存到所选位置',
  folder: '已保存到所选文件夹',
  download: '已下载到默认下载目录',
}

function describeSizeChange(before: number, after: number): string {
  const change = getSizeChangePercent(before, after)
  if (change === null) {
    return formatFileSize(after)
  }
  return `${formatFileSize(before)} → ${formatFileSize(after)}（${change > 0 ? '+' : ''}${change}%）`
}

function onExported(summary: ExportSummary): void {
  isExportDialogOpen.value = false
  const format = summary.format
  const notes = [
    summary.transparencyDropped ? 'JPG 不支持透明，已按白底导出' : '',
    summary.unmetTarget > 0
      ? `${summary.unmetTarget > 1 ? `有 ${summary.unmetTarget} 张` : ''}最低质量仍超过目标大小`
      : '',
  ].filter(Boolean)
  const noteText = notes.length > 0 ? ` · ${notes.join(' · ')}` : ''

  if (isStitchMode.value) {
    const cleared = clearImages()
    const restoreText = cleared > 0 ? `；队列已清空，可恢复 ${cleared} 张` : ''
    push({
      tone: 'success',
      title: '图片已导出',
      message: `${formatDimensions(summary.width, summary.height)} px · ${format.longLabel} · ${formatFileSize(summary.totalAfter)}${noteText} · ${LOCATION_TEXT[summary.location]}${restoreText}`,
      // 导出结果需要用户看清格式、尺寸和恢复入口，不自动消失。
      duration: 0,
    })
    return
  }

  if (summary.count > 0) {
    const title = summary.count > 1 ? `已导出 ${summary.count} 张图片` : '图片已导出'
    const sizeText =
      summary.count > 1
        ? `共 ${describeSizeChange(summary.totalBefore, summary.totalAfter)}`
        : `${formatDimensions(summary.width, summary.height)} px · ${describeSizeChange(summary.totalBefore, summary.totalAfter)}`
    push({
      tone: 'success',
      title: summary.canceled ? `${title}（已停止）` : title,
      message: `${format.longLabel} · ${sizeText}${noteText} · ${LOCATION_TEXT[summary.location]}`,
      duration: 0,
    })
  } else if (summary.canceled) {
    push({ tone: 'info', title: '已停止导出', message: '还没有保存任何图片。' })
  }
  if (summary.failed.length > 0) {
    push({
      tone: 'error',
      title: `${summary.failed.length} 张没有导出`,
      message: `${summarize(summary.failed)}。可能超出尺寸上限或写入失败，可以单独再试。`,
    })
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
            <span v-if="activeView !== 'workspace'" class="brand-sub">
              {{ isStitchMode ? '图片拼接' : '单图编辑' }}
            </span>
            <div v-else class="segmented mode-switch" role="group" aria-label="工作区">
              <button
                type="button"
                class="segment"
                :class="{ 'is-active': isStitchMode }"
                :aria-pressed="isStitchMode"
                title="把多张图片纵向或横向拼成一张"
                @click="switchMode('stitch')"
              >
                <Layers3 :size="14" :stroke-width="1.9" />
                <span class="mode-switch__label">拼接</span>
              </button>
              <button
                type="button"
                class="segment"
                :class="{ 'is-active': !isStitchMode }"
                :aria-pressed="!isStitchMode"
                title="逐张标注、修瑕，导出时转换格式与压缩"
                @click="switchMode('single')"
              >
                <ImageIcon :size="14" :stroke-width="1.9" />
                <span class="mode-switch__label">单图编辑</span>
              </button>
            </div>
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
            v-if="activeView === 'workspace'"
            ref="settingsButtonRef"
            class="button button-secondary header-page-button header-page-button--collapse"
            type="button"
            title="调整预览缩略图、局部修瑕与配置文件"
            aria-label="设置"
            @click="openSettings"
          >
            <Settings :size="14" :stroke-width="1.9" />
            <span class="header-page-label header-page-label--collapse">设置</span>
          </button>
          <button
            v-if="activeView === 'about'"
            class="button button-secondary header-page-button"
            type="button"
            :title="`返回${workspaceName}工作区`"
            @click="closeAbout"
          >
            <ArrowLeft :size="14" :stroke-width="1.9" />
            <span class="header-page-label">返回{{ workspaceName }}</span>
          </button>
          <button
            v-else-if="activeView === 'settings'"
            class="button button-secondary header-page-button"
            type="button"
            :title="`返回${workspaceName}工作区`"
            @click="closeSettings"
          >
            <ArrowLeft :size="14" :stroke-width="1.9" />
            <span class="header-page-label">返回{{ workspaceName }}</span>
          </button>

          <button
            v-if="activeView === 'workspace'"
            class="button button-primary export-button"
            type="button"
            :disabled="!canExport"
            :title="exportHint"
            :aria-describedby="canExport ? undefined : 'export-hint'"
            @click="openExportDialog"
          >
            <Download :size="15" :stroke-width="2" />
            <span>导出图片</span>
          </button>
          <span id="export-hint" class="sr-only">{{ exportHint }}</span>
        </div>
      </div>
    </header>

    <main v-if="activeView === 'workspace'" class="workspace">
      <StitchQueue
        :images="listImages"
        :is-importing="listImporting"
        :progress="listProgress"
        :cleared-count="listClearedCount"
        :active-id="listActiveId"
        :mode="workMode"
        :select-locked="isPreviewBusy"
        @pick="openFilePicker"
        @add="handleAdd"
        @remove="removeListImage"
        @reorder="moveImage"
        @clear="requestClear"
        @restore="restoreLastCleared"
        @focus="onQueueFocus"
        @blank="insertBlankPage"
      />

      <section
        class="preview-panel"
        :aria-label="isStitchMode ? '拼接预览与设置' : '单图编辑预览'"
      >
        <header class="preview-header">
          <div class="preview-heading">
            <h2>{{ isStitchMode ? '拼图预览' : '单图编辑' }}</h2>
            <span v-if="isStitchMode && images.length > 0" class="preview-meta tnum">
              {{ images.length }} 张 · {{ formatDimensions(layout.width, layout.height) }} px
            </span>
            <span
              v-else-if="!isStitchMode && editCurrent"
              class="preview-meta tnum"
              :title="editCurrent.name"
            >
              {{ editCurrent.name }} · {{ formatDimensions(editCurrent.width, editCurrent.height) }} px
            </span>
          </div>
          <div
            v-if="listImages.length > 0"
            class="panel-toggles"
            role="group"
            aria-label="显示或隐藏预览面板"
          >
            <span class="panel-toggles__label" aria-hidden="true">显示</span>
            <button
              v-for="panel in panelToggles"
              :key="panel.key"
              :ref="(element) => setPanelToggleRef(panel.key, element)"
              v-tooltip="`${isPanelVisible(panel.key) ? '隐藏' : '显示'}${panel.name}`"
              class="panel-toggle"
              :class="{ 'is-on': isPanelVisible(panel.key) }"
              type="button"
              :aria-label="panel.name"
              :aria-pressed="isPanelVisible(panel.key)"
              @click="togglePanel(panel.key)"
            >
              <component :is="panel.icon" :size="13" :stroke-width="1.9" />
              <span class="panel-toggle__label">{{ panel.label }}</span>
            </button>
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
          ref="previewStageRef"
          :images="previewImages"
          :layout="previewLayout"
          :is-importing="listImporting"
          :progress="listProgress"
          :thumb-orientation="settings.thumbnailOrientation"
          :thumb-size="settings.thumbnailSize"
          :thumb-fit="settings.thumbnailFit"
          :annotation-toolbar="settings.annotationToolbar"
          :zoom-toolbar="settings.zoomToolbar"
          :blank-panel="settings.blankPanel"
          :thumbnail-panel="settings.thumbnailPanel"
          :background="exportBackground"
          :single-image="!isStitchMode"
          :sharpen-engine="settings.sharpenEngine"
          :sharpen-ai="sharpenAiState"
          :heal-engine="healEngineChoice"
          @pick="openFilePicker"
          @add="handleAdd"
          @active-change="onActiveChange"
          @resize-blank="resizeBlankPage"
          @update-panel="onPanelUpdate"
          @heal-failed="onHealFailed"
          @heal-notice="onHealNotice"
          @busy-change="isPreviewBusy = $event"
          @sharpen-failed="onSharpenFailed"
          @update-sharpen-engine="updateSettings({ sharpenEngine: $event })"
        />

        <StitchControls
          v-if="isStitchMode"
          v-model:direction="direction"
          v-model:gap="gap"
          v-model:background="background"
          :format="settings.exportOptions.format"
        />
        <EditControls
          v-else
          :images="editImages"
          :current="editCurrent"
          :locked="isPreviewBusy"
          @select="selectEditImage"
        />
      </section>
    </main>

    <main v-else-if="activeView === 'about'" class="about-main">
      <AboutPage ref="aboutPageRef" />
    </main>

    <main v-else class="settings-main">
      <SettingsPage
        ref="settingsPageRef"
        :settings="settings"
        :stitch-direction="direction"
        :storage="settingsStorage"
        :config-location="configLocation"
        :save-error="settingsSaveError"
        :is-moving-dir="isMovingConfigDir"
        :dir-status="configDirStatus"
        :models-available="models.isAvailable"
        :models="models.snapshot.value"
        :models-load-error="models.loadError.value"
        :models-busy="models.isBusy.value"
        :models-status="models.actionStatus.value"
        @update="updateSettings"
        @reset="resetSettings"
        @change-dir="changeConfigDir"
        @reset-dir="resetConfigDir"
        @open-dir="openConfigDir"
        @download-model="models.download"
        @pause-model="models.pause"
        @delete-model="models.remove"
        @change-models-dir="models.changeDir"
        @reset-models-dir="models.resetDir"
        @open-models-dir="models.openDir"
      />
    </main>

    <input
      ref="fileInputRef"
      type="file"
      :accept="IMAGE_ACCEPT"
      multiple
      hidden
      @change="onFileChange"
    />

    <ToastStack
      :toasts="toasts"
      :right-offset="toastRightOffset"
      @dismiss="dismiss"
    />

    <ExportDialog
      :open="isExportDialogOpen"
      :mode="workMode"
      :items="exportItems"
      :current-id="exportCurrentId"
      :options="settings.exportOptions"
      :formats="supportedFormats"
      :background="exportBackground"
      @close="isExportDialogOpen = false"
      @update:options="updateExportOptions"
      @exported="onExported"
    />

    <ConfirmDialog
      :open="isClearDialogOpen"
      :title="clearDialogTitle"
      :description="clearDialogDescription"
      :confirm-label="isStitchMode ? '清空队列' : '清空列表'"
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

/* 工作区切换：样式沿用底部控制条的分段控件，只是更矮一些放进顶栏。 */
.mode-switch {
  flex: 0 0 auto;
}

.mode-switch .segment {
  height: 28px;
  padding: 0 11px;
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

.about-main,
.settings-main {
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

/* 外观与底部「拼接方向」分段控件一致，开关之间相互独立（多选）。 */
.panel-toggles {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-inset);
}

.panel-toggles__label {
  padding: 0 5px 0 6px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
}

.panel-toggle {
  display: inline-flex;
  height: 26px;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 600;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease),
    box-shadow 0.15s var(--ease);
}

.panel-toggle:hover:not(.is-on) {
  color: var(--text);
}

.panel-toggle.is-on {
  border-color: var(--border);
  background: var(--surface);
  color: var(--text-strong);
  box-shadow: var(--shadow-xs);
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

  .about-main,
  .settings-main {
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
  .brand-sub,
  .mode-switch__label {
    display: none;
  }

  .mode-switch .segment {
    padding: 0 9px;
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

  .about-main,
  .settings-main {
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

  .panel-toggles__label,
  .panel-toggle__label {
    display: none;
  }

  .panel-toggle {
    width: 28px;
    justify-content: center;
    padding: 0;
  }
}
</style>
