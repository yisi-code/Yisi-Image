<script setup lang="ts">
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import { Columns3, Rows3 } from 'lucide-vue-next'
import BackgroundPicker from './BackgroundPicker.vue'
import { getExportFormat, isTransparencyDropped } from '../core/exportFormats'
import type { ExportFormat } from '../core/exportFormats'
import { MAX_GAP, MIN_GAP, clampGap } from '../core/layout'
import { TRANSPARENT_BACKGROUND } from '../core/settings'
import type { StitchBackground } from '../core/settings'
import type { StitchDirection } from '../core/types'

/** 提示里的底色叫法 */
const BACKGROUND_NAMES: Record<string, string> = {
  '#ffffff': '白底',
  '#000000': '黑底',
  [TRANSPARENT_BACKGROUND]: '透明底',
}

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

const transparencyDropped = computed(() =>
  isTransparencyDropped(props.background, getExportFormat(props.format)),
)

const backgroundHint = computed(() => {
  if (transparencyDropped.value) {
    return 'JPG 不支持透明 · 按白底导出'
  }
  // 图片可在「调整」里缩放、裁剪，不再写「原图尺寸」。
  return `底色 · ${BACKGROUND_NAMES[props.background] ?? '自定义'}`
})

function setDirection(value: StitchDirection): void {
  if (value !== props.direction) {
    emit('update:direction', value)
  }
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

    <BackgroundPicker
      class="background-group"
      :background="background"
      :format="format"
      :disabled="disabled"
      fill-target="图片之间的空位和间距"
      group-label="拼接背景"
      @update:background="emit('update:background', $event)"
    />

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

.direction-group {
  flex: 0 0 auto;
}

.stitch-controls .segment {
  white-space: nowrap;
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
