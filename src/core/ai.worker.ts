import * as ort from 'onnxruntime-web/wasm'
import ortGlueUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import {
  CUSTOM_INPAINT_SIZE,
  LAMA_SIZE,
  PROBE_INPAINT_SIZE,
  detectOutputRange,
  encodeInpaintImage,
  encodeInpaintMask,
  holeChange,
  inpaintProbeImage,
  lamaCrop,
  lamaFeeds,
  lamaResult,
  miganFeeds,
  miganResult,
  outputToByte,
} from './aiInpaint'
import type { CustomInpaintSpec, InpaintTensorType } from './aiInpaint'
import { UPSCALE_FACTOR, planTiles, tileToTensor, writeTileResult } from './aiUpscale'
import {
  CUSTOM_MATTE_SIZE,
  MATTE_PROBE_THRESHOLD,
  PROBE_MATTE_SIZE,
  PROBE_NORMALIZATIONS,
  SEGMENT_NOT_ENCODED,
  foregroundContrast,
  logitsToAlpha,
  matteProbeImage,
  outputToAlpha,
  pickMaskLevels,
  rgbaToChw,
  samEncoderInput,
  samPointTensors,
} from './matte'
import type { MatteNormalization, MatteSpec, SamEncoderLayout, SegmentPoint } from './matte'

/**
 * 在 Worker 里用 onnxruntime-web（wasm）跑 AI 模型（修瑕、清晰化、去除背景、点选抠图），页面不卡。
 * wasm 运行库和模型都由 EXE 启动器下载、在 /models/ 下提供；胶水脚本随页面打包。
 * 已加载的会话按模型地址缓存，连续修瑕只加载一次；换模型时释放这次用不到的，避免同时占几份内存
 * （抠图要同时留着编码器和解码器）；空闲 IDLE_RELEASE_MS 后全部释放（LaMa 加载后约占 600 MB），
 * 下次再重新加载。
 */

const IDLE_RELEASE_MS = 3 * 60 * 1000

interface AiRequest {
  id: number
  /**
   * inpaint：修瑕（默认）；upscale：清晰化；probe：读一个陌生清晰化模型的输入要求并试算放大倍数；
   * matte：去除背景；matte-probe：试出自定义去背景模型的输入尺寸与归一化；
   * segment-encode / segment-decode：点选抠图的编码（每张图一次）与按提示点解码。
   */
  kind?: 'inpaint' | 'upscale' | 'probe' | 'matte' | 'matte-probe' | 'segment-encode' | 'segment-decode'
  /** 修瑕时是 migan / lama 或自定义模型编号（custom-…）；清晰化时是内置或自定义模型的编号 */
  model: string
  modelUrl: string
  runtimeUrl: string
  width: number
  height: number
  rgba: Uint8ClampedArray
  /** 修瑕的涂抹范围；清晰化不需要 */
  mask?: Uint8Array
  /** 是否允许多线程；主线程发现多线程卡住后会传 false 重试 */
  threads?: boolean
  /** 清晰化结果要输入的几倍大；必须是 modelScale 的约数，多出来的按块取平均 */
  outputFactor?: number
  /** 模型的放大倍数，默认 4（Real-ESRGAN） */
  modelScale?: number
  /** 送进模型的宽高补到它的整数倍 */
  multiple?: number
  /** 模型只接受的固定输入尺寸 */
  fixedSize?: { width: number; height: number } | null
  /** 去除背景：送进模型的尺寸与归一化（rgba 已按 size × size 拉伸好） */
  matteSpec?: MatteSpec
  /** 抠图：掩码解码器的地址（modelUrl 是图像编码器） */
  decoderUrl?: string
  /** 抠图：这张图（及其当时的画面）的编号，编码结果按它缓存 */
  imageKey?: string
  /** 抠图解码：提示点（编码器输入尺寸里的坐标） */
  points?: SegmentPoint[]
}

