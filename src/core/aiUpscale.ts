/**
 * AI 清晰化（Real-ESRGAN General x4v3）的输入输出换算，纯函数，不依赖 onnxruntime，便于单元测试。
 *
 * 做法：把图交给模型放大 4 倍，再缩回原尺寸。「保真」不缩小直接送进模型，文字和细节最稳；
 * 「增强」先缩到一半，模型重建得更多、快约 4 倍，但小字会变形。
 * 实测：先缩到 1/4 再放大时，十几像素高的文字只剩两三像素，模型只能画出一团团色块，所以不提供。
 * 送进模型的尺寸不设暗中缩小的上限（缩小会毁掉文字），大图改为先给出预计耗时，处理中可以停止。
 * 大图分块推理（每块四周多带一圈重叠），只取每块中间那部分写回，避免接缝。
 */

/** Real-ESRGAN 的放大倍数；其他模型的倍数由各自登记或首次使用时试算得出 */
export const UPSCALE_FACTOR = 4

/** 结果画布的倍数选项：1 为原尺寸，2、4 保留放大后的细节（导出时把尺寸调到 200% / 400% 才用得上） */
export const OUTPUT_RESOLUTIONS = [1, 2, 4] as const

/** 结果画布最多这么多像素；超过的倍数不提供，免得一张图吃掉几百 MB 内存 */
export const MAX_RESULT_PIXELS = 40_000_000

export type AiSharpenLevel = 'fidelity' | 'enhance'

export interface AiSharpenLevelOption {
  value: AiSharpenLevel
  label: string
  title: string
  /** 送进模型前缩小到原图的多少 */
  inputScale: number
}

export const AI_SHARPEN_LEVELS: readonly AiSharpenLevelOption[] = [
  {
    value: 'fidelity',
    label: '保真',
    title: '不缩小直接处理，文字和细节最稳，适合截图、文档；最慢',
    inputScale: 1,
  },
  {
    value: 'enhance',
    label: '增强',
    title: '先缩到一半再放大，重建得更多、快约 4 倍，适合模糊照片；小字会变形',
    inputScale: 0.5,
  },
]

export const DEFAULT_AI_SHARPEN_LEVEL: AiSharpenLevel = 'fidelity'

export interface AiInputPlan {
  width: number
  height: number
  /** 送进模型前的缩小比例 */
  scale: number
}

