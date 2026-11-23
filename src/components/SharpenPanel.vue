<script setup lang="ts">
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import { Loader2, Play, RotateCcw, Square, X } from 'lucide-vue-next'
import { AI_SHARPEN_LEVELS, OUTPUT_RESOLUTIONS, formatDuration } from '../core/aiUpscale'
import type { AiSharpenLevel } from '../core/aiUpscale'
import { SHARPEN_LIMITS, SHARPEN_PRESETS, isSameSharpen } from '../core/sharpen'
import type { SharpenSettings } from '../core/sharpen'
import type { AiModelChoice, SharpenAiState } from '../core/sharpenEngine'
import type { SharpenEngine } from '../core/settings'

/**
 * 清晰化面板，两种方式：
 * - 经典锐化：预设与强度 / 半径 / 阈值滑块，改动即应用（由使用方防抖后计算）；
 * - AI：选模型（内置或自定义）、等级和结果倍数后点「开始处理」，较慢，显示进度。
 * 拼接时作用于预览里当前选中的那张，单图编辑时作用于正在编辑的那张。
 */
const props = defineProps<{
  /** 作用的图片名；为空时显示 disabledReason */
  targetName: string | null
  /** 不能清晰化的原因（没有选中图片、空白页等）；为空表示可以操作 */
  disabledReason: string
  engine: SharpenEngine
  settings: SharpenSettings
  aiLevel: AiSharpenLevel
  aiState: SharpenAiState
  aiModels: AiModelChoice[]
  aiModelKey: string
  /** 自定义模型试算中 / 失败原因 / 已识别的倍数 */
  aiModelNote: string
  /** 结果保留原图的几倍 */
  aiResolution: number
  /** 当前模型、等级、图片下能选的倍数；倍数未知时为空 */
  aiAllowedResolutions: number[]
  /** 这张图已应用的方式；没处理过为 null */
  appliedEngine: SharpenEngine | null
  appliedAiLevel: AiSharpenLevel | null
  appliedModel: string | null
  appliedResolution: number
  /** 按当前等级估算的 AI 耗时（秒）；没有目标图时为 0 */
  aiEstimateSeconds: number
  busy: boolean
  /** 0–1 */
  progress: number
}>()

const emit = defineEmits<{
  change: [settings: SharpenSettings]
  'update:engine': [engine: SharpenEngine]
  'update:aiLevel': [level: AiSharpenLevel]
  'update:aiModel': [key: string]
  'update:aiResolution': [resolution: number]
  'ai-start': []
  'ai-stop': []
  reset: []
  close: []
}>()

type SliderKey = keyof SharpenSettings

const SLIDERS: Array<{ key: SliderKey; label: string; unit: string; title: string }> = [
  { key: 'amount', label: '强度', unit: '%', title: '把边缘的明暗差加强多少；过强会出现白边' },
  { key: 'radius', label: '半径', unit: 'px', title: '加强的边缘有多宽；大图或很糊的图可调大' },
  { key: 'threshold', label: '阈值', unit: '', title: '小于它的细微起伏不加强，可避免放大噪点' },
]

const ENGINES: Array<{ value: SharpenEngine; label: string; title: string }> = [
  { value: 'classic', label: '经典锐化', title: '加强已有的边缘，几乎立刻完成' },
  { value: 'ai', label: 'AI', title: 'AI 模型按画面内容重建细节，较慢' },
]

/** 预计超过这么多秒就提醒换「增强」或经典锐化 */
const LONG_AI_SECONDS = 90

const isAi = computed(() => props.engine === 'ai')
const canStart = computed(
  () => props.aiState.ready && props.aiAllowedResolutions.includes(props.aiResolution),
)

function resolutionLabel(resolution: number): string {
  return resolution === 1 ? '原尺寸' : `${resolution} 倍`
}

function resolutionTitle(resolution: number): string {
  if (!props.aiAllowedResolutions.includes(resolution)) {
    return '这个模型、等级或图片尺寸下做不到（倍数要能被模型整除，结果最多 4000 万像素）'
  }
  return resolution === 1
    ? '结果缩回原尺寸，占内存最少'
    : `保留 ${resolution} 倍分辨率；导出时把「尺寸」调到 ${resolution * 100}% 小字才会更清楚`
}

function onModelChange(event: Event): void {
  emit('update:aiModel', (event.target as HTMLSelectElement).value)
}
const estimateText = computed(() =>
  props.aiEstimateSeconds > 0 ? `预计${formatDuration(props.aiEstimateSeconds)}` : '',
)
const isLongAi = computed(() => props.aiEstimateSeconds > LONG_AI_SECONDS)
const appliedClassic = computed(() => props.appliedEngine === 'classic')

const activePreset = computed(
  () => SHARPEN_PRESETS.find((preset) => isSameSharpen(preset.settings, props.settings))?.key ?? null,
)

