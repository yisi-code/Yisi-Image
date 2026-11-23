<script setup lang="ts">
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import { Loader2, RotateCcw, X } from 'lucide-vue-next'
import { SHARPEN_LIMITS, SHARPEN_PRESETS, isSameSharpen } from '../core/sharpen'
import type { SharpenSettings } from '../core/sharpen'

/**
 * 清晰化面板：预设与强度 / 半径 / 阈值三个滑块，改动即应用到目标图片（由使用方防抖后计算）。
 * 拼接时作用于预览里当前选中的那张，单图编辑时作用于正在编辑的那张。
 */
const props = defineProps<{
  /** 作用的图片名；为空时显示 disabledReason */
  targetName: string | null
  /** 不能清晰化的原因（没有选中图片、空白页等）；为空表示可以操作 */
  disabledReason: string
  settings: SharpenSettings
  /** 这张图是否已经应用了清晰化 */
  applied: boolean
  busy: boolean
  /** 0–1 */
  progress: number
}>()

const emit = defineEmits<{
  change: [settings: SharpenSettings]
  reset: []
  close: []
}>()

type SliderKey = keyof SharpenSettings

const SLIDERS: Array<{ key: SliderKey; label: string; unit: string; title: string }> = [
  { key: 'amount', label: '强度', unit: '%', title: '把边缘的明暗差加强多少；过强会出现白边' },
  { key: 'radius', label: '半径', unit: 'px', title: '加强的边缘有多宽；大图或很糊的图可调大' },
  { key: 'threshold', label: '阈值', unit: '', title: '小于它的细微起伏不加强，可避免放大噪点' },
]

const activePreset = computed(
  () => SHARPEN_PRESETS.find((preset) => isSameSharpen(preset.settings, props.settings))?.key ?? null,
)

const statusText = computed(() => {
  if (props.busy) {
    return `正在处理 ${Math.round(props.progress * 100)}%`
  }
  return props.applied ? '已应用到这张图' : '还没有清晰化'
})

function sliderStyle(key: SliderKey): CSSProperties {
  const { min, max } = SHARPEN_LIMITS[key]
  return { '--range-progress': `${((props.settings[key] - min) / (max - min)) * 100}%` } as CSSProperties
}

function formatValue(key: SliderKey): string {
  const value = props.settings[key]
  return key === 'radius' ? value.toFixed(1) : String(value)
}

function onSlider(event: Event, key: SliderKey): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value !== props.settings[key]) {
    emit('change', { ...props.settings, [key]: value })
  }
}

function applyPreset(settings: SharpenSettings): void {
  emit('change', { ...settings })
}
</script>

<template>
  <section
    class="sharpen-panel"
    role="dialog"
    aria-label="清晰化"
    @keydown.esc.stop="emit('close')"
    @pointerdown.stop
    @wheel.stop
  >
    <header class="sharpen-header">
      <div class="sharpen-heading">
        <strong>清晰化</strong>
        <span v-if="targetName" class="sharpen-target" :title="targetName">{{ targetName }}</span>
      </div>
      <button class="icon-button sharpen-close" type="button" aria-label="关闭清晰化面板" @click="emit('close')">
        <X :size="14" :stroke-width="1.9" />
      </button>
    </header>

    <p v-if="disabledReason" class="sharpen-note">{{ disabledReason }}</p>

    <template v-else>
      <div class="segmented sharpen-presets" role="group" aria-label="清晰化预设">
        <button
          v-for="preset in SHARPEN_PRESETS"
          :key="preset.key"
          type="button"
          class="segment"
          :class="{ 'is-active': applied && activePreset === preset.key }"
          :aria-pressed="applied && activePreset === preset.key"
          :title="preset.title"
          @click="applyPreset(preset.settings)"
        >
          {{ preset.label }}
        </button>
      </div>

      <div v-for="slider in SLIDERS" :key="slider.key" class="sharpen-row" :title="slider.title">
        <span class="control-label">{{ slider.label }}</span>
        <input
          class="range-slider"
          type="range"
          :value="settings[slider.key]"
          :min="SHARPEN_LIMITS[slider.key].min"
          :max="SHARPEN_LIMITS[slider.key].max"
          :step="SHARPEN_LIMITS[slider.key].step"
          :style="sliderStyle(slider.key)"
          :aria-label="slider.label"
          :aria-valuetext="`${formatValue(slider.key)}${slider.unit}`"
          @input="onSlider($event, slider.key)"
        />
        <span class="sharpen-value tnum">{{ formatValue(slider.key) }}{{ slider.unit }}</span>
      </div>

      <footer class="sharpen-footer">
        <span class="sharpen-status" :class="{ 'is-applied': applied && !busy }" role="status">
          <Loader2 v-if="busy" class="spin" :size="12" :stroke-width="2" />
          {{ statusText }}
        </span>
        <button
          class="button button-secondary sharpen-reset"
          type="button"
          :disabled="!applied && !busy"
          title="去掉这张图的清晰化，恢复原图"
          @click="emit('reset')"
        >
          <RotateCcw :size="13" :stroke-width="1.9" />
          还原
        </button>
      </footer>

      <p class="sharpen-note">
        能让轻微发软的图更清楚，真正糊掉的细节补不回来；过强会出现白边和噪点。先清晰化再修瑕效果更好，可打开「对比」看前后差别。
      </p>
    </template>
  </section>
</template>

<style scoped>
.sharpen-panel {
  display: flex;
  width: 290px;
  flex-direction: column;
  gap: 11px;
  padding: 12px 14px 13px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-float);
}

.sharpen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sharpen-heading {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.sharpen-heading strong {
  flex: 0 0 auto;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
}

.sharpen-target {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sharpen-close {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
}

.sharpen-presets {
  align-self: flex-start;
}

.sharpen-presets .segment {
  height: 28px;
  padding: 0 14px;
}

.sharpen-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 46px;
  align-items: center;
  gap: 10px;
}

.sharpen-value {
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 650;
  text-align: right;
}

.sharpen-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sharpen-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 11px;
}

.sharpen-status.is-applied {
  color: var(--success);
}

.sharpen-reset {
  height: 28px;
  padding: 0 10px;
  font-size: 11.5px;
}

.sharpen-note {
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.65;
}
</style>
