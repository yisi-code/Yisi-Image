<script lang="ts">
import { ref } from 'vue'

type SettingsCategory = 'thumbnail' | 'heal' | 'sharpen' | 'config'

/**
 * 当前选中的设置分类。放在模块级：返回拼接时设置页会卸载，再进设置仍停在上次看的分类；
 * 重新打开程序回到第一个分类。它只是界面状态，不写进配置文件。
 */
const activeCategory = ref<SettingsCategory>('thumbnail')
</script>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component, ComponentPublicInstance } from 'vue'
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpDown,
  Brain,
  Crop,
  Expand,
  FileCog,
  FolderCog,
  FolderInput,
  FolderOpen,
  GalleryThumbnails,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Undo2,
  Wand2,
  Zap,
} from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'
import ModelRow from './ModelRow.vue'
import type { ConfigDirStatus, SettingsStorage } from '../composables/useSettings'
import type { ConfigLocation } from '../core/configApi'
import { formatFileSize } from '../core/image'
import { isModelBusy } from '../core/modelApi'
import type { HealModelId, ModelId, ModelStatus, ModelsSnapshot, SharpenModelId } from '../core/modelApi'
import {
  HEAL_ENGINE_OPTIONS,
  SHARPEN_ENGINE_OPTIONS,
  THUMBNAIL_FIT_OPTIONS,
  THUMBNAIL_ORIENTATION_OPTIONS,
  THUMBNAIL_SIZE_OPTIONS,
} from '../core/settings'
import type {
  HealEngine,
  SharpenEngine,
  ThumbnailFit,
  ThumbnailOrientation,
  ThumbnailSize,
  ToolSettings,
} from '../core/settings'
import type { StitchDirection } from '../core/types'

const props = defineProps<{
  settings: ToolSettings
  stitchDirection: StitchDirection
  storage: SettingsStorage
  configLocation: ConfigLocation | null
  saveError: string
  isMovingDir: boolean
  dirStatus: ConfigDirStatus | null
  /** 是否在 EXE 版里运行：只有这时才能下载和使用 AI 模型 */
  modelsAvailable: boolean
  models: ModelsSnapshot | null
  modelsLoadError: string
  modelsBusy: boolean
  modelsStatus: ConfigDirStatus | null
}>()

const emit = defineEmits<{
  update: [patch: Partial<ToolSettings>]
  reset: []
  'change-dir': []
  'reset-dir': []
  'open-dir': []
  'download-model': [id: ModelId]
  'pause-model': [id: ModelId]
  'delete-model': [id: ModelId]
  'change-models-dir': []
  'reset-models-dir': []
  'open-models-dir': []
}>()

const titleRef = ref<HTMLElement | null>(null)

/** 分类与原来的三张卡一一对应、顺序不变；恢复默认作用于全部分类，留在页脚。 */
const categories: { key: SettingsCategory; label: string; icon: Component }[] = [
  { key: 'thumbnail', label: '预览缩略图', icon: GalleryThumbnails },
  { key: 'heal', label: '局部修瑕', icon: Wand2 },
  { key: 'sharpen', label: '清晰化', icon: Sparkles },
  { key: 'config', label: '配置文件', icon: FileCog },
]

/** 方向键切换分类后把焦点移到新页签。 */
const tabButtons = new Map<SettingsCategory, HTMLButtonElement>()

const orientationMeta: Record<
  ThumbnailOrientation,
  { icon: typeof RefreshCw; label: string }
> = {
  auto: { icon: RefreshCw, label: '跟随拼接' },
  horizontal: { icon: ArrowLeftRight, label: '横向排列' },
  vertical: { icon: ArrowUpDown, label: '纵向排列' },
}

const fitMeta: Record<ThumbnailFit, { icon: typeof Maximize2 }> = {
  contain: { icon: Maximize2 },
  cover: { icon: Crop },
  fill: { icon: Expand },
}

const currentSummary = computed(() => {
  const orientation =
    props.settings.thumbnailOrientation === 'auto'
      ? `跟随拼接（${props.stitchDirection === 'vertical' ? '纵向' : '横向'}）`
      : orientationMeta[props.settings.thumbnailOrientation].label
  const size =
    THUMBNAIL_SIZE_OPTIONS.find(
      (option) => option.value === props.settings.thumbnailSize,
    )?.label ?? '中'
  const fit =
    THUMBNAIL_FIT_OPTIONS.find(
      (option) => option.value === props.settings.thumbnailFit,
    )?.label ?? '完整显示长边'
  return `${orientation} · ${size}号 · ${fit}`
})

const isFileStorage = computed(
  () => props.storage === 'file' && props.configLocation !== null,
)

const configSummary = computed(() => {
  if (!isFileStorage.value) {
    return '浏览器本地存储'
  }
  return props.configLocation?.isDefault ? '程序所在目录' : '自定义目录'
})