interface AiResult {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

/** probe 的结果：放大倍数与固定输入尺寸（没有固定尺寸时为 null） */
interface ProbeResult {
  scale: number
  fixedSize: { width: number; height: number } | null
}

/** 去除背景的结果：模型输出尺寸（通常与输入同为方形）的 0–255 前景透明度 */
interface MatteResult {
  alpha: Uint8ClampedArray
  width: number
  height: number
}

/** 抠图解码的结果：几档掩码（从小到大），每档 width × height 的 0–255 透明度 */
interface SegmentResult {
  masks: Uint8ClampedArray[]
  width: number
  height: number
}

type WorkerResult = AiResult | ProbeResult | MatteResult | SegmentResult | { encoded: true } | { matteSpec: MatteSpec }

interface InputMetadata {
  type?: string
  shape?: ReadonlyArray<number | string>
}

const PROBE_SIZE = 32
/** 试算时洞里与洋红的平均差超过它，才算模型「补了洞」 */
const HOLE_FILLED_THRESHOLD = 0.2

/** 自定义修瑕模型试算出的约定，按模型地址缓存（会话释放后也不用重新试算）。 */
const inpaintSpecs = new Map<string, CustomInpaintSpec>()

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AiRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  crossOriginIsolated?: boolean
  location: Location
}

/** 已加载的会话，按模型地址 */
const loaded = new Map<string, ort.InferenceSession>()
/** 抠图编码结果：只留最近一张图的 */
let segmentCache: { imageKey: string; encoderKey: string; embeddings: ort.Tensor } | null = null
/** 自定义去背景模型试出的输入约定，按模型地址缓存 */
const matteSpecs = new Map<string, MatteSpec>()
let idleTimer: ReturnType<typeof setTimeout> | undefined
let running = 0

async function releaseAll(): Promise<void> {
  segmentCache = null
  const sessions = [...loaded.values()]
  loaded.clear()
  await Promise.all(sessions.map((session) => session.release()))
}

function scheduleRelease(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (running === 0 && loaded.size > 0) {
      void releaseAll()
    }
  }, IDLE_RELEASE_MS)
}

function absolute(url: string): string {
  return new URL(url, scope.location.href).href
}

/** 释放这次请求用不到的会话（抠图的编码器、解码器要一起留着）。 */
async function keepOnly(keys: readonly string[]): Promise<void> {
  for (const [key, session] of [...loaded]) {
    if (!keys.includes(key)) {
      loaded.delete(key)
      if (segmentCache?.encoderKey === key) {
        segmentCache = null
      }
      await session.release()
    }
  }
}

async function getSession(
  request: AiRequest,
  report: (fraction: number) => void,
  modelUrl = request.modelUrl,
): Promise<ort.InferenceSession> {
  const key = absolute(modelUrl)
  const existing = loaded.get(key)
  if (existing) {
    return existing
  }
  ort.env.wasm.wasmPaths = { mjs: absolute(ortGlueUrl), wasm: absolute(request.runtimeUrl) }
  // 页面跨源隔离（EXE 启动器加了 COOP / COEP 头）时才能多线程；否则单线程照样能算，只是慢一些。
  ort.env.wasm.numThreads =
    scope.crossOriginIsolated && request.threads !== false
      ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
      : 1
  report(0.05)
  const response = await fetch(key)
  if (!response.ok) {
    throw new Error(`读取模型文件失败（${response.status}），请到设置里重新下载`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  report(0.2)
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  loaded.set(key, session)
  return session
}

/**
 * 读模型的输入要求并用一小块灰图试算一次，得出放大倍数。只支持「一个 float32 [1,3,h,w] 输入、
 * 一个同类型输出、宽高按同一整数倍放大」的模型，不符合时给出能看懂的原因。
 */
async function probe(session: ort.InferenceSession): Promise<ProbeResult> {
  if (session.inputNames.length !== 1) {
    throw new Error(`这个模型有 ${session.inputNames.length} 个输入，只支持一个图像输入的超分模型`)
  }
  const metadata = (session as unknown as { inputMetadata?: InputMetadata[] }).inputMetadata?.[0]
  if (metadata?.type && metadata.type !== 'float32') {
    throw new Error(`模型输入是 ${metadata.type}，目前只支持 float32`)
  }
  const shape = metadata?.shape
  if (shape && shape.length !== 4) {
    throw new Error('模型输入不是 [1, 3, 高, 宽] 的四维图像')
  }
  if (shape && typeof shape[1] === 'number' && shape[1] !== 3) {
    throw new Error(`模型输入是 ${shape[1]} 通道，只支持 3 通道 RGB`)
  }
  const fixedHeight = typeof shape?.[2] === 'number' && shape[2] > 0 ? shape[2] : null
  const fixedWidth = typeof shape?.[3] === 'number' && shape[3] > 0 ? shape[3] : null
  const testWidth = fixedWidth ?? PROBE_SIZE
  const testHeight = fixedHeight ?? PROBE_SIZE
  const input = new Float32Array(3 * testWidth * testHeight).fill(0.5)
  const result = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, testHeight, testWidth]),
  })
  const output = result[session.outputNames[0]]
  if (output.type !== 'float32' || output.dims.length !== 4 || output.dims[1] !== 3) {
    throw new Error('模型输出不是 float32 的 [1, 3, 高, 宽] 图像')
  }
  const scaleX = Number(output.dims[3]) / testWidth
  const scaleY = Number(output.dims[2]) / testHeight
  if (scaleX !== scaleY || !Number.isInteger(scaleX) || scaleX < 1 || scaleX > 8) {
    throw new Error('模型输出不是输入的 1–8 整数倍，不是超分 / 清晰化模型')
  }
  return {
    scale: scaleX,
    fixedSize: fixedWidth && fixedHeight ? { width: fixedWidth, height: fixedHeight } : null,
  }
}

