import { DEFAULT_EXPORT_FORMAT, EXPORT_FORMATS, EXPORT_QUALITY, getExportFormat } from './exportFormats'
import type { ExportFormat } from './exportFormats'

/**
 * 导出对话框的压缩与格式设置：拼接导出与单图导出共用，随设置保存。
 * 质量与目标大小只对有损格式（JPG / WebP）生效；缩小尺寸对所有格式生效。
 */

/** none：原尺寸；percent：按百分比；longEdge：限定最长边（只缩不放） */
export type ResizeMode = 'none' | 'percent' | 'longEdge'
/** quality：按质量滑块；target：按目标文件大小自动找质量 */
export type CompressMode = 'quality' | 'target'

export interface ExportOptions {
  format: ExportFormat
  /** 10–100，有损格式的编码质量 */
  quality: number
  compressBy: CompressMode
  /** 目标大小，单位 KB */
  targetKb: number
  resize: ResizeMode
  /** 5–400；超过 100 是放大 */
  percent: number
  /** 最长边像素 */
  longEdge: number
}

export const MIN_QUALITY = 10
export const MAX_QUALITY = 100
export const MIN_PERCENT = 5
/** 允许放大到 400%：AI 清晰化保留了 2 倍、4 倍细节的图片，放大导出才用得上 */
export const MAX_PERCENT = 400
export const MIN_LONG_EDGE = 16
export const MAX_LONG_EDGE = 16_384
export const MIN_TARGET_KB = 10
export const MAX_TARGET_KB = 51_200

export const DEFAULT_EXPORT_OPTIONS: Readonly<ExportOptions> = Object.freeze({
  format: DEFAULT_EXPORT_FORMAT,
  quality: Math.round(EXPORT_QUALITY * 100),
  compressBy: 'quality',
  targetKb: 500,
  resize: 'none',
  percent: 50,
  longEdge: 1920,
})

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

function isExportFormat(value: unknown): value is ExportFormat {
  return EXPORT_FORMATS.some((format) => format.value === value)
}

/** 逐项校验，非法值回退默认；返回全新对象。 */
export function normalizeExportOptions(value: unknown): ExportOptions {
  const parsed = (value ?? {}) as Partial<Record<keyof ExportOptions, unknown>>
  const defaults = DEFAULT_EXPORT_OPTIONS
  return {
    format: isExportFormat(parsed.format) ? parsed.format : defaults.format,
    quality: clampInteger(parsed.quality, MIN_QUALITY, MAX_QUALITY, defaults.quality),
    compressBy:
      parsed.compressBy === 'quality' || parsed.compressBy === 'target'
        ? parsed.compressBy
        : defaults.compressBy,
    targetKb: clampInteger(parsed.targetKb, MIN_TARGET_KB, MAX_TARGET_KB, defaults.targetKb),
    resize:
      parsed.resize === 'none' || parsed.resize === 'percent' || parsed.resize === 'longEdge'
        ? parsed.resize
        : defaults.resize,
    percent: clampInteger(parsed.percent, MIN_PERCENT, MAX_PERCENT, defaults.percent),
    longEdge: clampInteger(parsed.longEdge, MIN_LONG_EDGE, MAX_LONG_EDGE, defaults.longEdge),
  }
}

export interface OutputSize {
  width: number
  height: number
  /** 输出尺寸 / 原尺寸，恒 ≤ 1 */
  scale: number
}

/** 按尺寸设置换算输出尺寸：百分比可缩可放；最长边模式只缩不放，原图已经更小时保持原尺寸。 */
export function getOutputSize(
  width: number,
  height: number,
  options: Pick<ExportOptions, 'resize' | 'percent' | 'longEdge'>,
): OutputSize {
  let scale = 1
  if (options.resize === 'percent') {
    scale = options.percent / 100
  } else if (options.resize === 'longEdge') {
    scale = Math.min(1, options.longEdge / Math.max(1, width, height))
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

/** 是否使用目标大小模式：只有有损格式才能靠调质量控制大小。 */
export function usesTargetSize(options: Pick<ExportOptions, 'format' | 'compressBy'>): boolean {
  return options.compressBy === 'target' && getExportFormat(options.format).supportsQuality
}

export interface TargetSearchResult<T extends { size: number }> {
  blob: T
  /** 0–1 */
  quality: number
  /** 是否压到了目标以内；false 表示最低质量仍超出 */
  fits: boolean
}

/**
 * 找不超过目标大小的最高质量：先试最高质量，不行再二分，共约 7 次编码。
 * 最低质量仍超出时返回最低质量的结果，由界面提示需要再缩小尺寸。
 */
export async function findQualityForTarget<T extends { size: number }>(
  encode: (quality: number) => Promise<T>,
  targetBytes: number,
  { min = MIN_QUALITY / 100, max = MAX_QUALITY / 100, iterations = 6 } = {},
): Promise<TargetSearchResult<T>> {
  const top = await encode(max)
  if (top.size <= targetBytes) {
    return { blob: top, quality: max, fits: true }
  }
  let low = min
  let high = max
  let best: TargetSearchResult<T> | null = null
  for (let step = 0; step < iterations; step += 1) {
    const quality = Math.round(((low + high) / 2) * 100) / 100
    if (quality <= low || quality >= high) {
      break
    }
    const blob = await encode(quality)
    if (blob.size <= targetBytes) {
      best = { blob, quality, fits: true }
      low = quality
    } else {
      high = quality
    }
  }
  if (best) {
    return best
  }
  const bottom = await encode(min)
  return { blob: bottom, quality: min, fits: bottom.size <= targetBytes }
}

/** 换掉文件扩展名；没有扩展名时直接追加。 */
export function replaceExtension(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return `${base || '图片'}.${extension}`
}

/** 同名时按 Windows 习惯加「 (2)」「 (3)」，比较不分大小写。 */
export function makeUniqueFileName(fileName: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(fileName)) {
    return fileName
  }
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${extension}`
    if (!isTaken(candidate)) {
      return candidate
    }
  }
  return `${base}-${Date.now()}${extension}`
}

/** 压缩比例，例如 1.2 MB → 300 KB 返回 -75；原大小未知时返回 null。 */
export function getSizeChangePercent(before: number, after: number): number | null {
  if (!Number.isFinite(before) || before <= 0) {
    return null
  }
  return Math.round(((after - before) / before) * 100)
}