/** 配置区域只显示一条状态：目录操作的进度或结果优先，其次是保存失败。 */
const configStatus = computed<ConfigDirStatus | null>(
  () => {
    if (props.dirStatus) {
      return props.dirStatus
    }
    if (props.saveError) {
      return { tone: 'error', text: `配置未能保存：${props.saveError}` }
    }
    return null
  },
)

const engineIcons: Record<HealEngine, Component> = {
  classic: Wand2,
  migan: Zap,
  lama: Brain,
}

const sharpenIcons: Record<SharpenEngine, Component> = {
  classic: Sparkles,
  realesrgan: Brain,
}

const aiOptions = HEAL_ENGINE_OPTIONS.filter((option) => isAiEngine(option.value))
const sharpenAiOptions = SHARPEN_ENGINE_OPTIONS.filter((option) => isAiSharpen(option.value))

/** 要用户确认下载 / 删除的模型；null 表示没有打开确认框。 */
const pendingDownload = ref<ModelId | null>(null)
const pendingDelete = ref<ModelId | null>(null)

function isAiEngine(value: HealEngine): value is HealModelId {
  return value !== 'classic'
}

function isAiSharpen(value: SharpenEngine): value is SharpenModelId {
  return value !== 'classic'
}

function isHealModel(id: ModelId): id is HealModelId {
  return id === 'migan' || id === 'lama'
}

