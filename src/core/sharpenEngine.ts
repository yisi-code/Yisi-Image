import { UPSCALE_FACTOR, estimateAiSeconds, planAiInput } from './aiUpscale'
import type { AiSharpenLevel } from './aiUpscale'
import { callAi } from './aiWorkerClient'
import type { SharpenSettings } from './sharpen'
import { WorkerClient } from './workerClient'

/**
 * 清晰化入口：把原图画到画布取出像素，交给 Worker 算，算完画回一张同尺寸的新画布。
 * 经典锐化走 sharpen.worker；AI 清晰化走与修瑕共用的 AI Worker。
 * 结果画布挂在图片上（image.enhance），预览、导出、修瑕取样都从它取画面。
 */

const sharpenWorker = new WorkerClient(
  () => new Worker(new URL('./sharpen.worker.ts', import.meta.url), { type: 'module' }),
  '清晰化计算失败',
)

function createContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D')
  }
  return context
}

export async function sharpenImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  settings: SharpenSettings,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = createContext(canvas)
  context.drawImage(source, 0, 0, width, height)
  const input = context.getImageData(0, 0, width, height).data
  const message = await sharpenWorker.call(
    { width, height, rgba: input, settings: { ...settings } },
    [input.buffer],
    onProgress,
  )
  if (!(message.rgba instanceof Uint8ClampedArray)) {
    throw new Error('清晰化没有返回结果')
  }
  context.putImageData(new ImageData(message.rgba, width, height), 0, 0)
  return canvas
}

/** 启动器提供的模型与运行库地址 */
export interface AiModelFiles {
  modelUrl: string
  runtimeUrl: string
}

/** AI 清晰化能不能用：模型下好了给出文件地址，否则说明原因（由 App 按模型状态算出）。 */
export type SharpenAiState = { ready: true; files: AiModelFiles } | { ready: false; reason: string }

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * 每秒能处理的输入像素数，用来估算耗时。初值取本机单线程实测（约 1 万像素 / 秒，偏保守），
 * 每跑完一次按实际耗时更新。
 */
let pixelsPerSecond = 10_000

/** 估算这张图用这个等级做 AI 清晰化要多少秒。 */
export function estimateAiSharpenSeconds(width: number, height: number, level: AiSharpenLevel): number {
  return estimateAiSeconds(planAiInput(width, height, level), pixelsPerSecond)
}

/**
 * AI 清晰化：（增强时先缩小）交给 Real-ESRGAN 放大 4 倍，Worker 里按块平均缩回原尺寸。
 * 模型只输出 RGB，原图有透明区域时按原图的透明度恢复。
 */
export async function aiSharpenImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  level: AiSharpenLevel,
  files: AiModelFiles,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement> {
  const plan = planAiInput(width, height, level)
  const input = createCanvas(plan.width, plan.height)
  const inputContext = createContext(input)
  inputContext.imageSmoothingQuality = 'high'
  inputContext.drawImage(source, 0, 0, plan.width, plan.height)
  const rgba = inputContext.getImageData(0, 0, plan.width, plan.height).data
  input.width = 0
  // 结果直接要原尺寸：保真 1 倍、增强 2 倍；Worker 不用攒 4 倍大的图。
  const outputFactor = Math.min(UPSCALE_FACTOR, Math.max(1, Math.round(1 / plan.scale)))
  let inferenceStart = 0

  const message = await callAi(() => {
    const pixels = new Uint8ClampedArray(rgba)
    return {
      payload: {
        kind: 'upscale',
        model: 'realesrgan',
        modelUrl: files.modelUrl,
        runtimeUrl: files.runtimeUrl,
        width: plan.width,
        height: plan.height,
        outputFactor,
        rgba: pixels,
      },
      transfer: [pixels.buffer],
    }
  }, (fraction) => {
    // 0.25 之后才是推理本身（之前是读模型、建会话），只拿这段算速度。
    if (fraction >= 0.25 && inferenceStart === 0) {
      inferenceStart = performance.now()
    } else if (fraction < 0.25) {
      inferenceStart = 0
    }
    onProgress?.(fraction)
  })
  if (inferenceStart > 0) {
    const seconds = (performance.now() - inferenceStart) / 1000
    if (seconds > 0.5) {
      pixelsPerSecond = (plan.width * plan.height) / seconds
    }
  }
  const outWidth = Number(message.width)
  const outHeight = Number(message.height)
  if (!(message.rgba instanceof Uint8ClampedArray) || !outWidth || !outHeight) {
    throw new Error('AI 清晰化没有返回结果')
  }
  const upscaled = createCanvas(outWidth, outHeight)
  createContext(upscaled).putImageData(new ImageData(message.rgba, outWidth, outHeight), 0, 0)

  const result = createCanvas(width, height)
  const context = createContext(result)
  context.imageSmoothingQuality = 'high'
  context.drawImage(upscaled, 0, 0, width, height)
  upscaled.width = 0

  // 模型不处理透明度：原图有透明像素时，把原图的 alpha 拷回结果。
  const original = createCanvas(width, height)
  const originalContext = createContext(original)
  originalContext.drawImage(source, 0, 0, width, height)
  const originalData = originalContext.getImageData(0, 0, width, height).data
  original.width = 0
  let hasAlpha = false
  for (let index = 3; index < originalData.length; index += 4) {
    if (originalData[index] < 255) {
      hasAlpha = true
      break
    }
  }
  if (hasAlpha) {
    const resultData = context.getImageData(0, 0, width, height)
    for (let index = 3; index < originalData.length; index += 4) {
      resultData.data[index] = originalData[index]
    }
    context.putImageData(resultData, 0, 0)
  }
  return result
}