const statusText = computed(() => {
  if (props.busy) {
    return `正在处理 ${Math.round(props.progress * 100)}%`
  }
  if (props.appliedEngine === 'ai') {
    const level = AI_SHARPEN_LEVELS.find((option) => option.value === props.appliedAiLevel)?.label ?? ''
    const parts = [level, props.appliedResolution > 1 ? `${props.appliedResolution} 倍` : ''].filter(Boolean)
    return `已应用 AI 清晰化${parts.length ? `（${parts.join(' · ')}）` : ''}`
  }
  return props.appliedEngine === 'classic' ? '已应用经典锐化' : '还没有清晰化'
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
      <div class="segmented sharpen-engines" role="group" aria-label="清晰化方式">
        <button
          v-for="option in ENGINES"
          :key="option.value"
          type="button"
          class="segment"
          :class="{ 'is-active': engine === option.value }"
          :aria-pressed="engine === option.value"
          :disabled="busy"
          :title="option.title"
          @click="emit('update:engine', option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <template v-if="!isAi">
        <div class="segmented sharpen-presets" role="group" aria-label="清晰化预设">
          <button
            v-for="preset in SHARPEN_PRESETS"
            :key="preset.key"
            type="button"
            class="segment"
            :class="{ 'is-active': appliedClassic && activePreset === preset.key }"
            :aria-pressed="appliedClassic && activePreset === preset.key"
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
      </template>

      <template v-else>
        <label class="sharpen-model">
          <span class="control-label">模型</span>
          <select :value="aiModelKey" :disabled="busy" @change="onModelChange">
            <option v-for="choice in aiModels" :key="choice.key" :value="choice.key">
              {{ choice.label }}{{ choice.state.ready ? '' : '（未就绪）' }}
            </option>
          </select>
        </label>
        <p v-if="aiModelNote" class="sharpen-estimate">{{ aiModelNote }}</p>
        <div class="sharpen-ai">
          <span class="control-label">结果</span>
          <div class="segmented" role="group" aria-label="AI 清晰化结果分辨率">
            <button
              v-for="resolution in OUTPUT_RESOLUTIONS"
              :key="resolution"
              type="button"
              class="segment"
              :class="{ 'is-active': aiResolution === resolution }"
              :aria-pressed="aiResolution === resolution"
              :disabled="busy || !aiAllowedResolutions.includes(resolution)"
              :title="resolutionTitle(resolution)"
              @click="emit('update:aiResolution', resolution)"
            >
              {{ resolutionLabel(resolution) }}
            </button>
          </div>
        </div>
        <div class="sharpen-ai">
          <span class="control-label">等级</span>
          <div class="segmented" role="group" aria-label="AI 清晰化等级">
            <button
              v-for="level in AI_SHARPEN_LEVELS"
              :key="level.value"
              type="button"
              class="segment"
              :class="{ 'is-active': aiLevel === level.value }"
              :aria-pressed="aiLevel === level.value"
              :disabled="busy"
              :title="level.title"
              @click="emit('update:aiLevel', level.value)"
            >
              {{ level.label }}
            </button>
          </div>
          <button
            v-if="busy"
            class="button button-secondary sharpen-start"
            type="button"
            title="停止这次 AI 处理，图片保持原样"
            @click="emit('ai-stop')"
          >
            <Square :size="12" :stroke-width="2.2" />
            停止
          </button>
          <button
            v-else
            class="button button-primary sharpen-start"
            type="button"
            :disabled="!canStart"
            @click="emit('ai-start')"
          >
            <Play :size="13" :stroke-width="2" />
            {{ appliedEngine === 'ai' ? '重新处理' : '开始处理' }}
          </button>
        </div>
        <p v-if="!aiState.ready" class="sharpen-warning">{{ aiState.reason }}</p>
        <p v-else-if="estimateText && !busy" class="sharpen-estimate" :class="{ 'is-long': isLongAi }">
          {{ estimateText }}<template v-if="isLongAi">；图片较大，可改用「增强」（快约 4 倍）或经典锐化</template>
        </p>
        <p v-if="aiState.ready && aiResolution > 1 && !busy" class="sharpen-estimate">
          结果保留 {{ aiResolution }} 倍分辨率，导出时把「尺寸」调到 {{ aiResolution * 100 }}%，小字才会更清楚。
        </p>
      </template>

      <footer class="sharpen-footer">
        <span class="sharpen-status" :class="{ 'is-applied': appliedEngine !== null && !busy }" role="status">
          <Loader2 v-if="busy" class="spin" :size="12" :stroke-width="2" />
          {{ statusText }}
        </span>
        <button
          class="button button-secondary sharpen-reset"
          type="button"
          :disabled="appliedEngine === null && !busy"
          title="去掉这张图的清晰化，恢复原图"
          @click="emit('reset')"
        >
          <RotateCcw :size="13" :stroke-width="1.9" />
          还原
        </button>
      </footer>

      <p v-if="!isAi" class="sharpen-note">
        能让轻微发软的图更清楚，真正糊掉的细节补不回来；过强会出现白边和噪点。先清晰化再修瑕效果更好，可打开「对比」看前后差别。
      </p>
      <p v-else class="sharpen-note">
        「保真」不缩小直接处理，文字最稳，适合截图；「增强」重建更多，适合模糊照片，但小字会变形。AI 会重画细节，处理完请打开「对比」看前后差别。
      </p>
    </template>
  </section>
</template>

<style scoped>
.sharpen-panel {
  display: flex;
  width: 300px;
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

.sharpen-engines .segment {
  height: 28px;
  flex: 1;
}

.sharpen-presets {
  align-self: flex-start;
}

.sharpen-presets .segment,
.sharpen-ai .segment {
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

.sharpen-ai {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sharpen-model {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sharpen-model select {
  min-width: 0;
  height: 30px;
  flex: 1;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-strong);
  font-size: 12px;
}

.sharpen-model select:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.sharpen-start {
  height: 30px;
  margin-left: auto;
  padding: 0 12px;
  font-size: 11.5px;
}

.sharpen-estimate {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.sharpen-estimate.is-long {
  color: var(--warning);
}

.sharpen-warning {
  color: var(--warning);
  font-size: 11px;
  line-height: 1.6;
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
