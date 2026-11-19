<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowLeftRight,
  ArrowUpDown,
  Crop,
  Expand,
  FileCog,
  FolderInput,
  FolderOpen,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Settings2,
  Undo2,
} from 'lucide-vue-next'
import type { ConfigDirStatus, SettingsStorage } from '../composables/useSettings'
import type { ConfigLocation } from '../core/configApi'
import {
  THUMBNAIL_FIT_OPTIONS,
  THUMBNAIL_ORIENTATION_OPTIONS,
  THUMBNAIL_SIZE_OPTIONS,
} from '../core/settings'
import type {
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
}>()

const emit = defineEmits<{
  update: [patch: Partial<ToolSettings>]
  reset: []
  'change-dir': []
  'reset-dir': []
  'open-dir': []
}>()

const titleRef = ref<HTMLElement | null>(null)

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

function focusTitle(): void {
  titleRef.value?.focus()
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
          调整预览缩略图的方向、大小和图片显示方式。设置会自动保存到配置文件（默认在程序所在目录），不影响导出的原图。
        </p>
        <p v-else>
          调整预览缩略图的方向、大小和图片显示方式。设置会自动保存在当前浏览器，不影响导出的原图。
        </p>
      </div>
    </header>

    <section class="settings-card" aria-labelledby="thumbnail-settings-title">
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

    <section class="settings-card" aria-labelledby="config-settings-title">
      <header class="settings-card__head">
        <div>
          <h3 id="config-settings-title">配置文件</h3>
          <p>缩略图设置、拼接间距和预览工具栏的位置与收起状态都保存在这里。</p>
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
        设置自动保存到配置文件。恢复默认会同时重置拼接间距和工具栏位置，不改变配置目录。
      </p>
      <p v-else>
        设置自动保存在本机浏览器，换浏览器或清除站点数据后会恢复默认。恢复默认会同时重置拼接间距和工具栏位置。
      </p>
      <button class="button button-secondary" type="button" @click="emit('reset')">
        <RotateCcw :size="14" :stroke-width="1.9" />
        恢复默认设置
      </button>
    </footer>
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

.settings-card {
  margin-top: 16px;
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

  .settings-choices--three,
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
}
</style>