function engineLabel(value: HealEngine): string {
  return HEAL_ENGINE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

function sharpenLabel(value: SharpenEngine): string {
  return SHARPEN_ENGINE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

function modelLabel(id: ModelId): string {
  return isHealModel(id) ? engineLabel(id) : sharpenLabel(id)
}

/** 模型用在哪：修瑕或清晰化；提示文案按它说。 */
function modelPurpose(id: ModelId): string {
  return isHealModel(id) ? '修瑕' : '清晰化'
}

function modelStatus(id: ModelId): ModelStatus | null {
  return props.models?.items.find((item) => item.id === id) ?? null
}

function percentOf(status: ModelStatus | null): number {
  return status && status.total > 0 ? Math.floor((status.downloaded / status.total) * 100) : 0
}

function remainingOf(status: ModelStatus): number {
  return Math.max(0, status.total - status.downloaded)
}

function modelStateText(status: ModelStatus | null): string {
  if (!props.modelsAvailable) {
    return '仅免安装 EXE 版可用'
  }
  if (!status) {
    return props.modelsLoadError ? `读不到模型状态：${props.modelsLoadError}` : '正在读取模型状态…'
  }
  const progress = `${formatFileSize(status.downloaded)} / ${formatFileSize(status.total)}`
  switch (status.state) {
    case 'missing':
      return status.downloaded > 0
        ? `未下载，需 ${formatFileSize(remainingOf(status))}（运行库已就绪）`
        : `未下载，需 ${formatFileSize(remainingOf(status))}`
    case 'queued':
      return '排队中，等前一个模型下完'
    case 'downloading':
      return `下载中 ${percentOf(status)}% · ${progress}`
    case 'verifying':
      return '下载完成，正在校验文件…'
    case 'paused':
      return `已暂停 ${percentOf(status)}% · ${progress}`
    case 'ready':
      return '已下载，可以使用'
    case 'error':
      return `下载失败：${status.error}`
  }
}

const healSummary = computed(() => {
  const engine = props.settings.healEngine
  if (!isAiEngine(engine)) {
    return engineLabel(engine)
  }
  return modelStatus(engine)?.state === 'ready'
    ? engineLabel(engine)
    : `${engineLabel(engine)}（模型未就绪，暂用经典算法）`
})

const sharpenSummary = computed(() => {
  const engine = props.settings.sharpenEngine
  if (!isAiSharpen(engine)) {
    return sharpenLabel(engine)
  }
  return modelStatus(engine)?.state === 'ready'
    ? sharpenLabel(engine)
    : `${sharpenLabel(engine)}（模型未就绪，暂不能用）`
})

const modelsDirStatus = computed<ConfigDirStatus | null>(() => {
  if (props.modelsStatus) {
    return props.modelsStatus
  }
  return props.modelsLoadError
    ? { tone: 'error', text: `读不到模型状态：${props.modelsLoadError}` }
    : null
})

/** 有错误的分类在页签上标出来：停在别的分类时，也能看到配置没保存上、模型下载失败。 */
const categoryAlerts = computed<Record<SettingsCategory, boolean>>(() => ({
  thumbnail: false,
  heal:
    modelsDirStatus.value?.tone === 'error' ||
    (props.models?.items.some((item) => isHealModel(item.id) && item.state === 'error') ?? false),
  sharpen: props.models?.items.some((item) => !isHealModel(item.id) && item.state === 'error') ?? false,
  config: configStatus.value?.tone === 'error',
}))

const downloadPrompt = computed(() => {
  const id = pendingDownload.value
  const status = id ? modelStatus(id) : null
  if (!id || !status) {
    return { title: '', description: '' }
  }
  const label = modelLabel(id)
  const resume = status.modelDownloaded > 0 ? '，会接着上次的进度继续' : ''
  const runtimeReady = status.downloaded - status.modelDownloaded >= status.runtimeSize
  const parts = runtimeReady
    ? `模型 ${formatFileSize(status.modelSize)}；运行库已就绪`
    : `模型 ${formatFileSize(status.modelSize)}，另需运行库 ${formatFileSize(status.runtimeSize)}，各 AI 模型共用`
  const meanwhile = isHealModel(id)
    ? `下载期间修瑕先用经典算法，下完自动改用 ${label}`
    : `下完就能在清晰化面板里用 ${label}`
  return {
    title: `下载 ${label}？`,
    description:
      `使用 ${label} 需要先下载约 ${formatFileSize(remainingOf(status))}${resume}（${parts}），` +
      `保存到 ${props.models?.dir ?? '模型目录'}。${meanwhile}；可随时暂停或删除。`,
  }
})

const deletePrompt = computed(() => {
  const id = pendingDelete.value
  const status = id ? modelStatus(id) : null
  if (!id || !status) {
    return { title: '', description: '' }
  }
  const label = modelLabel(id)
  const inUse = props.settings.healEngine === id || props.settings.sharpenEngine === id
  const current = inUse ? `当前选用的就是它，删除后${modelPurpose(id)}改用经典方式。` : ''
  return {
    title: `删除 ${label} 模型？`,
    description: `将删除模型文件 ${formatFileSize(status.modelDownloaded)}（含下了一半的部分；运行库别的 AI 模型还在用时保留），之后再用需要重新下载。${current}`,
  }
})

function selectEngine(value: HealEngine): void {
  if (!isAiEngine(value)) {
    emit('update', { healEngine: value })
    return
  }
  if (!props.modelsAvailable) {
    return
  }
  const status = modelStatus(value)
  if (status && (status.state === 'ready' || isModelBusy(status.state))) {
    emit('update', { healEngine: value })
    return
  }
  // 模型还没下完：先问是否下载，同意后再切换。
  pendingDownload.value = value
}

function selectSharpenEngine(value: SharpenEngine): void {
  if (!isAiSharpen(value)) {
    emit('update', { sharpenEngine: value })
    return
  }
  if (!props.modelsAvailable) {
    return
  }
  const status = modelStatus(value)
  if (status && (status.state === 'ready' || isModelBusy(status.state))) {
    emit('update', { sharpenEngine: value })
    return
  }
  // 模型还没下完：先问是否下载，同意后再切换。
  pendingDownload.value = value
}

function confirmDownload(): void {
  const id = pendingDownload.value
  pendingDownload.value = null
  if (!id) {
    return
  }
  emit('update', isHealModel(id) ? { healEngine: id } : { sharpenEngine: id })
  emit('download-model', id)
}

function confirmDelete(): void {
  const id = pendingDelete.value
  pendingDelete.value = null
  if (!id) {
    return
  }
  if (props.settings.healEngine === id) {
    emit('update', { healEngine: 'classic' })
  }
  if (props.settings.sharpenEngine === id) {
    emit('update', { sharpenEngine: 'classic' })
  }
  emit('delete-model', id)
}

function focusTitle(): void {
  titleRef.value?.focus()
}

function setTabButton(key: SettingsCategory, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLButtonElement) {
    tabButtons.set(key, el)
  } else {
    tabButtons.delete(key)
  }
}

/** 页签的键盘操作：左右方向键循环切换，Home / End 跳到首尾。 */
function onTabKeydown(event: KeyboardEvent): void {
  const count = categories.length
  const index = categories.findIndex((category) => category.key === activeCategory.value)
  let next: number
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % count
      break
    case 'ArrowLeft':
      next = (index - 1 + count) % count
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return
  }
  event.preventDefault()
  const key = categories[next].key
  activeCategory.value = key
  tabButtons.get(key)?.focus()
}

function selectOrientation(value: ThumbnailOrientation): void {
  emit('update', { thumbnailOrientation: value })
}

function selectSize(value: ThumbnailSize): void {
  emit('update', { thumbnailSize: value })
}

function selectFit(value: ThumbnailFit): void {
  emit('update', { thumbnailFit: value })
}

defineExpose({ focusTitle })
</script>

