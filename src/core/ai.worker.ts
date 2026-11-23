import * as ort from 'onnxruntime-web/wasm'
import ortGlueUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { LAMA_SIZE, lamaCrop, lamaFeeds, lamaResult, miganFeeds, miganResult } from './aiInpaint'
import { UPSCALE_FACTOR, planTiles, tileToTensor, writeTileResult } from './aiUpscale'

/**
 * 在 Worker 里用 onnxruntime-web（wasm）跑 AI 模型（修瑕、清晰化），页面不卡。
 * wasm 运行库和模型都由 EXE 启动器下载、在 /models/ 下提供；胶水脚本随页面打包。
 * 已加载的会话按模型地址缓存，连续修瑕只加载一次；换模型时释放旧的，避免同时占两份内存；
 * 空闲 IDLE_RELEASE_MS 后也释放（LaMa 加载后约占 600 MB），下次修瑕再重新加载。
 */

const IDLE_RELEASE_MS = 3 * 60 * 1000

interface AiRequest {
  id: number
  /** inpaint：修瑕（默认）；upscale：清晰化；probe：读一个陌生模型的输入要求并试算放大倍数 */
  kind?: 'inpaint' | 'upscale' | 'probe'
  /** 修瑕时是 migan / lama；清晰化时是内置或自定义模型的编号，只用来区分 */
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

interface InputMetadata {
  type?: string
  shape?: ReadonlyArray<number | string>
}

const PROBE_SIZE = 32

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AiRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  crossOriginIsolated?: boolean
  location: Location
}

let loaded: { key: string; session: ort.InferenceSession } | null = null
let idleTimer: ReturnType<typeof setTimeout> | undefined
let running = 0

function scheduleRelease(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (running === 0 && loaded) {
      const session = loaded.session
      loaded = null
      void session.release()
    }
  }, IDLE_RELEASE_MS)
}

function absolute(url: string): string {
  return new URL(url, scope.location.href).href
}

async function getSession(request: AiRequest, report: (fraction: number) => void): Promise<ort.InferenceSession> {
  const key = absolute(request.modelUrl)
  if (loaded?.key === key) {
    return loaded.session
  }
  if (loaded) {
    await loaded.session.release()
    loaded = null
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
  loaded = { key, session }
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

async function run(request: AiRequest, report: (fraction: number) => void): Promise<AiResult | ProbeResult> {
  const session = await getSession(request, report)
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
