/**
 * 去除背景与点选抠图的纯计算：输入张量的换算、模型输出转成透明度、三档掩码排序、遮罩合并与试算图。
 * 画布与模型调用不在这里（见 matteEngine.ts 与 ai.worker.ts），便于单元测试。
 */

/** 去背景模型的输入归一化：value = (rgb / 255 - mean) / std */
export interface MatteNormalization {
  mean: readonly [number, number, number]
  std: readonly [number, number, number]
}

/** ImageNet 均值方差（U²-Net 系列） */
export const IMAGENET_NORMALIZATION: MatteNormalization = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
}
/** 只减均值、不除方差（IS-Net / DIS） */
export const MEAN_ONLY_NORMALIZATION: MatteNormalization = {
  mean: [0.485, 0.456, 0.406],
  std: [1, 1, 1],
}
/** 直接 0–1 */
export const UNIT_NORMALIZATION: MatteNormalization = { mean: [0, 0, 0], std: [1, 1, 1] }

/** 自定义去背景模型试算时依次尝试的归一化 */
export const PROBE_NORMALIZATIONS: readonly MatteNormalization[] = [
  IMAGENET_NORMALIZATION,
  MEAN_ONLY_NORMALIZATION,
  UNIT_NORMALIZATION,
]

/** 一个去背景模型怎么喂：输入边长（送进模型前把整张图拉伸成 size × size）与归一化。 */
export interface MatteSpec {
  size: number
  normalization: MatteNormalization
}

/** 不固定输入尺寸的自定义去背景模型按这个边长算 */
export const CUSTOM_MATTE_SIZE = 1024
/** 试算用的边长（固定尺寸的模型按它自己的） */
export const PROBE_MATTE_SIZE = 320
/** 试算时前景与背景的平均差至少要这么大，才算模型「分出了前景」 */
export const MATTE_PROBE_THRESHOLD = 0.3

/** RGBA（宽 × 高）→ 归一化后的 CHW float32。 */
export function rgbaToChw(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  normalization: MatteNormalization,
): Float32Array {
  const plane = width * height
  const output = new Float32Array(plane * 3)
  for (let index = 0; index < plane; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgba[index * 4 + channel] / 255
      output[channel * plane + index] =
        (value - normalization.mean[channel]) / normalization.std[channel]
    }
  }
  return output
}

/**
 * 模型输出（一个通道的前景概率或 logits）→ 0–255 透明度。
 * 超出 0–1 时按 logits 取 sigmoid；再按最小最大值拉伸到 0–1（与 rembg 一致），
 * 但整张都差不多（没有明显前景）时不拉伸，免得把噪声放大成前景。
 */
export function outputToAlpha(data: ArrayLike<number>, count = data.length): Uint8ClampedArray {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let index = 0; index < count; index += 1) {
    const value = data[index]
    if (value < min) min = value
    if (value > max) max = value
  }
  const isLogits = min < -0.001 || max > 1.001
  const map = (value: number) => (isLogits ? 1 / (1 + Math.exp(-value)) : value)
  const low = map(min)
  const high = map(max)
  const stretch = high - low > 0.05
  const output = new Uint8ClampedArray(count)
  for (let index = 0; index < count; index += 1) {
    const value = map(data[index])
    output[index] = Math.round((stretch ? (value - low) / (high - low) : value) * 255)
  }
  return output
}

/** 前景（inside 为 1 的像素）与背景透明度的平均差，0–1；用来判断试算有没有分出前景。 */
export function foregroundContrast(alpha: ArrayLike<number>, inside: ArrayLike<number>): number {
  let sumIn = 0
  let sumOut = 0
  let countIn = 0
  let countOut = 0
  for (let index = 0; index < inside.length; index += 1) {
    if (inside[index]) {
      sumIn += alpha[index]
      countIn += 1
    } else {
      sumOut += alpha[index]
      countOut += 1
    }
  }
  if (countIn === 0 || countOut === 0) {
    return 0
  }
  return (sumIn / countIn - sumOut / countOut) / 255
}

/**
 * 试算图：浅灰渐变底上一个居中的红色圆（明显的前景物体）。
 * 返回 RGBA 与「哪些像素在圆里」，供自定义去背景模型试出归一化方式。
 */
export function matteProbeImage(size: number): { rgba: Uint8ClampedArray; inside: Uint8Array } {
  const rgba = new Uint8ClampedArray(size * size * 4)
  const inside = new Uint8Array(size * size)
  const radius = size * 0.28
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const isInside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < radius * radius
      inside[index] = isInside ? 1 : 0
      const rgb = isInside ? [216, 38, 31] : [158 + Math.round((x / size) * 26), 163, 168]
      rgba[index * 4] = rgb[0]
      rgba[index * 4 + 1] = rgb[1]
      rgba[index * 4 + 2] = rgb[2]
      rgba[index * 4 + 3] = 255
    }
  }
  return { rgba, inside }
}

/** 抠图解码时 Worker 里已没有这张图的编码结果（Worker 重建、换了模型）；页面收到后重新编码。 */
export const SEGMENT_NOT_ENCODED = '抠图编码已失效，需要重新分析画面'