function tensorTypeOf(type: string | undefined, label: string): InpaintTensorType {
  if (type === undefined || type === 'float32') {
    return 'float32'
  }
  if (type === 'uint8') {
    return 'uint8'
  }
  throw new Error(`模型的${label}输入是 ${type}，只支持 float32 或 uint8`)
}

function inpaintFeeds(
  spec: CustomInpaintSpec,
  size: number,
  image: Float32Array,
  hole: Float32Array,
): Record<string, ort.Tensor> {
  return {
    [spec.imageName]: new ort.Tensor(spec.imageType, encodeInpaintImage(image, spec.imageType), [1, 3, size, size]),
    [spec.maskName]: new ort.Tensor(spec.maskType, encodeInpaintMask(hole, spec.maskType, spec.holeHigh), [
      1,
      1,
      size,
      size,
    ]),
  }
}

/**
 * 读自定义修瑕模型的输入要求，并用一张「渐变底 + 洋红洞」的图试算，判断遮罩里哪个值表示要补、
 * 输出取值范围。要求：两个输入（3 通道图像、1 通道遮罩，float32 或 uint8），输出与输入同尺寸的 [1,3,高,宽]。
 */
async function inpaintSpecOf(session: ort.InferenceSession, key: string): Promise<CustomInpaintSpec> {
  const cached = inpaintSpecs.get(key)
  if (cached) {
    return cached
  }
  if (session.inputNames.length !== 2) {
    throw new Error(`这个模型有 ${session.inputNames.length} 个输入，修瑕模型需要图像和遮罩两个输入`)
  }
  const metadata = (session as unknown as { inputMetadata?: InputMetadata[] }).inputMetadata ?? []
  const inputs = session.inputNames.map((name, index) => {
    const shape = metadata[index]?.shape
    return {
      name,
      type: metadata[index]?.type,
      shape,
      channels: typeof shape?.[1] === 'number' ? shape[1] : null,
    }
  })
  const mask =
    inputs.find((input) => input.channels === 1) ?? inputs.find((input) => /mask/i.test(input.name))
  const image = inputs.find((input) => input !== mask)
  if (!mask || !image || image.channels === 1) {
    throw new Error('认不出哪个输入是遮罩：需要一个 3 通道图像输入和一个 1 通道遮罩输入')
  }
  if (image.channels !== null && image.channels !== 3) {
    throw new Error(`图像输入是 ${image.channels} 通道，只支持 3 通道 RGB`)
  }
  const fixedHeight = typeof image.shape?.[2] === 'number' && image.shape[2] > 0 ? image.shape[2] : null
  const fixedWidth = typeof image.shape?.[3] === 'number' && image.shape[3] > 0 ? image.shape[3] : null
  if (fixedWidth !== null && fixedHeight !== null && fixedWidth !== fixedHeight) {
    throw new Error(`模型只收 ${fixedWidth} × ${fixedHeight} 的输入，目前只支持方形或不固定尺寸`)
  }
  const fixed = fixedWidth ?? fixedHeight
  const draft: CustomInpaintSpec = {
    imageName: image.name,
    maskName: mask.name,
    imageType: tensorTypeOf(image.type, '图像'),
    maskType: tensorTypeOf(mask.type, '遮罩'),
    size: fixed ?? CUSTOM_INPAINT_SIZE,
    holeHigh: true,
    outputRange: 'unit',
  }

  const testSize = fixed ?? PROBE_INPAINT_SIZE
  const test = inpaintProbeImage(testSize)
  const attempt = async (holeHigh: boolean): Promise<{ change: number; range: CustomInpaintSpec['outputRange'] }> => {
    const result = await session.run(inpaintFeeds({ ...draft, holeHigh }, testSize, test.image, test.hole))
    const output = result[session.outputNames[0]]
    const dims = output.dims.map(Number)
    if (dims.length !== 4 || dims[1] !== 3 || dims[2] !== testSize || dims[3] !== testSize) {
      throw new Error(`模型输出是 [${dims.join(', ')}]，需要与输入同尺寸的 [1, 3, 高, 宽] 图像`)
    }
    const data = output.data as ArrayLike<number>
    const range = detectOutputRange(data, output.type)
    return { change: holeChange(outputToByte(data, range), testSize, test.box), range }
  }

  // 先按「1 / 255 表示要补」（LaMa 的约定）试；没补上再按「0 表示要补」（MI-GAN 的约定）试。
  let found: { holeHigh: boolean; range: CustomInpaintSpec['outputRange'] } | null = null
  for (const holeHigh of [true, false]) {
    const { change, range } = await attempt(holeHigh)
    if (change > HOLE_FILLED_THRESHOLD) {
      found = { holeHigh, range }
      break
    }
  }
  if (!found) {
    throw new Error('试算时模型没有补上遮罩区域，可能不是修瑕（inpainting）模型')
  }
  const spec = { ...draft, holeHigh: found.holeHigh, outputRange: found.range }
  inpaintSpecs.set(key, spec)
  return spec
}

