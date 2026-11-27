<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertTriangle } from 'lucide-vue-next'
import { getExportFormat, isTransparencyDropped } from '../core/exportFormats'
import type { ExportFormat } from '../core/exportFormats'
import { TRANSPARENT_BACKGROUND, normalizeBackground } from '../core/background'
import type { StitchBackground } from '../core/background'

/**
 * 底栏的「背景」选择：白、黑、透明与自定义颜色。拼接（空位与间距的底色）和单图编辑（图片透明处的底色）共用。
 * JPG 不支持透明，选了透明时按钮上出现警示图标。
 */

interface BackgroundPreset {
  value: StitchBackground
  label: string
}

const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { value: '#ffffff', label: '白' },
  { value: '#000000', label: '黑' },
  { value: TRANSPARENT_BACKGROUND, label: '透明' },
]

/** 还没选过自定义颜色时，取色器打开时的初始颜色 */
const DEFAULT_CUSTOM_BACKGROUND = '#808080'

const props = withDefaults(
  defineProps<{
    background: StitchBackground
    /** 导出对话框里选的格式，只用来提示 JPG 不支持透明 */
    format: ExportFormat
    /** 底色填在哪里，用在按钮提示里，例如「图片之间的空位和间距」 */
    fillTarget: string
    /** 分段控件的无障碍名称 */
    groupLabel: string
    disabled?: boolean
  }>(),
  {
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:background': [value: StitchBackground]
}>()

const activePreset = computed(
  () => BACKGROUND_PRESETS.find((preset) => preset.value === props.background) ?? null,
)

/** 取色器显示的颜色：当前是自定义色就用它，否则记住上次选过的自定义色。 */
const customBackground = ref(activePreset.value ? DEFAULT_CUSTOM_BACKGROUND : props.background)

watch(
  () => props.background,
  (value) => {
    if (!BACKGROUND_PRESETS.some((preset) => preset.value === value)) {
      customBackground.value = value
    }
  },
)

const transparencyDropped = computed(() =>
  isTransparencyDropped(props.background, getExportFormat(props.format)),
)

const transparentTitle = computed(() =>
  transparencyDropped.value
    ? 'JPG 不支持透明，导出时按白底填充；PNG、WebP 保留透明'
    : '背景透明，导出 PNG / WebP 时保留透明',
)

function setBackground(value: StitchBackground): void {
  if (!props.disabled && value !== props.background) {
    emit('update:background', value)
  }
}

function onCustomBackgroundInput(event: Event): void {
  const value = normalizeBackground((event.target as HTMLInputElement).value)
  customBackground.value = value
  setBackground(value)
}
</script>

<template>
  <div class="background-picker">
    <span class="control-label">背景</span>
    <div class="segmented" role="group" :aria-label="groupLabel">
      <button
        v-for="preset in BACKGROUND_PRESETS"
        :key="preset.value"
        type="button"
        class="segment"
        :class="{ 'is-active': background === preset.value }"
        :aria-pressed="background === preset.value"
        :disabled="disabled"
        :title="preset.value === TRANSPARENT_BACKGROUND ? transparentTitle : `${fillTarget}填${preset.label}色`"
        @click="setBackground(preset.value)"
      >
        <span
          class="background-swatch"
          :class="{ 'background-swatch--transparent': preset.value === TRANSPARENT_BACKGROUND }"
          :style="preset.value === TRANSPARENT_BACKGROUND ? undefined : { background: preset.value }"
          aria-hidden="true"
        />
        <span>{{ preset.label }}</span>
        <AlertTriangle
          v-if="preset.value === TRANSPARENT_BACKGROUND && transparencyDropped"
          class="background-warning"
          :size="12"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
      <label
        class="segment background-custom"
        :class="{ 'is-active': !activePreset, 'is-disabled': disabled }"
        :title="`${fillTarget}填自定义颜色`"
      >
        <span class="background-swatch" :style="{ background: customBackground }" aria-hidden="true" />
        <span>自定义</span>
        <input
          type="color"
          :value="customBackground"
          :disabled="disabled"
          aria-label="自定义背景色"
          @input="onCustomBackgroundInput"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.background-picker {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 6px;
}

.background-picker .segment {
  padding: 0 9px;
  white-space: nowrap;
}

.background-swatch {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}

.background-warning {
  flex: 0 0 auto;
  margin-left: -1px;
  color: var(--warning);
}

.background-swatch--transparent {
  background: repeating-conic-gradient(var(--surface-inset) 0 25%, var(--surface) 0 50%) 0 0 /
    6px 6px;
}

/* 取色器铺满整个分段并设为透明：点哪里都打开取色器，弹出位置也贴着按钮。 */
.background-custom {
  position: relative;
  cursor: pointer;
}

.background-custom input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
}

.background-custom:hover:not(.is-active):not(.is-disabled) {
  color: var(--text);
}

/* 取色器本身透明看不到焦点框，键盘聚焦时把焦点框画在分段上。 */
.background-custom:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.background-custom.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.background-custom.is-disabled input {
  cursor: not-allowed;
}
</style>