<template>
  <section class="settings-page" aria-labelledby="settings-title">
    <header class="settings-hero">
      <span class="settings-hero__mark" aria-hidden="true">
        <Settings2 :size="24" :stroke-width="1.7" />
      </span>
      <div class="settings-hero__copy">
        <div class="settings-hero__title-row">
          <h2 id="settings-title" ref="titleRef" tabindex="-1">设置</h2>
          <span class="settings-pill">仅本机</span>
        </div>
        <p v-if="isFileStorage">
          按类别调整预览缩略图、局部修瑕与清晰化的方式和 AI 模型，以及配置文件的位置。设置会自动保存到配置文件（默认在程序所在目录），不影响导出的原图。
        </p>
        <p v-else>
          按类别调整预览缩略图、局部修瑕与清晰化的方式。设置会自动保存在当前浏览器，不影响导出的原图。
        </p>
      </div>
    </header>

    <div
      class="segmented settings-tabs"
      role="tablist"
      aria-label="设置分类"
      @keydown="onTabKeydown"
    >
      <button
        v-for="category in categories"
        :id="`settings-tab-${category.key}`"
        :key="category.key"
        :ref="(el) => setTabButton(category.key, el)"
        class="segment settings-tab"
        :class="{ 'is-active': activeCategory === category.key }"
        type="button"
        role="tab"
        :aria-selected="activeCategory === category.key"
        :aria-controls="`settings-panel-${category.key}`"
        :tabindex="activeCategory === category.key ? 0 : -1"
        @click="activeCategory = category.key"
      >
        <component :is="category.icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
        <span>{{ category.label }}</span>
        <template v-if="categoryAlerts[category.key]">
          <AlertTriangle
            class="settings-tab__alert"
            :size="13"
            :stroke-width="2"
            aria-hidden="true"
          />
          <span class="sr-only">（有错误）</span>
        </template>
      </button>
    </div>

    <section
      v-show="activeCategory === 'thumbnail'"
      id="settings-panel-thumbnail"
      class="settings-card"
      role="tabpanel"
      aria-labelledby="settings-tab-thumbnail"
    >
      <header class="settings-card__head">
        <div>
          <h3 id="thumbnail-settings-title">预览缩略图</h3>
          <p>缩略图只用于定位预览位置，不参与拼接和导出。</p>
        </div>
        <span class="settings-summary">{{ currentSummary }}</span>
      </header>

      <div class="setting-block">
        <div class="setting-label">
          <h4>显示方向</h4>
          <p>缩略图在预览中的排列方向；数量较多时可以沿该方向滚动。</p>
        </div>
        <div class="settings-choices settings-choices--three" role="group" aria-label="缩略图显示方向">
          <button
            v-for="option in THUMBNAIL_ORIENTATION_OPTIONS"
            :key="option.value"
            class="settings-choice"
            :class="{ 'is-selected': settings.thumbnailOrientation === option.value }"
            type="button"
            :aria-pressed="settings.thumbnailOrientation === option.value"
            :title="option.description"
            @click="selectOrientation(option.value)"
          >
            <component :is="orientationMeta[option.value].icon" :size="17" :stroke-width="1.8" />
            <span>{{ option.label }}</span>
            <small>{{ option.description }}</small>
          </button>
        </div>
      </div>

      <div class="setting-block">
        <div class="setting-label">
          <h4>缩略图大小</h4>
          <p>使用固定尺寸，不随图片数量压缩；超出可用空间时滚动查看。</p>
        </div>
        <div class="settings-choices settings-choices--three" role="group" aria-label="缩略图大小">
          <button
            v-for="option in THUMBNAIL_SIZE_OPTIONS"
            :key="option.value"
            class="settings-choice settings-choice--size"
            :class="{ 'is-selected': settings.thumbnailSize === option.value }"
            type="button"
            :aria-pressed="settings.thumbnailSize === option.value"
            :title="option.description"
            @click="selectSize(option.value)"
          >
            <span
              class="size-sample"
              :class="`size-sample--${option.value}`"
              aria-hidden="true"
            />
            <span>{{ option.label }}</span>
            <small>{{ option.description }}</small>
          </button>
        </div>
      </div>

      <div class="setting-block setting-block--last">
        <div class="setting-label">
          <h4>图片显示方式</h4>
          <p>缩略图比例与图片比例不一致时，选择留白、裁剪或拉伸。</p>
        </div>
        <div class="settings-choices settings-choices--fit" role="group" aria-label="缩略图图片显示方式">
          <button
            v-for="option in THUMBNAIL_FIT_OPTIONS"
            :key="option.value"
            class="settings-choice settings-choice--fit"
            :class="{ 'is-selected': settings.thumbnailFit === option.value }"
            type="button"
            :aria-pressed="settings.thumbnailFit === option.value"
            :title="option.description"
            @click="selectFit(option.value)"
          >
            <span class="fit-demo" :class="`fit-demo--${option.value}`" aria-hidden="true">
              <span class="fit-demo__photo" />
              <span class="fit-demo__sun" />
            </span>
            <span class="fit-demo__copy">
              <span class="fit-demo__label">
                <component :is="fitMeta[option.value].icon" :size="14" :stroke-width="1.9" />
                {{ option.label }}
              </span>
              <small>{{ option.description }}</small>
            </span>
          </button>
        </div>
      </div>
    </section>

    <section
      v-show="activeCategory === 'heal'"
      id="settings-panel-heal"
      class="settings-card"
      role="tabpanel"
      aria-labelledby="settings-tab-heal"
    >
      <header class="settings-card__head">
        <div>
          <h3 id="heal-settings-title">局部修瑕</h3>
          <p>涂抹要去掉的物体后，按这里选的方式补全被挡住的内容。AI 模型下载一次后离线使用，图片不会上传。</p>
        </div>
        <span class="settings-summary">{{ healSummary }}</span>
      </header>

      <div class="setting-block">
        <div class="setting-label">
          <h4>补全方式</h4>
          <p>三种方式各有长处和代价，可按画面选择，随时可以换。选了 AI 但模型还没下完时，修瑕先用经典算法。</p>
        </div>
        <div class="settings-choices settings-choices--three" role="group" aria-label="局部修瑕补全方式">
          <button
            v-for="option in HEAL_ENGINE_OPTIONS"
            :key="option.value"
            class="settings-choice engine-choice"
            :class="{ 'is-selected': settings.healEngine === option.value }"
            type="button"
            :aria-pressed="settings.healEngine === option.value"
            :disabled="isAiEngine(option.value) && !modelsAvailable"
            @click="selectEngine(option.value)"
          >
            <span class="engine-choice__head">
              <component :is="engineIcons[option.value]" :size="17" :stroke-width="1.8" />
              <span class="engine-choice__name">{{ option.label }}</span>
              <span class="engine-choice__tag">{{ option.tag }}</span>
            </span>
            <small>{{ option.summary }}</small>
            <span class="engine-points">
              <span
                v-for="point in option.strengths"
                :key="point"
                class="engine-point engine-point--strength"
              >
                {{ point }}
              </span>
              <span
                v-for="point in option.limits"
                :key="point"
                class="engine-point engine-point--limit"
              >
                {{ point }}
              </span>
            </span>
            <span
              v-if="isAiEngine(option.value)"
              class="engine-choice__state"
              :class="{ 'is-ready': modelStatus(option.value)?.state === 'ready' }"
            >
              {{ modelStateText(modelStatus(option.value)) }}
            </span>
          </button>
        </div>
      </div>

      <div class="setting-block">
        <div class="setting-label">
          <h4>AI 模型下载</h4>
          <p>由本机程序下载，可暂停后接着下；下完按 SHA-256 校验，内容与官方发布一致才会启用。</p>
        </div>
        <div v-if="modelsAvailable" class="model-list">
          <ModelRow
            v-for="option in aiOptions"
            :key="option.value"
            :label="option.label"
            :status="modelStatus(option.value as HealModelId)"
            :state-text="modelStateText(modelStatus(option.value as HealModelId))"
            :busy="modelsBusy"
            @download="emit('download-model', $event)"
            @pause="emit('pause-model', $event)"
            @delete="pendingDelete = $event"
          />
        </div>
        <p v-else class="config-note">
          当前以浏览器页面运行。AI 模型由免安装 EXE 版的本机程序下载和提供，在这里只能使用经典算法。
        </p>
      </div>

      <div class="setting-block setting-block--last">
        <div class="setting-label">
          <h4>模型目录</h4>
          <p>默认放在程序所在目录的 models 文件夹；更改后会把已下载的模型一起移过去。下载进行中不能更改。</p>
        </div>
        <div v-if="modelsAvailable && models" class="config-location">
          <div class="config-path">
            <FolderCog :size="15" :stroke-width="1.8" aria-hidden="true" />
            <span class="config-path__text">{{ models.dir }}</span>
          </div>
          <div class="config-actions">
            <button
              class="button button-secondary"
              type="button"
              :disabled="modelsBusy"
              @click="emit('change-models-dir')"
            >
              <Loader2 v-if="modelsBusy" class="spin" :size="14" :stroke-width="1.9" />
              <FolderInput v-else :size="14" :stroke-width="1.9" />
              更改目录…
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="modelsBusy"
              @click="emit('open-models-dir')"
            >
              <FolderOpen :size="14" :stroke-width="1.9" />
              打开目录
            </button>
            <button
              v-if="!models.isDefault"
              class="button button-secondary"
              type="button"
              :disabled="modelsBusy"
              @click="emit('reset-models-dir')"
            >
              <Undo2 :size="14" :stroke-width="1.9" />
              移回程序目录
            </button>
          </div>
          <p
            v-if="modelsDirStatus"
            class="config-status"
            :class="`config-status--${modelsDirStatus.tone}`"
            role="status"
          >
            {{ modelsDirStatus.text }}
          </p>
        </div>
        <div v-else class="config-location">
          <p v-if="!modelsAvailable" class="config-note">只有免安装 EXE 版会下载模型，浏览器页面没有模型目录。</p>
          <p
            v-else-if="modelsDirStatus"
            class="config-status"
            :class="`config-status--${modelsDirStatus.tone}`"
            role="status"
          >
            {{ modelsDirStatus.text }}
          </p>
          <p v-else class="config-note">正在读取模型目录…</p>
        </div>
      </div>
    </section>

    <section
      v-show="activeCategory === 'sharpen'"
      id="settings-panel-sharpen"
      class="settings-card"
      role="tabpanel"
      aria-labelledby="settings-tab-sharpen"
    >
      <header class="settings-card__head">
        <div>
          <h3 id="sharpen-settings-title">清晰化</h3>
          <p>在预览标注栏的「清晰化」面板里使用；这里选默认方式、下载 AI 模型。AI 模型下载一次后离线使用，图片不会上传。</p>
        </div>
        <span class="settings-summary">{{ sharpenSummary }}</span>
      </header>

      <div class="setting-block">
        <div class="setting-label">
          <h4>清晰化方式</h4>
          <p>经典锐化加强已有的边缘；AI 按画面内容重建细节。也可以在清晰化面板里随时切换。</p>
        </div>
        <div class="settings-choices settings-choices--two" role="group" aria-label="清晰化方式">
          <button
            v-for="option in SHARPEN_ENGINE_OPTIONS"
            :key="option.value"
            class="settings-choice engine-choice"
            :class="{ 'is-selected': settings.sharpenEngine === option.value }"
            type="button"
            :aria-pressed="settings.sharpenEngine === option.value"
            :disabled="isAiSharpen(option.value) && !modelsAvailable"
            @click="selectSharpenEngine(option.value)"
          >
            <span class="engine-choice__head">
              <component :is="sharpenIcons[option.value]" :size="17" :stroke-width="1.8" />
              <span class="engine-choice__name">{{ option.label }}</span>
              <span class="engine-choice__tag">{{ option.tag }}</span>
            </span>
            <small>{{ option.summary }}</small>
            <span class="engine-points">
              <span
                v-for="point in option.strengths"
                :key="point"
                class="engine-point engine-point--strength"
              >
                {{ point }}
              </span>
              <span
                v-for="point in option.limits"
                :key="point"
                class="engine-point engine-point--limit"
              >
                {{ point }}
              </span>
            </span>
            <span
              v-if="isAiSharpen(option.value)"
              class="engine-choice__state"
              :class="{ 'is-ready': modelStatus(option.value)?.state === 'ready' }"
            >
              {{ modelStateText(modelStatus(option.value)) }}
            </span>
          </button>
        </div>
      </div>

      <div class="setting-block setting-block--last">
        <div class="setting-label">
          <h4>AI 模型下载</h4>
          <p>与局部修瑕的模型放在同一个模型目录（在「局部修瑕」里更改），运行库共用一份；下完按 SHA-256 校验。</p>
        </div>
        <div v-if="modelsAvailable" class="model-list">
          <ModelRow
            v-for="option in sharpenAiOptions"
            :key="option.value"
            :label="option.label"
            :status="modelStatus(option.value as SharpenModelId)"
            :state-text="modelStateText(modelStatus(option.value as SharpenModelId))"
            :busy="modelsBusy"
            @download="emit('download-model', $event)"
            @pause="emit('pause-model', $event)"
            @delete="pendingDelete = $event"
          />
        </div>
        <p v-else class="config-note">
          当前以浏览器页面运行。AI 模型由免安装 EXE 版的本机程序下载和提供，在这里只能使用经典锐化。
        </p>
      </div>
    </section>

    <section
      v-show="activeCategory === 'config'"
      id="settings-panel-config"
      class="settings-card"
      role="tabpanel"
      aria-labelledby="settings-tab-config"
    >
      <header class="settings-card__head">
        <div>
          <h3 id="config-settings-title">配置文件</h3>
          <p>缩略图设置、拼接间距与背景、修瑕补全方式、导出格式与压缩设置、上次用的工作区，以及预览面板（标注栏、缩放栏、空白页面板、缩略图）的位置与显示状态都保存在这里；AI 模型文件放在「局部修瑕」分类的模型目录里。</p>
        </div>
        <span class="settings-summary">{{ configSummary }}</span>
      </header>

      <div class="setting-block setting-block--last">
        <div class="setting-label">
          <h4>存储目录</h4>
          <p>默认放在程序所在目录，随程序一起拷走即可沿用；更改后会把配置文件移动到新目录。</p>
        </div>

        <div v-if="isFileStorage && configLocation" class="config-location">
          <div class="config-path">
            <FileCog :size="15" :stroke-width="1.8" aria-hidden="true" />
            <span class="config-path__text">{{ configLocation.file }}</span>
          </div>
          <div class="config-actions">
            <button
              class="button button-secondary"
              type="button"
              :disabled="isMovingDir"
              @click="emit('change-dir')"
            >
              <Loader2 v-if="isMovingDir" class="spin" :size="14" :stroke-width="1.9" />
              <FolderInput v-else :size="14" :stroke-width="1.9" />
              更改目录…
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="isMovingDir"
              @click="emit('open-dir')"
            >
              <FolderOpen :size="14" :stroke-width="1.9" />
              打开目录
            </button>
            <button
              v-if="!configLocation.isDefault"
              class="button button-secondary"
              type="button"
              :disabled="isMovingDir"
              @click="emit('reset-dir')"
            >
              <Undo2 :size="14" :stroke-width="1.9" />
              移回程序目录
            </button>
          </div>
          <p
            v-if="configStatus"
            class="config-status"
            :class="`config-status--${configStatus.tone}`"
            role="status"
          >
            {{ configStatus.text }}
          </p>
        </div>

        <div v-else class="config-location">
          <p class="config-note">
            当前以浏览器页面运行，设置保存在浏览器本地存储。使用免安装 EXE 时才会写入配置文件，并可在这里更改目录。
          </p>
          <p
            v-if="configStatus"
            class="config-status"
            :class="`config-status--${configStatus.tone}`"
            role="status"
          >
            {{ configStatus.text }}
          </p>
        </div>
      </div>
    </section>

    <footer class="settings-footer">
      <p v-if="isFileStorage">
        设置自动保存到配置文件。恢复默认会同时重置拼接间距与背景、修瑕补全方式、导出设置和预览面板的位置与显示状态，不改变配置目录，也不删除已下载的模型。
      </p>
      <p v-else>
        设置自动保存在本机浏览器，换浏览器或清除站点数据后会恢复默认。恢复默认会同时重置拼接间距与背景、导出设置和预览面板的位置与显示状态。
      </p>
      <button class="button button-secondary" type="button" @click="emit('reset')">
        <RotateCcw :size="14" :stroke-width="1.9" />
        恢复默认设置
      </button>
    </footer>

    <ConfirmDialog
      :open="pendingDownload !== null"
      tone="download"
      :title="downloadPrompt.title"
      :description="downloadPrompt.description"
      confirm-label="下载并使用"
      @confirm="confirmDownload"
      @cancel="pendingDownload = null"
    />
    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="deletePrompt.title"
      :description="deletePrompt.description"
      confirm-label="删除模型"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.settings-page {
  width: min(940px, 100%);
  margin: 0 auto;
  padding: 30px 24px 44px;
}

