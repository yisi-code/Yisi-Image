import { callAi } from './aiWorkerClient'
import { combineMatte, isOpaqueMatte, samInputSize } from './matte'
import type { CutoutMode, MatteSpec, SegmentPoint } from './matte'

/**
 * 去除背景与点选抠图的入口：取画面像素、交给与修瑕清晰化共用的 AI Worker，再把结果做成遮罩画布。
 * 遮罩是原图尺寸、alpha 通道为保留程度的画布，挂在图片上（image.matte），预览与导出按它合成。
 */

/** 一个去背景模型能不能用（由 App 按模型下载状态算出）；spec 为 null 是自定义模型，第一次用时试算。 */
export type MatteModelChoice =
  | { ready: true; key: string; label: string; modelUrl: string; runtimeUrl: string; spec: MatteSpec | null }
  | { ready: false; key: string; label: string; reason: string }

/** 一个抠图模型（图像编码器 + 掩码解码器）能不能用。 */
export type SegmentModelChoice =
  | { ready: true; key: string; label: string; encoderUrl: string; decoderUrl: string; runtimeUrl: string }
  | { ready: false; key: string; label: string; reason: string }

type ReadyMatte = Extract<MatteModelChoice, { ready: true }>
type ReadySegment = Extract<SegmentModelChoice, { ready: true }>

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D')
  }
  return context
}

/** 把画面画成 width × height（可拉伸）后取出 RGBA。 */
function pixelsOf(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = createCanvas(width, height)
  const context = context2d(canvas)
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  canvas.width = 0
  return data
}

/** 0–255 透明度 → 白色、按透明度显示的画布（遮罩只看 alpha）。 */
export function alphaToCanvas(alpha: ArrayLike<number>, width: number, height: number): HTMLCanvasElement {
  const canvas = createCanvas(width, height)
  const image = new ImageData(width, height)
  for (let index = 0; index < width * height; index += 1) {
    image.data[index * 4] = 255
    image.data[index * 4 + 1] = 255
    image.data[index * 4 + 2] = 255
    image.data[index * 4 + 3] = alpha[index]
  }
  context2d(canvas).putImageData(image, 0, 0)
  return canvas
}

/** 把遮罩（任意尺寸）平滑缩放到 width × height 后取出 alpha。 */
function alphaAt(mask: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const data = pixelsOf(mask, width, height)
  const alpha = new Uint8ClampedArray(width * height)
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = data[index * 4 + 3]
  }
  return alpha
}

const matteProbes = new Map<string, Promise<MatteSpec>>()

/** 自定义去背景模型：第一次用时在 Worker 里试出输入尺寸与归一化（按模型地址缓存，失败的不缓存）。 */
function matteSpecOf(choice: ReadyMatte): Promise<MatteSpec> {
  if (choice.spec) {
    return Promise.resolve(choice.spec)
  }
  const cached = matteProbes.get(choice.modelUrl)
  if (cached) {
    return cached
  }
  const probe = callAi(() => ({
    payload: {
      kind: 'matte-probe',
      model: choice.key,
      modelUrl: choice.modelUrl,
      runtimeUrl: choice.runtimeUrl,
      width: 0,
      height: 0,
      rgba: new Uint8ClampedArray(0),
    },
    transfer: [],
  })).then((message) => {
    const spec = message.matteSpec as MatteSpec | undefined
    if (!spec || !Number.isInteger(spec.size)) {
      throw new Error('读不出这个模型的输入要求')
    }
    return spec
  })
  matteProbes.set(choice.modelUrl, probe)
  probe.catch(() => matteProbes.delete(choice.modelUrl))
  return probe
}

/**
 * 去除背景：整张画面拉伸到模型边长送进去，得到前景透明度，再平滑放大回原图尺寸，
 * 与原有遮罩取交集（先抠过一部分再去背景时不会把抠掉的找回来）。整张都保留时返回 null。
 */
