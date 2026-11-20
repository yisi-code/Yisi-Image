import type { HealJob } from './heal'
import type { AiModelId } from './modelApi'
import type { HealFill } from './types'

export interface HealFillResult {
  rgba: Uint8ClampedArray
  strategy: HealFill
}

export interface HealResult {
  /** 默认采用的结果 */
  best: HealFillResult
  /** 另一种补法，界面上可一键换用；AI 模型或结构优先无法使用时为 null */
  alternate: HealFillResult | null
  /** 需要告诉用户的说明，例如 AI 模型不可用、这次改用了经典算法 */
  notice?: string
}

/**
 * 这次修瑕用哪种方式。AI 模型只有在启动器确认已下载完时才会是 ai；
 * 设置选了 AI 但模型还不能用时是 classic，并带上要提示用户的 notice。
 */
export type HealEngineChoice =
  | { kind: 'classic'; notice?: string }
  | { kind: 'ai'; model: AiModelId; label: string; modelUrl: string; runtimeUrl: string }

/**
 * 修瑕引擎入口：经典算法与 AI 模型各在自己的 Web Worker 里跑，
 * 两个 Worker 共用一套「按请求 id 回传进度与结果」的协议（WorkerClient）。
 * AI 出错（模型文件损坏、内存不足等）时自动改用经典算法，并在 notice 里说明原因。
 */

interface WorkerMessage {
  id: number
  type: 'progress' | 'done' | 'error'
  fraction?: number
  message?: string
  [key: string]: unknown
}

interface PendingCall {
  resolve: (message: WorkerMessage) => void
  reject: (error: Error) => void
  onProgress?: (fraction: number) => void
}

class WorkerClient {
  private worker: Worker | null = null
  private sequence = 0
  private readonly pending = new Map<number, PendingCall>()

  constructor(
    private readonly create: () => Worker,
    private readonly failureText: string,
  ) {}

  call(
    payload: Record<string, unknown>,
    transfer: Transferable[],
    onProgress?: (fraction: number) => void,
  ): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      this.sequence += 1
      const id = this.sequence
      this.pending.set(id, { resolve, reject, onProgress })
      this.getWorker().postMessage({ ...payload, id }, transfer)
    })
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker
    }
    const worker = this.create()
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data
      const call = this.pending.get(message.id)
      if (!call) {
        return
      }
      if (message.type === 'progress') {
        call.onProgress?.(message.fraction ?? 0)
        return
      }
      this.pending.delete(message.id)
      if (message.type === 'done') {
        call.resolve(message)
      } else {
        call.reject(new Error(message.message || this.failureText))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      const error = new Error(event.message || this.failureText)
      for (const call of this.pending.values()) {
        call.reject(error)
      }
      this.pending.clear()
      worker.terminate()
      this.worker = null
    }
    this.worker = worker
    return worker
  }
}

const classicWorker = new WorkerClient(
  () => new Worker(new URL('./inpaint.worker.ts', import.meta.url), { type: 'module' }),
  '修瑕计算失败',
)

const aiWorker = new WorkerClient(
  () => new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }),
  'AI 修瑕失败',
)

async function runClassic(job: HealJob, onProgress?: (fraction: number) => void): Promise<HealResult> {
  const rgba = new Uint8ClampedArray(job.rgba)
  const mask = new Uint8Array(job.mask)
  const message = await classicWorker.call(
    { width: job.width, height: job.height, rgba, mask },
    [rgba.buffer, mask.buffer],
    onProgress,
  )
  const best = message.best as HealFillResult | undefined
  if (!best) {
    throw new Error('修瑕计算失败')
  }
  return { best, alternate: (message.alternate as HealFillResult | null | undefined) ?? null }
}

async function runAi(
  job: HealJob,
  engine: Extract<HealEngineChoice, { kind: 'ai' }>,
  onProgress?: (fraction: number) => void,
): Promise<HealResult> {
  const rgba = new Uint8ClampedArray(job.rgba)
  const mask = new Uint8Array(job.mask)
  const message = await aiWorker.call(
    {
      model: engine.model,
      modelUrl: engine.modelUrl,
      runtimeUrl: engine.runtimeUrl,
      width: job.width,
      height: job.height,
      rgba,
      mask,
    },
    [rgba.buffer, mask.buffer],
    onProgress,
  )
  if (!(message.rgba instanceof Uint8ClampedArray)) {
    throw new Error('AI 修瑕没有返回结果')
  }
  return { best: { rgba: message.rgba, strategy: 'ai' }, alternate: null }
}

export async function runHeal(
  job: HealJob,
  engine: HealEngineChoice,
  onProgress?: (fraction: number) => void,
): Promise<HealResult> {
  if (engine.kind === 'classic') {
    const result = await runClassic(job, onProgress)
    return engine.notice ? { ...result, notice: engine.notice } : result
  }
  try {
    return await runAi(job, engine, onProgress)
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : '未知错误'
    onProgress?.(0)
    const result = await runClassic(job, onProgress)
    return { ...result, notice: `${engine.label} 修瑕失败（${reason}），这次改用经典算法` }
  }
}
