import { estimateAiSeconds, getOutputFactor, planAiInput } from './aiUpscale'
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

/** 一个可以跑的 AI 清晰化模型；scale 为 null 表示倍数未知，第一次用时试算 */
export interface AiModelSpec {
  key: string
  label: string
  files: AiModelFiles
  scale: number | null
  multiple: number
}

/** 试算（或登记）得到的模型信息 */
export interface AiModelInfo {
  scale: number
  fixedSize: { width: number; height: number } | null
}

/** 一个 AI 模型能不能用：能用时给出模型，否则说明原因（由 App 按模型状态算出）。 */
export type SharpenAiState = { ready: true; model: AiModelSpec } | { ready: false; reason: string }

/** 清晰化面板里可选的一个 AI 模型 */
export interface AiModelChoice {
  key: string
  label: string
  state: SharpenAiState
}

const probes = new Map<string, Promise<AiModelInfo>>()

/** 取模型的倍数与固定尺寸：内置模型直接返回，自定义模型第一次用时在 Worker 里试算一次并缓存。 */
export function probeAiModel(spec: AiModelSpec): Promise<AiModelInfo> {
  if (spec.scale !== null) {
    return Promise.resolve({ scale: spec.scale, fixedSize: null })
  }
  const key = spec.files.modelUrl
  const cached = probes.get(key)
  if (cached) {
    return cached
  }
  const probe = callAi(() => ({
    payload: {
      kind: 'probe',
      model: spec.key,
      modelUrl: spec.files.modelUrl,
      runtimeUrl: spec.files.runtimeUrl,
      width: 0,
      height: 0,
      rgba: new Uint8ClampedArray(0),
    },
    transfer: [],
  })).then((message) => {
    const info = message.probe as AiModelInfo | undefined
    if (!info || !Number.isInteger(info.scale)) {
      throw new Error('读不出这个模型的放大倍数')
    }
    return info
  })
  probes.set(key, probe)
  // 失败的不缓存，换个模型文件或修好后可以再试。
  probe.catch(() => probes.delete(key))
  return probe
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** 每个模型每秒能处理的输入像素数，用来估算耗时；没测过的按本机单线程实测的 1 万像素 / 秒（偏保守）。 */
const DEFAULT_PIXELS_PER_SECOND = 10_000
const speeds = new Map<string, number>()

/** 估算这张图用这个模型、这个等级做 AI 清晰化要多少秒。 */
export function estimateAiSharpenSeconds(
  width: number,
  height: number,
  level: AiSharpenLevel,
  modelKey: string,
): number {
  return estimateAiSeconds(planAiInput(width, height, level), speeds.get(modelKey) ?? DEFAULT_PIXELS_PER_SECOND)
}

/**
 * AI 清晰化：（增强时先缩小）交给模型放大，Worker 里按块平均缩到所需倍数；
 * 结果画布是原图的 resolution 倍，图片在画布上的大小不变，导出放大时才用得上多出来的细节。
 * 模型只输出 RGB，原图有透明区域时按原图的透明度恢复。
 */
export async function aiSharpenImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  level: AiSharpenLevel,
  spec: AiModelSpec,
  resolution: number,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement> {
  const info = await probeAiModel(spec)
  const plan = planAiInput(width, height, level)
  const outputFactor = getOutputFactor(resolution, plan.scale, info.scale)
  if (outputFactor === null) {
    throw new Error(`这个模型（×${info.scale}）做不出所选的 ${resolution} 倍结果`)
  }
  const input = createCanvas(plan.width, plan.height)
  const inputContext = createContext(input)
  inputContext.imageSmoothingQuality = 'high'
  inputContext.drawImage(source, 0, 0, plan.width, plan.height)
  const rgba = inputContext.getImageData(0, 0, plan.width, plan.height).data
  input.width = 0
  let inferenceStart = 0

  const message = await callAi(() => {
    const pixels = new Uint8ClampedArray(rgba)
    return {
      payload: {
        kind: 'upscale',
        model: spec.key,
        modelUrl: spec.files.modelUrl,
        runtimeUrl: spec.files.runtimeUrl,
        width: plan.width,
        height: plan.height,
        modelScale: info.scale,
        multiple: spec.multiple,
        fixedSize: info.fixedSize,
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
      speeds.set(spec.key, (plan.width * plan.height) / seconds)
    }
  }
  const outWidth = Number(message.width)
  const outHeight = Number(message.height)
  if (!(message.rgba instanceof Uint8ClampedArray) || !outWidth || !outHeight) {
    throw new Error('AI 清晰化没有返回结果')
  }
  const upscaled = createCanvas(outWidth, outHeight)
  createContext(upscaled).putImageData(new ImageData(message.rgba, outWidth, outHeight), 0, 0)

  const resultWidth = Math.round(width * resolution)
  const resultHeight = Math.round(height * resolution)
  const result = createCanvas(resultWidth, resultHeight)
  const context = createContext(result)
  context.imageSmoothingQuality = 'high'
  context.drawImage(upscaled, 0, 0, resultWidth, resultHeight)
  upscaled.width = 0

  // 模型不处理透明度：原图有透明像素时，把原图的 alpha（放大到结果尺寸）拷回结果。
  const original = createCanvas(resultWidth, resultHeight)
  const originalContext = createContext(original)
  originalContext.drawImage(source, 0, 0, resultWidth, resultHeight)
  const originalData = originalContext.getImageData(0, 0, resultWidth, resultHeight).data
  original.width = 0
  let hasAlpha = false
  for (let index = 3; index < originalData.length; index += 4) {
    if (originalData[index] < 255) {
      hasAlpha = true
      break
    }
  }
  if (hasAlpha) {
    const resultData = context.getImageData(0, 0, resultWidth, resultHeight)
    for (let index = 3; index < originalData.length; index += 4) {
      resultData.data[index] = originalData[index]
    }
    context.putImageData(resultData, 0, 0)
  }
  return result
}
