/**
 * AI 修瑕模型的输入输出换算（纯函数，不依赖 onnxruntime，便于单元测试）。
 *
 * - MI-GAN（migan_pipeline_v2.onnx）：裁剪、缩放到 512、羽化贴回都在模型图里完成，
 *   输入原尺寸 uint8 图像 [1,3,H,W] 与遮罩 [1,1,H,W]（255 = 保留，0 = 要补），输出同尺寸 uint8 [1,3,H,W]；
 * - LaMa（lama_fp32.onnx）：固定 512 × 512，输入 float32 图像（0–1）与遮罩（1 = 要补），
 *   输出 float32 [1,3,512,512]，取值 0–255。裁剪与缩放由这里做：以洞为中心取一块方形区域，
 *   四周至少留 LAMA_CONTEXT 像素上下文，缩放到 512 计算，结果再缩放回去。
 *
 * - 自定义模型：沿用 LaMa 的「裁剪 → 缩放到方形 → 贴回」，边长取模型的固定输入尺寸（不固定时 512）；
 *   图像与遮罩的类型、遮罩里哪个值表示「要补」、输出取值范围由 Worker 试算得出（CustomInpaintSpec）。
 *
 * 结果都只替换洞内像素，洞外保持原图（边缘羽化由 heal.ts 的补丁透明度负责）。
 */

export const LAMA_SIZE = 512
/** LaMa 裁剪区域在洞外至少保留的上下文（计算分辨率下的像素）；其他边长按比例取 1/4。 */
export const LAMA_CONTEXT = 128
/** 自定义修瑕模型输入尺寸不固定时，按这个边长计算 */
export const CUSTOM_INPAINT_SIZE = 512
/** 输入尺寸不固定的自定义模型，试算时用的边长（小一些，试算快） */
export const PROBE_INPAINT_SIZE = 256

export type InpaintTensorType = 'float32' | 'uint8'
/** 模型输出的取值范围：unit 0–1，byte 0–255，signed -1–1 */
export type InpaintOutputRange = 'unit' | 'byte' | 'signed'

/** 自定义修瑕模型的输入输出约定，由 Worker 第一次使用时试算得出。 */
export interface CustomInpaintSpec {
  imageName: string
  maskName: string
  imageType: InpaintTensorType
  maskType: InpaintTensorType
  /** 送进模型的方形边长 */
  size: number
  /** true：遮罩里大的值（1 / 255）表示要补；false：小的值（0）表示要补 */
  holeHigh: boolean
  outputRange: InpaintOutputRange
}

export interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

export function miganFeeds(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
): { image: Uint8Array; mask: Uint8Array } {
  const size = width * height
  const image = new Uint8Array(size * 3)
  const keep = new Uint8Array(size)
  for (let p = 0; p < size; p += 1) {
    image[p] = rgba[p * 4]
    image[size + p] = rgba[p * 4 + 1]
    image[size * 2 + p] = rgba[p * 4 + 2]
    keep[p] = mask[p] ? 0 : 255
  }
  return { image, mask: keep }
}

/** MI-GAN 输出（平面排列的 RGB）只取洞内像素，贴回原图。 */
export function miganResult(
  output: ArrayLike<number>,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
): Uint8ClampedArray {
  const size = width * height
  const result = new Uint8ClampedArray(rgba)
  for (let p = 0; p < size; p += 1) {
    if (mask[p]) {
      result[p * 4] = output[p]
      result[p * 4 + 1] = output[size + p]
      result[p * 4 + 2] = output[size * 2 + p]
      result[p * 4 + 3] = 255
    }
  }
  return result
}

/**
 * LaMa（及自定义模型）的裁剪区域：以洞的外接框为中心的方形，边长取「洞的长边 + 两侧上下文」与 size 中较大的；
 * 超出图像时平移进来，图像本身不够大时取整张图（此时可能不是正方形，缩放时略有拉伸）。没有洞时返回 null。
 */