/** 按等级算出送进模型的尺寸。 */
export function planAiInput(width: number, height: number, level: AiSharpenLevel): AiInputPlan {
  const scale = AI_SHARPEN_LEVELS.find((option) => option.value === level)?.inputScale ?? 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

/** 按每秒能处理的输入像素数估算耗时（秒），至少 1 秒。 */
export function estimateAiSeconds(plan: Pick<AiInputPlan, 'width' | 'height'>, pixelsPerSecond: number): number {
  return Math.max(1, Math.round((plan.width * plan.height) / Math.max(1, pixelsPerSecond)))
}

/** 把秒数说成「约 40 秒」「约 3 分钟」。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `约 ${seconds} 秒`
  }
  const minutes = Math.round(seconds / 60)
  return `约 ${minutes} 分钟`
}

/**
 * 一种结果倍数在某个模型、某个等级下能不能做：
 * 模型输出是送进去那张的 modelScale 倍，结果要原图的 resolution 倍，
 * 中间要按块平均缩小，所以 resolution / inputScale 必须是 modelScale 的约数；结果太大也不提供。
 */
export function getOutputFactor(resolution: number, inputScale: number, modelScale: number): number | null {
  const factor = resolution / inputScale
  if (!Number.isInteger(factor) || factor < 1 || factor > modelScale || modelScale % factor !== 0) {
    return null
  }
  return factor
}

export function allowedResolutions(
  width: number,
  height: number,
  level: AiSharpenLevel,
  modelScale: number,
): number[] {
  const inputScale = AI_SHARPEN_LEVELS.find((option) => option.value === level)?.inputScale ?? 1
  return OUTPUT_RESOLUTIONS.filter(
    (resolution) =>
      getOutputFactor(resolution, inputScale, modelScale) !== null &&
      width * height * resolution * resolution <= MAX_RESULT_PIXELS,
  )
}

/** 默认结果倍数：能保留 2 倍细节就用 2 倍，否则原尺寸。 */
export function defaultResolution(allowed: readonly number[]): number {
  return allowed.includes(2) ? 2 : (allowed[0] ?? 1)
}

export interface AiTile {
  /** 送进模型的那块（含重叠）在输入图里的位置 */
  x: number
  y: number
  width: number
  height: number
  /** 实际送进模型的尺寸：补边到模型要求的倍数或固定尺寸，补的部分沿用图像边缘像素 */
  inputWidth: number
  inputHeight: number
  /** 这块真正要写回的中间部分（不含重叠），在输入图里的位置 */
  coreX: number
  coreY: number
  coreWidth: number
  coreHeight: number
}

export interface TileOptions {
  tileSize?: number
  overlap?: number
  /** 送进模型的宽高要补到它的整数倍（窗口注意力类模型常要求 8 或 16） */
  multiple?: number
  /** 模型只接受固定尺寸时的宽高；每块都补到这个尺寸 */
  fixed?: { width: number; height: number } | null
}

function roundUp(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple
}

/**
 * 把输入图切成块，每块四周再带 overlap 像素（贴边处不带）；各块的中间部分正好铺满整张图。
 * 模型要求固定尺寸时，块的中间部分取「固定尺寸 − 两倍重叠」，送进模型前补到固定尺寸。
 */
export function planTiles(width: number, height: number, options: TileOptions = {}): AiTile[] {
  const fixed = options.fixed ?? null
  // 固定尺寸很小（如 64×64）时重叠太多会白算大半，重叠最多取边长的 1/8。
  const overlap = fixed
    ? Math.min(options.overlap ?? 16, Math.floor(Math.min(fixed.width, fixed.height) / 8))
    : (options.overlap ?? 16)
  const multiple = Math.max(1, options.multiple ?? 1)
  const coreWidthLimit = fixed ? Math.max(8, fixed.width - overlap * 2) : (options.tileSize ?? 192)
  const coreHeightLimit = fixed ? Math.max(8, fixed.height - overlap * 2) : (options.tileSize ?? 192)
  const tiles: AiTile[] = []
  for (let coreY = 0; coreY < height; coreY += coreHeightLimit) {
    const coreHeight = Math.min(coreHeightLimit, height - coreY)
    for (let coreX = 0; coreX < width; coreX += coreWidthLimit) {
      const coreWidth = Math.min(coreWidthLimit, width - coreX)
      const x = Math.max(0, coreX - overlap)
      const y = Math.max(0, coreY - overlap)
      const right = Math.min(width, coreX + coreWidth + overlap)
      const bottom = Math.min(height, coreY + coreHeight + overlap)
      const tileWidth = right - x
      const tileHeight = bottom - y
      tiles.push({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        inputWidth: fixed ? Math.max(fixed.width, tileWidth) : roundUp(tileWidth, multiple),
        inputHeight: fixed ? Math.max(fixed.height, tileHeight) : roundUp(tileHeight, multiple),
        coreX,
        coreY,
        coreWidth,
        coreHeight,
      })
    }
  }
  return tiles
}

/** 取出一块 RGBA，转成模型要的 float32 NCHW、RGB 0–1；超出块的补边部分沿用块边缘的像素。 */
export function tileToTensor(rgba: Uint8ClampedArray, imageWidth: number, tile: AiTile): Float32Array {
  const plane = tile.inputWidth * tile.inputHeight
  const tensor = new Float32Array(plane * 3)
  for (let row = 0; row < tile.inputHeight; row += 1) {
    const sourceRow = tile.y + Math.min(row, tile.height - 1)
    for (let column = 0; column < tile.inputWidth; column += 1) {
      const source = (sourceRow * imageWidth + tile.x + Math.min(column, tile.width - 1)) * 4
      const target = row * tile.inputWidth + column
      tensor[target] = rgba[source] / 255
      tensor[plane + target] = rgba[source + 1] / 255
      tensor[plane * 2 + target] = rgba[source + 2] / 255
    }
  }
  return tensor
}

/**
 * 把一块的模型输出（float32 NCHW，尺寸为块的 factor 倍）中间部分写进结果 RGBA。
 * 结果只要 outputFactor 倍（≤ factor，且 factor 能被它整除）：每 (factor / outputFactor)² 个输出像素取平均，
 * 这样「放大 4 倍再缩回原尺寸」不用先攒一张 16 倍面积的大图。
 * 数值按 0–1 截断后换成 0–255，alpha 先写 255（透明度由调用方按原图恢复）。
 */
export function writeTileResult(
  target: Uint8ClampedArray,
  targetWidth: number,
  output: Float32Array,
  tile: AiTile,
  factor = UPSCALE_FACTOR,
  outputFactor = factor,
): void {
  const block = factor / outputFactor
  const outWidth = tile.inputWidth * factor
  const plane = outWidth * tile.inputHeight * factor
  const startX = (tile.coreX - tile.x) * factor
  const startY = (tile.coreY - tile.y) * factor
  const width = tile.coreWidth * outputFactor
  const height = tile.coreHeight * outputFactor
  const scale = 255 / (block * block)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let red = 0
      let green = 0
      let blue = 0
      for (let dy = 0; dy < block; dy += 1) {
        const line = (startY + row * block + dy) * outWidth + startX + column * block
        for (let dx = 0; dx < block; dx += 1) {
          const source = line + dx
          red += Math.min(1, Math.max(0, output[source]))
          green += Math.min(1, Math.max(0, output[plane + source]))
          blue += Math.min(1, Math.max(0, output[plane * 2 + source]))
        }
      }
      const destination =
        ((tile.coreY * outputFactor + row) * targetWidth + tile.coreX * outputFactor + column) * 4
      target[destination] = Math.round(red * scale)
      target[destination + 1] = Math.round(green * scale)
      target[destination + 2] = Math.round(blue * scale)
      target[destination + 3] = 255
    }
  }
}
