<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { AlertTriangle, Columns3, Rows3 } from 'lucide-vue-next'
import { getExportFormat, isTransparencyDropped } from '../core/exportFormats'
import type { ExportFormat } from '../core/exportFormats'
import { MAX_GAP, MIN_GAP, clampGap } from '../core/layout'
import { TRANSPARENT_BACKGROUND, normalizeBackground } from '../core/settings'
import type { StitchBackground } from '../core/settings'
import type { StitchDirection } from '../core/types'

interface BackgroundPreset {
  value: StitchBackground
  label: string
  /** 提示里的底色叫法 */
  name: string
}

const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { value: '#ffffff', label: '白', name: '白底' },
  { value: '#000000', label: '黑', name: '黑底' },
  { value: TRANSPARENT_BACKGROUND, label: '透明', name: '透明底' },
]

/** 还没选过自定义颜色时，取色器打开时的初始颜色 */
const DEFAULT_CUSTOM_BACKGROUND = '#808080'

const props = withDefaults(
  defineProps<{
    direction: StitchDirection
    gap: number
    background: StitchBackground
    /** 导出对话框里选的格式，只用来提示 JPG 不支持透明 */
    format: ExportFormat
    disabled?: boolean
  }>(),
  {
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:direction': [value: StitchDirection]
  'update:gap': [value: number]
  'update:background': [value: StitchBackground]
}>()

const gapPercent = computed(
  () => ((clampGap(props.gap) - MIN_GAP) / (MAX_GAP - MIN_GAP)) * 100,
)

const rangeStyle = computed(
  () => ({ '--range-progress': `${gapPercent.value}%` }) as CSSProperties,
)

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

const backgroundHint = computed(() => {
  if (transparencyDropped.value) {
    return 'JPG 不支持透明 · 按白底导出'
  }
  return `原图尺寸 · ${activePreset.value?.name ?? '自定义底色'}`
})

function setDirection(value: StitchDirection): void {
  if (value !== props.direction) {
    emit('update:direction', value)
  }
}

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

function applyGap(raw: string, input?: HTMLInputElement): void {
  if (raw.trim() === '') {
    return
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return
  }

  const safe = clampGap(parsed)
  if (input && String(safe) !== raw) {
    input.value = String(safe)
  }
  if (safe !== props.gap) {
    emit('update:gap', safe)
  }
}

function onGapInput(event: Event): void {
  const input = event.target as HTMLInputElement
  applyGap(input.value, input)
}

function onGapBlur(event: FocusEvent): void {
  const input = event.target as HTMLInputElement
  input.value = String(props.gap)
}

function onRangeInput(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('update:gap', clampGap(Number(input.value)))
}
</script>

<template>
  <div class="stitch-controls">
    <div class="control-group direction-group">
      <span class="control-label">拼接方向</span>
      <div class="segmented" role="group" aria-label="拼接方向">
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': direction === 'vertical' }"
          :aria-pressed="direction === 'vertical'"
          title="图片上下排列"
          @click="setDirection('vertical')"
        >
          <Rows3 :size="15" :stroke-width="1.8" />
          <span>纵向</span>
        </button>
        <button
          type="button"
          class="segment"
          :class="{ 'is-active': direction === 'horizontal' }"
          :aria-pressed="direction === 'horizontal'"
          title="图片左右排列"
          @click="setDirection('horizontal')"
        >
          <Columns3 :size="15" :stroke-width="1.8" />
          <span>横向</span>
        </button>
      </div>
    </div>

    <span class="control-divider" aria-hidden="true" />

    <div class="control-group gap-group">
      <div class="gap-heading">
        <label class="control-label" for="stitch-gap">间距</label>
        <span class="number-field">
          <input
            type="number"
            :value="gap"
            :min="MIN_GAP"
            :max="MAX_GAP"
            step="1"
            inputmode="numeric"
            aria-label="拼接间距，单位像素"
            @input="onGapInput"
            @blur="onGapBlur"
          />
          <span>px</span>
        </span>
      </div>
      <input
        id="stitch-gap"
        class="range-slider"
        type="range"
        :value="gap"
        :min="MIN_GAP"
        :max="MAX_GAP"
        step="1"
        :style="rangeStyle"
        :aria-valuetext="`${gap} 像素`"
        @input="onRangeInput"
      />
    </div>

    <div class="control-group background-group">
      <span class="control-label">背景</span>
      <div class="segmented" role="group" aria-label="拼接背景">
        <button
          v-for="preset in BACKGROUND_PRESETS"
          :key="preset.value"
          type="button"
          class="segment"
          :class="{ 'is-active': background === preset.value }"
          :aria-pressed="background === preset.value"
          :disabled="disabled"
          :title="
            preset.value === TRANSPARENT_BACKGROUND
              ? transparentTitle
              : `图片之间的空位和间距填${preset.label}色`
          "
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
          title="自定义背景色"
        >
          <span
            class="background-swatch"
            :style="{ background: customBackground }"
            aria-hidden="true"
          />
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

    <span class="control-hint" :class="{ 'is-warning': transparencyDropped }">
      {{ backgroundHint }}
    </span>
  </div>
</template>

<style scoped>
.stitch-controls {
  display: flex;
  min-height: 82px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 24px;
  padding: 13px 20px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface);
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gap-group {
  min-width: 200px;
  max-width: 520px;
  flex: 1;
}

.gap-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.direction-group,
.background-group {
  flex: 0 0 auto;
}

.stitch-controls .segment {
  white-space: nowrap;
}

.background-group .segment {
  padding: 0 9px;
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

.control-hint {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.control-hint.is-warning {
  color: var(--warning);
}

/* 一行放下提示要约 1240 宽；更窄时只靠透明按钮上的警示图标和导出对话框里的提示。 */
@media (max-width: 1240px) {
  .control-hint {
    display: none;
  }
}

@media (max-width: 700px) {
  .stitch-controls {
    flex-wrap: wrap;
    gap: 12px 16px;
    padding: 12px 14px;
  }

  .direction-group {
    order: 1;
  }

  .background-group {
    order: 2;
    margin-left: auto;
  }

  .gap-group {
    order: 3;
    min-width: 100%;
    max-width: none;
    flex-basis: 100%;
  }

  .control-divider {
    display: none;
  }

  .number-field {
    height: 26px;
  }

  .number-field input {
    height: 26px;
  }
}
</style>