.settings-hero {
  display: flex;
  align-items: flex-start;
  gap: 17px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(520px 180px at 0 0, rgba(15, 118, 110, 0.075), transparent 70%),
    var(--surface);
  box-shadow: var(--shadow-panel);
}

.settings-hero__mark {
  display: inline-flex;
  width: 50px;
  height: 50px;
  flex: 0 0 50px;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: linear-gradient(145deg, var(--brand-start), var(--brand-end));
  color: var(--surface);
  box-shadow: var(--shadow-xs);
}

.settings-hero__copy {
  min-width: 0;
}

.settings-hero__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
}

.settings-hero h2 {
  margin: 0;
  border-radius: 6px;
  color: var(--text-strong);
  font-size: 23px;
  font-weight: 680;
  letter-spacing: -0.025em;
  outline: none;
}

.settings-hero h2:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.settings-pill {
  padding: 2px 7px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.settings-hero p {
  max-width: 700px;
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.75;
}

/* 分类页签：外观用 base.css 的分段控件，这里只管位置与宽度；分类再多时横向滚动，不换行。 */
.settings-tabs {
  width: fit-content;
  max-width: 100%;
  margin-top: 16px;
  overflow-x: auto;
}

.settings-tab {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 外侧焦点框会被横向滚动的容器裁掉，改画在页签里面。 */
.settings-tab:focus-visible {
  outline-offset: -2px;
}

.settings-tab__alert {
  color: var(--danger);
}

.settings-card {
  margin-top: 12px;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}

.settings-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.settings-card h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 650;
}

.settings-card__head p,
.setting-label p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.settings-summary {
  max-width: 300px;
  flex: 0 0 auto;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 10.5px;
  line-height: 1.5;
  text-align: right;
}

.setting-block {
  display: grid;
  grid-template-columns: minmax(180px, 0.9fr) minmax(0, 2.1fr);
  gap: 20px;
  padding: 18px 0;
  border-top: 1px solid var(--border);
}

.setting-block--last {
  padding-bottom: 2px;
}

.setting-label h4 {
  margin: 0;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 650;
}

.settings-choices {
  display: grid;
  gap: 8px;
}

.settings-choices--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.settings-choices--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.settings-choices--fit {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.settings-choice {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-subtle);
  color: var(--text);
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.16s var(--ease),
    background 0.16s var(--ease),
    box-shadow 0.16s var(--ease);
}

.settings-choice:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

.settings-choice.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-line);
}

