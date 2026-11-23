/**
 * 经典清晰化：反锐化掩模（unsharp mask）。
 * 先用三次盒式模糊近似高斯模糊，再把「原图 − 模糊」的差按强度加回去，边缘就更清楚；
 * 差值小于阈值的地方不处理，避免把平坦区域的噪点也放大。只处理 RGB，透明度原样保留。
 * 纯函数，可在 Worker 和单元测试里直接跑。
 */

export interface SharpenSettings {
  /** 强度，百分比：0 不处理，100 表示把差值原样加回一倍 */
  amount: number
  /** 半径（高斯 σ，像素）：越大影响的边缘越宽 */
  radius: number
  /** 阈值（0–255 的亮度差）：小于它的细微起伏不加强 */
  threshold: number
}

export const SHARPEN_LIMITS = {
  amount: { min: 0, max: 300, step: 5 },
  radius: { min: 0.8, max: 5, step: 0.1 },
  threshold: { min: 0, max: 30, step: 1 },
} as const

export interface SharpenPreset {
  key: string
  label: string
  title: string
  settings: SharpenSettings
}

export const SHARPEN_PRESETS: readonly SharpenPreset[] = [
  {
    key: 'light',
    label: '轻度',
    title: '轻微发软的照片，几乎看不出处理痕迹',
    settings: { amount: 60, radius: 1, threshold: 2 },
  },
  {
    key: 'standard',
    label: '标准',
    title: '多数略模糊的图片',
    settings: { amount: 120, radius: 1.5, threshold: 3 },
  },
  {
    key: 'strong',
    label: '强',
    title: '明显模糊的图片；过强会出现白边和噪点',
    settings: { amount: 200, radius: 2.2, threshold: 4 },
  },
]

export const DEFAULT_SHARPEN: Readonly<SharpenSettings> = Object.freeze({
  ...SHARPEN_PRESETS[1].settings,
})

function clampNumber(value: unknown, min: number, max: number, fallback: number, digits = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const factor = 10 ** digits
  return Math.min(max, Math.max(min, Math.round(value * factor) / factor))
}

export function normalizeSharpen(value: unknown): SharpenSettings {
  const parsed = (value ?? {}) as Partial<Record<keyof SharpenSettings, unknown>>
  return {
    amount: clampNumber(parsed.amount, SHARPEN_LIMITS.amount.min, SHARPEN_LIMITS.amount.max, DEFAULT_SHARPEN.amount),
    radius: clampNumber(parsed.radius, SHARPEN_LIMITS.radius.min, SHARPEN_LIMITS.radius.max, DEFAULT_SHARPEN.radius, 1),
    threshold: clampNumber(
      parsed.threshold,
      SHARPEN_LIMITS.threshold.min,
      SHARPEN_LIMITS.threshold.max,
      DEFAULT_SHARPEN.threshold,
    ),
  }
}

export function isSameSharpen(a: SharpenSettings, b: SharpenSettings): boolean {
  return a.amount === b.amount && a.radius === b.radius && a.threshold === b.threshold
}

/** 强度为 0 时等于没处理。 */
export function isSharpenNoop(settings: SharpenSettings): boolean {
  return settings.amount <= 0
}

/**
 * 用 n 次盒式模糊近似 σ 的高斯模糊，返回每次的盒宽（奇数）。
 * 做法来自 W. Jarosz《Fast Image Convolutions》与 Ivan Kutskir 的整理。
 */
export function boxSizesForGauss(sigma: number, count = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / count + 1)
  let lower = Math.floor(ideal)
  if (lower % 2 === 0) {
    lower -= 1
  }
  const upper = lower + 2
  const idealSmall =
    (12 * sigma * sigma - count * lower * lower - 4 * count * lower - 3 * count) / (-4 * lower - 4)
  const small = Math.round(idealSmall)
  return Array.from({ length: count }, (_, index) => (index < small ? lower : upper))
}

/** 一行一行做水平盒式模糊；越界按边缘像素延伸。 */
function boxBlurHorizontal(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const inverse = 1 / (radius * 2 + 1)
  const last = width - 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) {
      sum += source[row + Math.min(last, Math.max(0, k))]
    }
    for (let x = 0; x < width; x += 1) {
      target[row + x] = Math.round(sum * inverse)
      sum += source[row + Math.min(last, x + radius + 1)] - source[row + Math.max(0, x - radius)]
    }
  }
}

/** 一列一列做竖直盒式模糊；越界按边缘像素延伸。 */
function boxBlurVertical(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const inverse = 1 / (radius * 2 + 1)
  const last = height - 1
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) {
      sum += source[Math.min(last, Math.max(0, k)) * width + x]
    }
    for (let y = 0; y < height; y += 1) {
      target[y * width + x] = Math.round(sum * inverse)
      sum +=
        source[Math.min(last, y + radius + 1) * width + x] - source[Math.max(0, y - radius) * width + x]
    }
  }
}

/** 对单个通道做近似高斯模糊，结果写回 channel；temp 是同样大小的工作区。 */
export function gaussianBlurChannel(
  channel: Uint8ClampedArray,
  temp: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): void {
  for (const size of boxSizesForGauss(sigma)) {
    const radius = (size - 1) / 2
    if (radius <= 0) {
      continue
    }
    boxBlurHorizontal(channel, temp, width, height, radius)
    boxBlurVertical(temp, channel, width, height, radius)
  }
}

/** 对 RGBA 像素做反锐化掩模，返回新数组；alpha 不变。onProgress 在每个通道算完时回报 0–1。 */
export function unsharpMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  settings: SharpenSettings,
  onProgress?: (fraction: number) => void,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(rgba)
  if (isSharpenNoop(settings) || width <= 0 || height <= 0) {
    onProgress?.(1)
    return output
  }
  const pixels = width * height
  const amount = settings.amount / 100
  const threshold = settings.threshold
  const channel = new Uint8ClampedArray(pixels)
  const temp = new Uint8ClampedArray(pixels)

  for (let offset = 0; offset < 3; offset += 1) {
    for (let index = 0; index < pixels; index += 1) {
      channel[index] = rgba[index * 4 + offset]
    }
    gaussianBlurChannel(channel, temp, width, height, settings.radius)
    for (let index = 0; index < pixels; index += 1) {
      const position = index * 4 + offset
      const original = rgba[position]
      const difference = original - channel[index]
      if (difference > threshold || difference < -threshold) {
        output[position] = original + amount * difference
      }
    }
    onProgress?.((offset + 1) / 3)
  }
  return output
}
