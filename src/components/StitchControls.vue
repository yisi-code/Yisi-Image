<script setup lang="ts">
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import { Columns3, Rows3 } from 'lucide-vue-next'
import type { ExportFormat, ExportFormatOption } from '../core/exportFormats'
import { MAX_GAP, MIN_GAP, clampGap } from '../core/layout'
import type { StitchDirection } from '../core/types'

const props = withDefaults(
  defineProps<{
    direction: StitchDirection
    gap: number
    format: ExportFormat
    formats: readonly ExportFormatOption[]
    disabled?: boolean
  }>(),
  {
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:direction': [value: StitchDirection]
  'update:gap': [value: number]
  'update:format': [value: ExportFormat]
}>()

const gapPercent = computed(
  () => ((clampGap(props.gap) - MIN_GAP) / (MAX_GAP - MIN_GAP)) * 100,
)

const rangeStyle = computed(
  () => ({ '--range-progress': `${gapPercent.value}%` }) as CSSProperties,
)

function setDirection(value: StitchDirection): void {
  if (value !== props.direction) {
    emit('update:direction', value)
  }
}

function setFormat(value: ExportFormat): void {
  if (!props.disabled && value !== props.format) {
    emit('update:format', value)
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
        <span class="gap-number">
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
        class="gap-slider"
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

    <div class="control-group format-group">
      <span class="control-label">导出格式</span>
      <div class="segmented" role="group" aria-label="导出格式">
        <button
          v-for="option in formats"
          :key="option.value"
          type="button"
          class="segment"
          :class="{ 'is-active': format === option.value }"
          :aria-pressed="format === option.value"
          :disabled="disabled"
          :title="`导出为 ${option.longLabel}`"
          @click="setFormat(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <span class="control-hint">原图尺寸 · 白底</span>
  </div>
</template>

<style scoped>
.stitch-controls {
  display: flex;
  min-height: 82px;
  flex: 0 0 auto;
  align-items: center;
  gap: 24px;
  padding: 13px 20px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface);
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.control-label {
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.2;
}

.segmented {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-inset);
}

.segment {
  display: flex;
  height: 30px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 600;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease),
    box-shadow 0.15s var(--ease);
}

.segment:hover:not(.is-active):not(:disabled) {
  color: var(--text);
}

.segment:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.segment.is-active {
  border-color: var(--border);
  background: var(--surface);
  color: var(--text-strong);
  box-shadow: var(--shadow-xs);
}

.control-divider {
  width: 1px;
  height: 36px;
  flex: 0 0 1px;
  background: var(--border-subtle);
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

.gap-number {
  display: inline-flex;
  height: 24px;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
  font-size: 10px;
}

.gap-number input {
  width: 46px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
  text-align: right;
  -moz-appearance: textfield;
}

.gap-number input::-webkit-inner-spin-button,
.gap-number input::-webkit-outer-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.gap-number input:hover {
  border-color: var(--border-strong);
}

.gap-slider {
  width: 100%;
  height: 18px;
  margin: 1px 0 0;
  padding: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.gap-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent) 0 var(--range-progress),
    var(--surface-inset) var(--range-progress) 100%
  );
}

.gap-slider::-webkit-slider-thumb {
  width: 16px;
  height: 16px;
  margin-top: -6px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  appearance: none;
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(19, 32, 28, 0.18);
  transition: box-shadow 0.15s var(--ease);
}

.gap-slider:hover::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.gap-slider:focus-visible {
  outline: none;
}

.gap-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px var(--accent-soft-strong);
}

.gap-slider::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: var(--surface-inset);
}

.gap-slider::-moz-range-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--accent);
}

.gap-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(19, 32, 28, 0.18);
}

.format-group {
  flex: 0 0 auto;
}

.format-group .segment {
  min-width: 40px;
  padding: 0 8px;
}

.control-hint {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

@media (max-width: 1100px) {
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

  .format-group {
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

  .gap-number {
    height: 26px;
  }

  .gap-number input {
    height: 26px;
  }
}
</style>