export async function removeBackground(
  source: CanvasImageSource,
  width: number,
  height: number,
  current: HTMLCanvasElement | null,
  choice: ReadyMatte,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement | null> {
  const spec = await matteSpecOf(choice)
  const rgba = pixelsOf(source, spec.size, spec.size)
  const message = await callAi(() => {
    const pixels = new Uint8ClampedArray(rgba)
    return {
      payload: {
        kind: 'matte',
        model: choice.key,
        modelUrl: choice.modelUrl,
        runtimeUrl: choice.runtimeUrl,
        width: spec.size,
        height: spec.size,
        matteSpec: spec,
        rgba: pixels,
      },
      transfer: [pixels.buffer],
    }
  }, onProgress)
  const outWidth = Number(message.width)
  const outHeight = Number(message.height)
  if (!(message.alpha instanceof Uint8ClampedArray) || !outWidth || !outHeight) {
    throw new Error('去除背景没有返回结果')
  }
  const small = alphaToCanvas(message.alpha, outWidth, outHeight)
  const result = applySelection(current, small, 'keep', width, height)
  small.width = 0
  return result
}

/** 抠图编码用的尺寸：长边 1024。点的坐标按它换算。 */
export interface SegmentInput {
  imageKey: string
  width: number
  height: number
  scale: number
}

/** 分析画面（每张图一次，几秒）：长边缩到 1024 送进编码器，结果留在 Worker 里。 */
export async function encodeForSegment(
  imageKey: string,
  source: CanvasImageSource,
  width: number,
  height: number,
  choice: ReadySegment,
  onProgress?: (fraction: number) => void,
): Promise<SegmentInput> {
  const size = samInputSize(width, height)
  const rgba = pixelsOf(source, size.width, size.height)
  await callAi(() => {
    const pixels = new Uint8ClampedArray(rgba)
    return {
      payload: {
        kind: 'segment-encode',
        model: choice.key,
        modelUrl: choice.encoderUrl,
        decoderUrl: choice.decoderUrl,
        runtimeUrl: choice.runtimeUrl,
        imageKey,
        width: size.width,
        height: size.height,
        rgba: pixels,
      },
      transfer: [pixels.buffer],
    }
  }, onProgress)
  return { imageKey, ...size }
}

/** 按提示点（原图坐标）解码，返回从小到大的几档选区（编码尺寸的 0–255 透明度）。 */
export async function decodeSegment(
  input: SegmentInput,
  points: readonly SegmentPoint[],
  choice: ReadySegment,
): Promise<Uint8ClampedArray[]> {
  const message = await callAi(() => ({
    payload: {
      kind: 'segment-decode',
      model: choice.key,
      modelUrl: choice.encoderUrl,
      decoderUrl: choice.decoderUrl,
      runtimeUrl: choice.runtimeUrl,
      imageKey: input.imageKey,
      width: input.width,
      height: input.height,
      points: points.map((point) => ({ ...point, x: point.x * input.scale, y: point.y * input.scale })),
      rgba: new Uint8ClampedArray(0),
    },
    transfer: [],
  }))
  const masks = message.masks
  if (!Array.isArray(masks) || masks.length === 0 || !masks.every((mask) => mask instanceof Uint8ClampedArray)) {
    throw new Error('抠图没有返回选区')
  }
  return masks as Uint8ClampedArray[]
}

/**
 * 把选区（任意尺寸的遮罩画布）合到当前遮罩上，得到原图尺寸的新遮罩：
 * keep 只留选区（与原遮罩取交集），remove 从原遮罩里扣掉选区。结果整张不透明时返回 null（等于没抠）。
 */
export function applySelection(
  current: HTMLCanvasElement | null,
  selection: CanvasImageSource,
  mode: CutoutMode,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const picked = alphaAt(selection, width, height)
  const base = current ? alphaAt(current, width, height) : null
  const combined = combineMatte(base, picked, mode)
  return isOpaqueMatte(combined) ? null : alphaToCanvas(combined, width, height)
}

/** 页面强调色（CSS 变量 --accent，#rrggbb）→ RGB；读不到时用默认的青绿色。 */
export function accentRgb(): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  return match
    ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
    : [15, 118, 110]
}

/** 预览里的选区高亮：选区内盖一层半透明的 color。 */
export function highlightCanvas(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  color: readonly [number, number, number],
): HTMLCanvasElement {
  const canvas = createCanvas(width, height)
  const image = new ImageData(width, height)
  for (let index = 0; index < width * height; index += 1) {
    image.data[index * 4] = color[0]
    image.data[index * 4 + 1] = color[1]
    image.data[index * 4 + 2] = color[2]
    image.data[index * 4 + 3] = Math.round(alpha[index] * 0.5)
  }
  context2d(canvas).putImageData(image, 0, 0)
  return canvas
}

const sourceTokens = new WeakMap<object, number>()
let tokenSequence = 0

/** 抠图编码结果的编号：同一张图、同一份画面（清晰化结果换了就是另一份）才能复用。 */
export function segmentImageKey(imageId: string, source: CanvasImageSource): string {
  let token = sourceTokens.get(source)
  if (token === undefined) {
    tokenSequence += 1
    token = tokenSequence
    sourceTokens.set(source, token)
  }
  return `${imageId}:${token}`
}