/** 自定义修瑕模型：与 LaMa 一样裁剪、缩放到模型边长计算，结果贴回洞内。 */
async function customInpaint(
  session: ort.InferenceSession,
  request: AiRequest,
  mask: Uint8Array,
): Promise<AiResult> {
  const { width, height, rgba } = request
  const spec = await inpaintSpecOf(session, absolute(request.modelUrl))
  const crop = lamaCrop(width, height, mask, spec.size)
  if (!crop) {
    return { rgba: new Uint8ClampedArray(rgba), width, height }
  }
  const feeds = lamaFeeds(width, rgba, mask, crop, spec.size)
  const result = await session.run(inpaintFeeds(spec, spec.size, feeds.image, feeds.mask))
  const output = result[session.outputNames[0]].data as ArrayLike<number>
  return {
    rgba: lamaResult(outputToByte(output, spec.outputRange), width, height, rgba, mask, crop, spec.size),
    width,
    height,
  }
}

/** 清晰化：分块送进模型，每块只取中间部分，缩到 outputFactor 倍后拼回结果。 */
async function upscale(
  session: ort.InferenceSession,
  request: AiRequest,
  report: (fraction: number) => void,
): Promise<AiResult> {
  const { width, height, rgba } = request
  const modelScale = request.modelScale ?? UPSCALE_FACTOR
  const outputFactor =
    request.outputFactor && modelScale % request.outputFactor === 0 ? request.outputFactor : modelScale
  const outWidth = width * outputFactor
  const outHeight = height * outputFactor
  const output = new Uint8ClampedArray(outWidth * outHeight * 4)
  const tiles = planTiles(width, height, {
    multiple: request.multiple ?? 1,
    fixed: request.fixedSize ?? null,
  })
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]
    const result = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', tileToTensor(rgba, width, tile), [
        1,
        3,
        tile.inputHeight,
        tile.inputWidth,
      ]),
    })
    const data = result[session.outputNames[0]].data
    if (!(data instanceof Float32Array)) {
      throw new Error('模型输出不是 float32')
    }
    writeTileResult(output, outWidth, data, tile, modelScale, outputFactor)
    report(0.25 + (0.75 * (index + 1)) / tiles.length)
  }
  return { rgba: output, width: outWidth, height: outHeight }
}