export function lamaCrop(
  width: number,
  height: number,
  mask: Uint8Array,
  size: number = LAMA_SIZE,
): CropBox | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }
  if (maxX < 0) {
    return null
  }
  const context = Math.round((size * LAMA_CONTEXT) / LAMA_SIZE)
  const side = Math.max(size, Math.max(maxX - minX + 1, maxY - minY + 1) + context * 2)
  const cropWidth = Math.min(width, side)
  const cropHeight = Math.min(height, side)
  const centerX = (minX + maxX + 1) / 2
  const centerY = (minY + maxY + 1) / 2
  const x = Math.min(width - cropWidth, Math.max(0, Math.round(centerX - cropWidth / 2)))
  const y = Math.min(height - cropHeight, Math.max(0, Math.round(centerY - cropHeight / 2)))
  return { x, y, width: cropWidth, height: cropHeight }
}

/** 在 RGBA 图上双线性取 (sx, sy) 处第 channel 个通道的值，坐标限制在 box 内。 */
function sampleRgba(
  rgba: Uint8ClampedArray,
  width: number,
  box: CropBox,
  sx: number,
  sy: number,
  channel: number,
): number {
  const x = Math.min(box.x + box.width - 1, Math.max(box.x, sx))
  const y = Math.min(box.y + box.height - 1, Math.max(box.y, sy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(box.x + box.width - 1, x0 + 1)
  const y1 = Math.min(box.y + box.height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const top = rgba[(y0 * width + x0) * 4 + channel] * (1 - fx) + rgba[(y0 * width + x1) * 4 + channel] * fx
  const bottom = rgba[(y1 * width + x0) * 4 + channel] * (1 - fx) + rgba[(y1 * width + x1) * 4 + channel] * fx
  return top * (1 - fy) + bottom * fy
}

/** 裁剪区域缩放到 size × size：图像平面 RGB 取值 0–1，遮罩 1 = 要补。 */
export function lamaFeeds(
  width: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  crop: CropBox,
  size: number = LAMA_SIZE,
): { image: Float32Array; mask: Float32Array } {
  const plane = size * size
  const image = new Float32Array(plane * 3)
  const hole = new Float32Array(plane)
  const scaleX = crop.width / size
  const scaleY = crop.height / size
  for (let y = 0; y < size; y += 1) {
    const sy = crop.y + (y + 0.5) * scaleY - 0.5
    // 遮罩按「这个格子覆盖的原像素里有没有洞」取，缩小时细笔画也不会丢。
    const footY0 = crop.y + Math.floor(y * scaleY)
    const footY1 = Math.max(footY0 + 1, crop.y + Math.ceil((y + 1) * scaleY))
    for (let x = 0; x < size; x += 1) {
      const sx = crop.x + (x + 0.5) * scaleX - 0.5
      const i = y * size + x
      for (let c = 0; c < 3; c += 1) {
        image[c * plane + i] = sampleRgba(rgba, width, crop, sx, sy, c) / 255
      }
      const footX0 = crop.x + Math.floor(x * scaleX)
      const footX1 = Math.max(footX0 + 1, crop.x + Math.ceil((x + 1) * scaleX))
      let isHole = 0
      for (let fy = footY0; fy < Math.min(footY1, crop.y + crop.height) && !isHole; fy += 1) {
        for (let fx = footX0; fx < Math.min(footX1, crop.x + crop.width); fx += 1) {
          if (mask[fy * width + fx]) {
            isHole = 1
            break
          }
        }
      }
      hole[i] = isHole
    }
  }
  return { image, mask: hole }
}

/** 模型输出（size × size，平面 RGB，0–255）双线性放回裁剪区域，只替换洞内像素。 */
export function lamaResult(
  output: ArrayLike<number>,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  crop: CropBox,
  size: number = LAMA_SIZE,
): Uint8ClampedArray {
  if (crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error('修瑕裁剪区域超出图像')
  }
  const plane = size * size
  const result = new Uint8ClampedArray(rgba)
  const scaleX = size / crop.width
  const scaleY = size / crop.height
  for (let y = crop.y; y < crop.y + crop.height; y += 1) {
    const v = Math.min(size - 1, Math.max(0, (y - crop.y + 0.5) * scaleY - 0.5))
    const v0 = Math.floor(v)
    const v1 = Math.min(size - 1, v0 + 1)
    const fv = v - v0
    for (let x = crop.x; x < crop.x + crop.width; x += 1) {
      const p = y * width + x
      if (!mask[p]) {
        continue
      }
      const u = Math.min(size - 1, Math.max(0, (x - crop.x + 0.5) * scaleX - 0.5))
      const u0 = Math.floor(u)
      const u1 = Math.min(size - 1, u0 + 1)
      const fu = u - u0
      for (let c = 0; c < 3; c += 1) {
        const base = c * plane
        const top = output[base + v0 * size + u0] * (1 - fu) + output[base + v0 * size + u1] * fu
        const bottom = output[base + v1 * size + u0] * (1 - fu) + output[base + v1 * size + u1] * fu
        result[p * 4 + c] = top * (1 - fv) + bottom * fv
      }
      result[p * 4 + 3] = 255
    }
  }
  return result
}

/** 平面 RGB（0–1）换成模型要的图像张量：uint8 时乘 255。 */
export function encodeInpaintImage(planes: Float32Array, type: InpaintTensorType): Float32Array | Uint8Array {
  if (type === 'float32') {
    return planes
  }
  const bytes = new Uint8Array(planes.length)
  for (let i = 0; i < planes.length; i += 1) {
    bytes[i] = Math.round(Math.min(1, Math.max(0, planes[i])) * 255)
  }
  return bytes
}

/** 遮罩（1 = 要补）换成模型的约定：holeHigh 为 false 时反过来；uint8 时用 0 / 255。 */
export function encodeInpaintMask(
  hole: Float32Array,
  type: InpaintTensorType,
  holeHigh: boolean,
): Float32Array | Uint8Array {
  const out = type === 'uint8' ? new Uint8Array(hole.length) : new Float32Array(hole.length)
  const high = type === 'uint8' ? 255 : 1
  for (let i = 0; i < hole.length; i += 1) {
    const isHole = hole[i] > 0.5
    out[i] = isHole === holeHigh ? high : 0
  }
  return out
}

/** 按试算输出判断取值范围：uint8 就是 0–255；float32 看最大最小值。 */
export function detectOutputRange(data: ArrayLike<number>, type: string): InpaintOutputRange {
  if (type === 'uint8') {
    return 'byte'
  }
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < data.length; i += 1) {
    min = Math.min(min, data[i])
    max = Math.max(max, data[i])
  }
  if (max > 1.5) {
    return 'byte'
  }
  return min < -0.2 ? 'signed' : 'unit'
}

/** 输出换成 0–255，交给 lamaResult 贴回。 */
export function outputToByte(data: ArrayLike<number>, range: InpaintOutputRange): Float32Array {
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i]
    out[i] = range === 'byte' ? value : range === 'unit' ? value * 255 : (value + 1) * 127.5
  }
  return out
}

