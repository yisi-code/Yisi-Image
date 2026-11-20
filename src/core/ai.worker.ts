import * as ort from 'onnxruntime-web/wasm'
import ortGlueUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { LAMA_SIZE, lamaCrop, lamaFeeds, lamaResult, miganFeeds, miganResult } from './aiInpaint'
import type { AiModelId } from './modelApi'

/**
 * 在 Worker 里用 onnxruntime-web（wasm）跑 AI 修瑕模型，页面不卡。
 * wasm 运行库和模型都由 EXE 启动器下载、在 /models/ 下提供；胶水脚本随页面打包。
 * 已加载的会话按模型地址缓存，连续修瑕只加载一次；换模型时释放旧的，避免同时占两份内存；
 * 空闲 IDLE_RELEASE_MS 后也释放（LaMa 加载后约占 600 MB），下次修瑕再重新加载。
 */

const IDLE_RELEASE_MS = 3 * 60 * 1000

interface AiRequest {
  id: number
  model: AiModelId
  modelUrl: string
  runtimeUrl: string
  width: number
  height: number
  rgba: Uint8ClampedArray
  mask: Uint8Array
}

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
  ort.env.wasm.numThreads = scope.crossOriginIsolated
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

async function run(request: AiRequest, report: (fraction: number) => void): Promise<Uint8ClampedArray> {
  const session = await getSession(request, report)
  report(0.35)
  const { width, height, rgba, mask } = request
  if (request.model === 'migan') {
    const feeds = miganFeeds(width, height, rgba, mask)
    const output = await session.run({
      image: new ort.Tensor('uint8', feeds.image, [1, 3, height, width]),
      mask: new ort.Tensor('uint8', feeds.mask, [1, 1, height, width]),
    })
    return miganResult(output[session.outputNames[0]].data as Uint8Array, width, height, rgba, mask)
  }

  const crop = lamaCrop(width, height, mask)
  if (!crop) {
    return new Uint8ClampedArray(rgba)
  }
  const feeds = lamaFeeds(width, rgba, mask, crop)
  const output = await session.run({
    image: new ort.Tensor('float32', feeds.image, [1, 3, LAMA_SIZE, LAMA_SIZE]),
    mask: new ort.Tensor('float32', feeds.mask, [1, 1, LAMA_SIZE, LAMA_SIZE]),
  })
  return lamaResult(output[session.outputNames[0]].data as Float32Array, width, height, rgba, mask, crop)
}

scope.onmessage = (event) => {
  const request = event.data
  const report = (fraction: number): void => scope.postMessage({ id: request.id, type: 'progress', fraction })
  running += 1
  clearTimeout(idleTimer)
  run(request, report)
    .finally(() => {
      running -= 1
      scheduleRelease()
    })
    .then((rgba) => scope.postMessage({ id: request.id, type: 'done', rgba }, [rgba.buffer]))
    .catch((error: unknown) =>
      scope.postMessage({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
}