/** 模型第一个输入里固定的高、宽（四维 [1, 3, 高, 宽]）；不固定的维度为 null。 */
function fixedInputSize(session: ort.InferenceSession): { width: number | null; height: number | null } {
  const shape = (session as unknown as { inputMetadata?: InputMetadata[] }).inputMetadata?.[0]?.shape
  return {
    height: typeof shape?.[2] === 'number' && shape[2] > 0 ? shape[2] : null,
    width: typeof shape?.[3] === 'number' && shape[3] > 0 ? shape[3] : null,
  }
}

/** 第一个单通道的输出：[1, 1, 高, 宽]、[1, 高, 宽] 或 [高, 宽]。 */
function alphaOutput(
  session: ort.InferenceSession,
  result: ort.InferenceSession.OnnxValueMapType,
): { data: Float32Array; width: number; height: number } {
  for (const name of session.outputNames) {
    const output = result[name] as ort.Tensor
    const dims = output.dims.map(Number)
    const single =
      (dims.length === 4 && dims[0] === 1 && dims[1] === 1) ||
      (dims.length === 3 && dims[0] === 1) ||
      dims.length === 2
    if (single && output.data instanceof Float32Array) {
      return { data: output.data, width: dims[dims.length - 1], height: dims[dims.length - 2] }
    }
  }
  throw new Error('模型没有单通道的 float32 输出（[1, 1, 高, 宽]），不是去背景模型')
}

async function runMatteModel(
  session: ort.InferenceSession,
  rgba: Uint8ClampedArray,
  size: number,
  normalization: MatteNormalization,
): Promise<MatteResult> {
  const input = rgbaToChw(rgba, size, size, normalization)
  const result = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
  })
  const output = alphaOutput(session, result)
  return {
    alpha: outputToAlpha(output.data, output.width * output.height),
    width: output.width,
    height: output.height,
  }
}

/**
 * 读自定义去背景模型的输入要求，并用「灰底 + 红圆」的试算图依次试三种归一化，取前景分得最开的那种。
 * 要求：一个 float32 [1, 3, 高, 宽] 输入（固定尺寸时只支持方形），输出里有一个单通道的前景图。
 */
async function matteSpecOf(session: ort.InferenceSession, key: string): Promise<MatteSpec> {
  const cached = matteSpecs.get(key)
  if (cached) {
    return cached
  }
  if (session.inputNames.length !== 1) {
    throw new Error(`这个模型有 ${session.inputNames.length} 个输入，去背景模型只要一个图像输入`)
  }
  const metadata = (session as unknown as { inputMetadata?: InputMetadata[] }).inputMetadata?.[0]
  if (metadata?.type && metadata.type !== 'float32') {
    throw new Error(`模型输入是 ${metadata.type}，目前只支持 float32`)
  }
  if (metadata?.shape && metadata.shape.length !== 4) {
    throw new Error('模型输入不是 [1, 3, 高, 宽] 的四维图像')
  }
  if (typeof metadata?.shape?.[1] === 'number' && metadata.shape[1] !== 3) {
    throw new Error(`模型输入是 ${metadata.shape[1]} 通道，只支持 3 通道 RGB`)
  }
  const fixed = fixedInputSize(session)
  if (fixed.width !== null && fixed.height !== null && fixed.width !== fixed.height) {
    throw new Error(`模型只收 ${fixed.width} × ${fixed.height} 的输入，目前只支持方形或不固定尺寸`)
  }
  const fixedSide = fixed.width ?? fixed.height
  const testSize = fixedSide ?? PROBE_MATTE_SIZE
  const test = matteProbeImage(testSize)
  let best: { normalization: MatteNormalization; contrast: number } | null = null
  for (const normalization of PROBE_NORMALIZATIONS) {
    const output = await runMatteModel(session, test.rgba, testSize, normalization)
    if (output.width !== testSize || output.height !== testSize) {
      throw new Error(`模型输出是 ${output.width} × ${output.height}，需要与输入同尺寸`)
    }
    const contrast = foregroundContrast(output.alpha, test.inside)
    if (!best || contrast > best.contrast) {
      best = { normalization, contrast }
    }
  }
  if (!best || best.contrast < MATTE_PROBE_THRESHOLD) {
    throw new Error('试算时模型没有把前景物体和背景分开，可能不是去背景（显著性分割）模型')
  }
  const spec: MatteSpec = { size: fixedSide ?? CUSTOM_MATTE_SIZE, normalization: best.normalization }
  matteSpecs.set(key, spec)
  return spec
}