/**
 * 试算用的图：左黑右白的横向渐变，中间一块洋红（255, 0, 255）是「要补」的洞。
 * 模型真的补了洞，洞里就会变成周围的灰，不再是洋红。
 */
export function inpaintProbeImage(size: number): { image: Float32Array; hole: Float32Array; box: CropBox } {
  const plane = size * size
  const image = new Float32Array(plane * 3)
  const hole = new Float32Array(plane)
  const start = Math.floor(size / 4)
  const box = { x: start, y: start, width: size - start * 2, height: size - start * 2 }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x
      const inside = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
      const gray = x / (size - 1)
      image[i] = inside ? 1 : gray
      image[plane + i] = inside ? 0 : gray
      image[plane * 2 + i] = inside ? 1 : gray
      hole[i] = inside ? 1 : 0
    }
  }
  return { image, hole, box }
}

/** 洞中间（去掉四周 1/8）与洋红的平均差，0–1；越大说明洞被补得越多。 */
export function holeChange(output255: ArrayLike<number>, size: number, box: CropBox): number {
  const plane = size * size
  const insetX = Math.floor(box.width / 8)
  const insetY = Math.floor(box.height / 8)
  let total = 0
  let count = 0
  for (let y = box.y + insetY; y < box.y + box.height - insetY; y += 1) {
    for (let x = box.x + insetX; x < box.x + box.width - insetX; x += 1) {
      const i = y * size + x
      total +=
        Math.abs(255 - output255[i]) + Math.abs(output255[plane + i]) + Math.abs(255 - output255[plane * 2 + i])
      count += 1
    }
  }
  return count > 0 ? total / (count * 765) : 0
}
