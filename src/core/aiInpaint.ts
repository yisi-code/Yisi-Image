/**
 * AI 修瑕两个模型（MI-GAN、LaMa）的输入输出换算（纯函数，不依赖 onnxruntime，便于单元测试）。
 *
 * - MI-GAN（migan_pipeline_v2.onnx）：裁剪、缩放到 512、羽化贴回都在模型图里完成，
 *   输入原尺寸 uint8 图像 [1,3,H,W] 与遮罩 [1,1,H,W]（255 = 保留，0 = 要补），输出同尺寸 uint8 [1,3,H,W]；
 * - LaMa（lama_fp32.onnx）：固定 512 × 512，输入 float32 图像（0–1）与遮罩（1 = 要补），
 *   输出 float32 [1,3,512,512]，取值 0–255。裁剪与缩放由这里做：以洞为中心取一块方形区域，
 *   四周至少留 LAMA_CONTEXT 像素上下文，缩放到 512 计算，结果再缩放回去。
 *
 * 两者的结果都只替换洞内像素，洞外保持原图（边缘羽化由 heal.ts 的补丁透明度负责）。
 */

export const LAMA_SIZE = 512
/** LaMa 裁剪区域在洞外至少保留的上下文（计算分辨率下的像素）。 */
export const LAMA_CONTEXT = 128

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
 * LaMa 的裁剪区域：以洞的外接框为中心的方形，边长取「洞的长边 + 两侧上下文」与 512 中较大的；
 * 超出图像时平移进来，图像本身不够大时取整张图（此时可能不是正方形，缩放时略有拉伸）。没有洞时返回 null。
 */
export function lamaCrop(width: number, height: number, mask: Uint8Array): CropBox | null {
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
  const side = Math.max(LAMA_SIZE, Math.max(maxX - minX + 1, maxY - minY + 1) + LAMA_CONTEXT * 2)
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

export function lamaFeeds(
  width: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  crop: CropBox,
): { image: Float32Array; mask: Float32Array } {
  const plane = LAMA_SIZE * LAMA_SIZE
  const image = new Float32Array(plane * 3)
  const hole = new Float32Array(plane)
  const scaleX = crop.width / LAMA_SIZE
  const scaleY = crop.height / LAMA_SIZE
  for (let y = 0; y < LAMA_SIZE; y += 1) {
    const sy = crop.y + (y + 0.5) * scaleY - 0.5
    // 遮罩按「这个格子覆盖的原像素里有没有洞」取，缩小时细笔画也不会丢。
    const footY0 = crop.y + Math.floor(y * scaleY)
    const footY1 = Math.max(footY0 + 1, crop.y + Math.ceil((y + 1) * scaleY))
    for (let x = 0; x < LAMA_SIZE; x += 1) {
      const sx = crop.x + (x + 0.5) * scaleX - 0.5
      const i = y * LAMA_SIZE + x
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

/** LaMa 输出（512 × 512，平面 RGB，0–255）双线性放回裁剪区域，只替换洞内像素。 */
export function lamaResult(
  output: ArrayLike<number>,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  crop: CropBox,
): Uint8ClampedArray {
  if (crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error('LaMa 裁剪区域超出图像')
  }
  const plane = LAMA_SIZE * LAMA_SIZE
  const result = new Uint8ClampedArray(rgba)
  const scaleX = LAMA_SIZE / crop.width
  const scaleY = LAMA_SIZE / crop.height
  for (let y = crop.y; y < crop.y + crop.height; y += 1) {
    const v = Math.min(LAMA_SIZE - 1, Math.max(0, (y - crop.y + 0.5) * scaleY - 0.5))
    const v0 = Math.floor(v)
    const v1 = Math.min(LAMA_SIZE - 1, v0 + 1)
    const fv = v - v0
    for (let x = crop.x; x < crop.x + crop.width; x += 1) {
      const p = y * width + x
      if (!mask[p]) {
        continue
      }
      const u = Math.min(LAMA_SIZE - 1, Math.max(0, (x - crop.x + 0.5) * scaleX - 0.5))
      const u0 = Math.floor(u)
      const u1 = Math.min(LAMA_SIZE - 1, u0 + 1)
      const fu = u - u0
      for (let c = 0; c < 3; c += 1) {
        const base = c * plane
        const top = output[base + v0 * LAMA_SIZE + u0] * (1 - fu) + output[base + v0 * LAMA_SIZE + u1] * fu
        const bottom = output[base + v1 * LAMA_SIZE + u0] * (1 - fu) + output[base + v1 * LAMA_SIZE + u1] * fu
        result[p * 4 + c] = top * (1 - fv) + bottom * fv
      }
      result[p * 4 + 3] = 255
    }
  }
  return result
}