/** SAM 编码器的长边 */
export const SAM_INPUT_SIDE = 1024
/** 标准 SAM 导出（[1,3,1024,1024] 输入）在模型外做的像素归一化（0–255 下的均值方差） */
const SAM_PIXEL_MEAN = [123.675, 116.28, 103.53]
const SAM_PIXEL_STD = [58.395, 57.12, 57.375]

/** 送进 SAM 编码器的尺寸：长边缩到 1024，等比。 */
export function samInputSize(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = SAM_INPUT_SIDE / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

/** 编码器输入两种约定：hwc 是 [高, 宽, 3]、RGB 0–255（模型自己归一化、补边）；chw 是标准 SAM 的 [1, 3, 1024, 1024]。 */
export type SamEncoderLayout = 'hwc' | 'chw'

export function samEncoderInput(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  layout: SamEncoderLayout,
): Float32Array {
  if (layout === 'hwc') {
    const output = new Float32Array(width * height * 3)
    for (let index = 0; index < width * height; index += 1) {
      output[index * 3] = rgba[index * 4]
      output[index * 3 + 1] = rgba[index * 4 + 1]
      output[index * 3 + 2] = rgba[index * 4 + 2]
    }
    return output
  }
  // 标准导出：归一化后放在 1024 × 1024 的左上角，其余补 0。
  const side = SAM_INPUT_SIDE
  const plane = side * side
  const output = new Float32Array(plane * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4
      const target = y * side + x
      for (let channel = 0; channel < 3; channel += 1) {
        output[channel * plane + target] = (rgba[source + channel] - SAM_PIXEL_MEAN[channel]) / SAM_PIXEL_STD[channel]
      }
    }
  }
  return output
}

/** 抠图的一个提示点（模型输入尺寸里的坐标）；positive 为要保留的物体，否则是要排除的地方。 */
export interface SegmentPoint {
  x: number
  y: number
  positive: boolean
}

/** SAM 解码器的点输入：没有框时末尾补一个 (0, 0, -1) 的空点（官方导出的约定）。 */
export function samPointTensors(points: readonly SegmentPoint[]): { coords: Float32Array; labels: Float32Array } {
  const coords = new Float32Array((points.length + 1) * 2)
  const labels = new Float32Array(points.length + 1)
  points.forEach((point, index) => {
    coords[index * 2] = point.x
    coords[index * 2 + 1] = point.y
    labels[index] = point.positive ? 1 : 0
  })
  labels[points.length] = -1
  return { coords, labels }
}

/**
 * 解码器给的几张掩码里取哪几张当「细部 / 部位 / 整体」：多掩码导出有 4 张时第 0 张是单掩码输出，
 * 用后 3 张；只有 1–3 张时全用。按面积从小到大排，面积几乎相同的只留一张。
 */
export function pickMaskLevels(areas: readonly number[]): number[] {
  const candidates = areas.length >= 4 ? [1, 2, 3] : areas.map((_, index) => index)
  const sorted = [...candidates].sort((a, b) => areas[a] - areas[b])
  const result: number[] = []
  for (const index of sorted) {
    const previous = result[result.length - 1]
    if (previous !== undefined && areas[index] - areas[previous] <= Math.max(16, areas[previous] * 0.02)) {
      continue
    }
    if (areas[index] > 0) {
      result.push(index)
    }
  }
  return result.length > 0 ? result : [sorted[sorted.length - 1] ?? 0]
}

/**
 * SAM 的 logits → 0–255 透明度：以 0 为界（与 SAM 官方的二值化一致），只在 ±LOGIT_SOFT_BAND 内线性过渡，
 * 边缘留一点柔化。不用 sigmoid：大片只略小于 0 的区域会变成 20%–40% 的半透明残影（实测排除掉的玻璃留下灰影）。
 */
const LOGIT_SOFT_BAND = 0.5

export function logitsToAlpha(data: ArrayLike<number>, offset: number, count: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(count)
  for (let index = 0; index < count; index += 1) {
    const value = (data[offset + index] + LOGIT_SOFT_BAND) / (2 * LOGIT_SOFT_BAND)
    output[index] = Math.round(Math.min(1, Math.max(0, value)) * 255)
  }
  return output
}

export function countAbove(alpha: ArrayLike<number>, threshold = 127): number {
  let count = 0
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] > threshold) {
      count += 1
    }
  }
  return count
}

/** 选区怎么用：保留选中的（其余变透明），或去掉选中的 */
export type CutoutMode = 'keep' | 'remove'

/**
 * 把选区合到已有的遮罩上（都是 0–255 透明度，同尺寸）：保留时取交集，去掉时从已有遮罩里扣掉。
 * current 为 null 表示原来整张不透明。
 */
export function combineMatte(
  current: ArrayLike<number> | null,
  selection: ArrayLike<number>,
  mode: CutoutMode,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(selection.length)
  for (let index = 0; index < selection.length; index += 1) {
    const base = current ? current[index] : 255
    const picked = mode === 'keep' ? selection[index] : 255 - selection[index]
    output[index] = Math.round((base * picked) / 255)
  }
  return output
}

/** 遮罩是否基本全不透明（等于没抠），这时不必保存遮罩。 */
export function isOpaqueMatte(alpha: ArrayLike<number>): boolean {
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] < 250) {
      return false
    }
  }
  return true
}