.settings-choice:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.settings-choice > svg {
  color: var(--accent-ink);
}

.settings-choice small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 450;
  line-height: 1.45;
}

.settings-choice:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.settings-choice:disabled:hover {
  border-color: var(--border);
  background: var(--surface-subtle);
}

.engine-choice {
  gap: 7px;
}

.engine-choice__head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
}

.engine-choice__head > svg {
  flex: 0 0 auto;
  color: var(--accent-ink);
}

.engine-choice__name {
  min-width: 0;
  flex: 1 1 auto;
}

.engine-choice__tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 9.5px;
  font-weight: 600;
}

.engine-points {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}

/* 长处与代价用 + / − 前缀区分，不只靠颜色。 */
.engine-point {
  position: relative;
  padding-left: 13px;
  color: var(--text);
  font-size: 10.5px;
  font-weight: 450;
  line-height: 1.5;
}

.engine-point::before {
  position: absolute;
  left: 0;
  font-weight: 700;
}

.engine-point--strength::before {
  content: '+';
  color: var(--success);
}

.engine-point--limit {
  color: var(--text-muted);
}

.engine-point--limit::before {
  content: '−';
  color: var(--text-faint);
}

.engine-choice__state {
  margin-top: auto;
  padding-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
}

.engine-choice__state.is-ready {
  color: var(--success);
}