/** 去除背景：rgba 已按 spec.size 拉伸成方形；返回模型输出尺寸的前景透明度。 */
async function removeBackground(
  session: ort.InferenceSession,
  request: AiRequest,
  report: (fraction: number) => void,
): Promise<MatteResult> {
  const spec = request.matteSpec ?? (await matteSpecOf(session, absolute(request.modelUrl)))
  if (request.width !== spec.size || request.height !== spec.size) {
    throw new Error('去背景的输入尺寸与模型不一致')
  }
  report(0.3)
  const result = await runMatteModel(session, request.rgba, spec.size, spec.normalization)
  report(1)
  return result
}

/** 标准 SAM 掩码解码器的输入 */
const SAM_DECODER_INPUTS = [
  'image_embeddings',
  'point_coords',
  'point_labels',
  'mask_input',
  'has_mask_input',
  'orig_im_size',
] as const

/** 编码器输入是 [高, 宽, 3]（模型自己归一化、补边）还是标准 SAM 的 [1, 3, 1024, 1024]。 */
function encoderLayoutOf(session: ort.InferenceSession): SamEncoderLayout {
  if (session.inputNames.length !== 1) {
    throw new Error(`图像编码器有 ${session.inputNames.length} 个输入，SAM 编码器只要一个图像输入`)
  }
  const shape = (session as unknown as { inputMetadata?: InputMetadata[] }).inputMetadata?.[0]?.shape
  if (!shape || shape.length === 3) {
    return 'hwc'
  }
  if (shape.length === 4) {
    return 'chw'
  }
  throw new Error('图像编码器的输入既不是 [高, 宽, 3] 也不是 [1, 3, 1024, 1024]')
}

/**
 * 点选抠图。encode：把长边缩到 1024 的画面送进编码器，结果按 imageKey 缓存（每张图只算一次，约几秒）；
 * decode：按提示点跑解码器（不到 1 秒），返回几档掩码。编码结果不在了（Worker 重建、换了模型）时
 * decode 报 SEGMENT_NOT_ENCODED，页面重新编码后再解码。
 */
async function segment(request: AiRequest, report: (fraction: number) => void): Promise<SegmentResult | { encoded: true }> {
  if (!request.decoderUrl || !request.imageKey) {
    throw new Error('抠图请求缺少解码器或图片编号')
  }
  const encoderKey = absolute(request.modelUrl)
  const decoderKey = absolute(request.decoderUrl)
  await keepOnly([encoderKey, decoderKey])

  if (request.kind === 'segment-encode') {
    const encoder = await getSession(request, report)
    const decoder = await getSession(request, () => undefined, request.decoderUrl)
    const missing = SAM_DECODER_INPUTS.filter((name) => !decoder.inputNames.includes(name))
    if (missing.length > 0) {
      throw new Error(`掩码解码器不是标准 SAM 接口：缺少 ${missing.join('、')} 输入`)
    }
    const layout = encoderLayoutOf(encoder)
    report(0.3)
    const { width, height } = request
    const input = samEncoderInput(request.rgba, width, height, layout)
    const dims = layout === 'hwc' ? [height, width, 3] : [1, 3, 1024, 1024]
    const result = await encoder.run({ [encoder.inputNames[0]]: new ort.Tensor('float32', input, dims) })
    const embeddings = result[encoder.outputNames[0]] as ort.Tensor
    if (embeddings.dims.length !== 4) {
      throw new Error('图像编码器的输出不是四维特征图，不是 SAM 编码器')
    }
    segmentCache = { imageKey: request.imageKey, encoderKey, embeddings }
    report(1)
    return { encoded: true }
  }

  const cache = segmentCache
  if (!cache || cache.imageKey !== request.imageKey || cache.encoderKey !== encoderKey) {
    throw new Error(SEGMENT_NOT_ENCODED)
  }
  const decoder = await getSession(request, report, request.decoderUrl)
  const points = request.points ?? []
  const { coords, labels } = samPointTensors(points)
  const count = points.length + 1
  const { width, height } = request
  const result = await decoder.run({
    image_embeddings: cache.embeddings,
    point_coords: new ort.Tensor('float32', coords, [1, count, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, count]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([height, width]), [2]),
  })
  const masks = (result.masks ?? result[decoder.outputNames[0]]) as ort.Tensor
  const dims = masks.dims.map(Number)
  if (dims.length !== 4 || dims[2] !== height || dims[3] !== width || !(masks.data instanceof Float32Array)) {
    throw new Error(`掩码解码器输出是 [${dims.join(', ')}]，需要 [1, 张数, ${height}, ${width}]`)
  }
  const plane = width * height
  const data = masks.data
  const areas = Array.from({ length: dims[1] }, (_, index) => {
    let area = 0
    for (let offset = index * plane; offset < (index + 1) * plane; offset += 1) {
      if (data[offset] > 0) {
        area += 1
      }
    }
    return area
  })
  const levels = pickMaskLevels(areas)
  return {
    masks: levels.map((index) => logitsToAlpha(data, index * plane, plane)),
    width,
    height,
  }
}

