import { traceStroke } from './annotations'
import { getImageSource } from './image'
import type { HealPatch, StitchImage, StrokeAnnotation } from './types'

/**
 * 修瑕任务的准备与收尾（依赖 Canvas，只在页面里用）：
 * - prepareHealJob：按涂抹范围取一块区域（外扩一圈作为「借纹理」的来源），画出原图 + 之前的修瑕补丁，生成遮罩；
 * - createHealPatch：把算法结果做成只有涂抹区域不透明、边缘羽化的补丁。
 * 区域太大时按比例缩小计算，补丁绘制时再放大回原尺寸。
 */

/** 单次计算的最大像素数；超过就缩小，避免一次修瑕卡十几秒。 */
const MAX_WORK_PIXELS = 640_000
const MIN_MARGIN = 32
const MAX_MARGIN = 360
/** 遮罩比涂抹范围向外多扩的像素（计算分辨率下），盖住物体边缘的残留色。 */
const MASK_GROW = 3
/** 补丁边缘羽化半径（计算分辨率下的像素）。 */
const FEATHER = 2

export interface HealJob {
  /** 区域在图片本地坐标中的位置与尺寸 */
  region: { x: number; y: number; width: number; height: number }
  /** 计算分辨率 / 原分辨率 */
  scale: number
  width: number
  height: number
  rgba: Uint8ClampedArray
  /** 1 = 待填补 */
  mask: Uint8Array
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D')
  }
  return context
}

export function prepareHealJob(image: StitchImage, stroke: StrokeAnnotation): HealJob | null {
  if (stroke.points.length === 0) {
    return null
  }
  const radius = stroke.width / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x - radius)
    minY = Math.min(minY, point.y - radius)
    maxX = Math.max(maxX, point.x + radius)
    maxY = Math.max(maxY, point.y + radius)
  }
  minX = Math.max(0, minX)
  minY = Math.max(0, minY)
  maxX = Math.min(image.width, maxX)
  maxY = Math.min(image.height, maxY)
  if (maxX - minX < 1 || maxY - minY < 1) {
    return null
  }

  const margin = Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, Math.round(Math.max(maxX - minX, maxY - minY) * 1.2)))
  const x = Math.max(0, Math.floor(minX - margin))
  const y = Math.max(0, Math.floor(minY - margin))
  const right = Math.min(image.width, Math.ceil(maxX + margin))
  const bottom = Math.min(image.height, Math.ceil(maxY + margin))
  const region = { x, y, width: right - x, height: bottom - y }
  const scale = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (region.width * region.height)))
  const width = Math.max(1, Math.round(region.width * scale))
  const height = Math.max(1, Math.round(region.height * scale))

  const source = document.createElement('canvas')
  source.width = width
  source.height = height
  const sourceContext = context2d(source)
  sourceContext.imageSmoothingQuality = 'high'
  sourceContext.setTransform(scale, 0, 0, scale, -x * scale, -y * scale)
  // 取样用这张图当前的画面：清晰化过就从清晰化结果里补。
  const picture = image.kind === 'blank' ? null : getImageSource(image)
  if (!picture) {
    sourceContext.fillStyle = image.backgroundColor ?? '#ffffff'
    sourceContext.fillRect(0, 0, image.width, image.height)
  } else {
    sourceContext.drawImage(picture, 0, 0, image.width, image.height)
  }
  // 之前的修瑕结果也是「画面」的一部分；画笔和文字不算，修瑕时会被补成背景。
  for (const annotation of image.annotations) {
    if (annotation.type === 'heal' && annotation.patch && annotation.id !== stroke.id) {
      const patch = annotation.patch
      sourceContext.drawImage(patch.canvas, patch.x, patch.y, patch.width, patch.height)
    }
  }
  const rgba = sourceContext.getImageData(0, 0, width, height).data

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = width
  maskCanvas.height = height
  const maskContext = context2d(maskCanvas)
  maskContext.setTransform(scale, 0, 0, scale, -x * scale, -y * scale)
  traceStroke(maskContext, stroke.points, stroke.width + (MASK_GROW * 2) / scale, '#ffffff')
  const maskData = maskContext.getImageData(0, 0, width, height).data
  const mask = new Uint8Array(width * height)
  for (let p = 0; p < mask.length; p += 1) {
    mask[p] = maskData[p * 4 + 3] > 16 ? 1 : 0
  }

  return { region, scale, width, height, rgba, mask }
}

/** 遮罩做一次盒式模糊作为透明度：洞内不透明，边缘向外渐隐，接缝不生硬。 */
function featherMask(mask: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(width * height)
  const size = (FEATHER * 2 + 1) ** 2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let dy = -FEATHER; dy <= FEATHER; dy += 1) {
        const ny = Math.min(height - 1, Math.max(0, y + dy))
        for (let dx = -FEATHER; dx <= FEATHER; dx += 1) {
          const nx = Math.min(width - 1, Math.max(0, x + dx))
          sum += mask[ny * width + nx]
        }
      }
      const p = y * width + x
      // 洞内至少半透明以上，保证原物体不会透出来。
      alpha[p] = mask[p] ? Math.max(200, Math.round((sum / size) * 255)) : Math.round((sum / size) * 255)
    }
  }
  return alpha
}

export function createHealPatch(job: HealJob, result: Uint8ClampedArray): HealPatch {
  const canvas = document.createElement('canvas')
  canvas.width = job.width
  canvas.height = job.height
  const context = context2d(canvas)
  const alpha = featherMask(job.mask, job.width, job.height)
  const pixels = new ImageData(job.width, job.height)
  for (let p = 0; p < alpha.length; p += 1) {
    pixels.data[p * 4] = result[p * 4]
    pixels.data[p * 4 + 1] = result[p * 4 + 1]
    pixels.data[p * 4 + 2] = result[p * 4 + 2]
    pixels.data[p * 4 + 3] = alpha[p]
  }
  context.putImageData(pixels, 0, 0)
  return { ...job.region, canvas }
}