.model-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.settings-choice--size {
  align-items: center;
  text-align: center;
}

.settings-choice--size > span:not(.size-sample) {
  font-size: 11.5px;
}

.size-sample {
  display: block;
  border: 1px solid var(--accent-line);
  border-radius: 4px;
  background: linear-gradient(135deg, var(--accent-soft), var(--surface));
}

.size-sample--small {
  width: 18px;
  height: 12px;
}

.size-sample--medium {
  width: 24px;
  height: 15px;
}

.size-sample--large {
  width: 31px;
  height: 18px;
}

.settings-choice--fit {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
}

.fit-demo {
  position: relative;
  display: block;
  width: 54px;
  height: 38px;
  flex: 0 0 54px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background:
    linear-gradient(var(--border) 1px, transparent 1px) 0 0 / 100% 12px,
    var(--surface);
}

.fit-demo__photo {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background:
    linear-gradient(135deg, transparent 44%, var(--accent) 45% 57%, transparent 58%),
    linear-gradient(160deg, var(--brand-start), var(--accent-soft));
}

.fit-demo__sun {
  position: absolute;
  top: 7px;
  right: 9px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--surface);
  opacity: 0.82;
}

.fit-demo--contain .fit-demo__photo {
  top: 20%;
  height: 60%;
}