async function run(request: AiRequest, report: (fraction: number) => void): Promise<WorkerResult> {
  if (request.kind === 'segment-encode' || request.kind === 'segment-decode') {
    return segment(request, report)
  }
  await keepOnly([absolute(request.modelUrl)])
  const session = await getSession(request, report)
  if (request.kind === 'matte-probe') {
    return { matteSpec: await matteSpecOf(session, absolute(request.modelUrl)) }
  }
  if (request.kind === 'matte') {
    return removeBackground(session, request, report)
  }
  if (request.kind === 'probe') {
    return probe(session)
  }
  if (request.kind === 'upscale') {
    report(0.25)
    return upscale(session, request, report)
  }
  report(0.35)
  const { width, height, rgba } = request
  const mask = request.mask ?? new Uint8Array(width * height)
  if (request.model === 'migan') {
    const feeds = miganFeeds(width, height, rgba, mask)
    const output = await session.run({
      image: new ort.Tensor('uint8', feeds.image, [1, 3, height, width]),
      mask: new ort.Tensor('uint8', feeds.mask, [1, 1, height, width]),
    })
    return {
      rgba: miganResult(output[session.outputNames[0]].data as Uint8Array, width, height, rgba, mask),
      width,
      height,
    }
  }

  if (request.model !== 'lama') {
    return customInpaint(session, request, mask)
  }

  const crop = lamaCrop(width, height, mask)
  if (!crop) {
    return { rgba: new Uint8ClampedArray(rgba), width, height }
  }
  const feeds = lamaFeeds(width, rgba, mask, crop)
  const output = await session.run({
    image: new ort.Tensor('float32', feeds.image, [1, 3, LAMA_SIZE, LAMA_SIZE]),
    mask: new ort.Tensor('float32', feeds.mask, [1, 1, LAMA_SIZE, LAMA_SIZE]),
  })
  return {
    rgba: lamaResult(output[session.outputNames[0]].data as Float32Array, width, height, rgba, mask, crop),
    width,
    height,
  }
}

/**
 * 请求排队一个接一个跑：修瑕和清晰化用不同模型，换模型会释放正在用的会话，
 * 并发跑会让前一个请求用到已释放的会话。
 */
let queue: Promise<unknown> = Promise.resolve()

scope.onmessage = (event) => {
  const request = event.data
  const report = (fraction: number): void => scope.postMessage({ id: request.id, type: 'progress', fraction })
  running += 1
  clearTimeout(idleTimer)
  const job = queue.then(() => run(request, report))
  queue = job.catch(() => undefined)
  job
    .finally(() => {
      running -= 1
      scheduleRelease()
    })
    .then((result) => {
      if ('rgba' in result) {
        scope.postMessage(
          { id: request.id, type: 'done', rgba: result.rgba, width: result.width, height: result.height },
          [result.rgba.buffer],
        )
      } else if ('alpha' in result) {
        scope.postMessage(
          { id: request.id, type: 'done', alpha: result.alpha, width: result.width, height: result.height },
          [result.alpha.buffer],
        )
      } else if ('masks' in result) {
        scope.postMessage(
          { id: request.id, type: 'done', masks: result.masks, width: result.width, height: result.height },
          result.masks.map((mask) => mask.buffer),
        )
      } else if ('encoded' in result || 'matteSpec' in result) {
        scope.postMessage({ id: request.id, type: 'done', ...result })
      } else {
        scope.postMessage({ id: request.id, type: 'done', probe: result })
      }
    })
    .catch((error: unknown) =>
      scope.postMessage({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
}