.fit-demo--cover .fit-demo__photo {
  left: -22%;
  width: 144%;
}

.fit-demo--fill .fit-demo__photo {
  width: 100%;
  height: 100%;
}

.fit-demo__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.fit-demo__label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.fit-demo__label svg {
  color: var(--accent-ink);
}

.config-location {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.config-path {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.55;
}

.config-path > svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--accent-ink);
}

.config-path__text {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: text;
}

.config-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.config-note,
.config-status {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.config-note {
  color: var(--text-muted);
}

.config-status--info {
  color: var(--text-muted);
}

.config-status--success {
  color: var(--success);
}

.config-status--error {
  color: var(--danger);
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 2px 0;
}

.settings-footer p {
  margin: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.5;
}

@media (max-width: 820px) {
  .settings-page {
    padding: 22px 16px 36px;
  }

  .setting-block {
    grid-template-columns: 1fr;
    gap: 11px;
  }

  .settings-card__head {
    flex-direction: column;
    gap: 8px;
  }

  .settings-summary {
    max-width: none;
    text-align: left;
  }
}

@media (max-width: 620px) {
  .settings-hero {
    padding: 20px;
  }

  .settings-card {
    padding: 18px;
  }

  .settings-tabs {
    width: 100%;
  }

  .settings-tab {
    flex: 1 0 0;
  }

  .settings-choices--three,
  .settings-choices--two,
  .settings-choices--fit {
    grid-template-columns: 1fr;
  }

  .settings-choice--fit {
    align-items: center;
  }

  .settings-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 400px) {
  .settings-hero {
    gap: 12px;
  }

  .settings-hero__mark {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
  }

  .settings-hero h2 {
    font-size: 21px;
  }

  .settings-tab {
    padding: 0 6px;
  }
}
</style>
