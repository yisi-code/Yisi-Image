import { WorkerClient } from './workerClient'
import type { WorkerMessage } from './workerClient'

/**
 * 修瑕与清晰化共用同一个 AI Worker：同一时间只加载一个模型（Worker 里换模型时先释放旧的），
 * 避免两份模型同时占内存。
 *
 * 多线程兜底：页面跨源隔离时 onnxruntime 默认开多线程，但有的浏览器（实测 Claude 桌面版内置浏览器）
 * 开多线程后创建会话会一直卡住。模型读完（进度 0.2）后若 SESSION_STALL_MS 内没有下一步进度，
 * 就结束 Worker、记下「多线程不可用」，改单线程重跑这一次；之后都用单线程。
 */
const aiWorker = new WorkerClient(
  () => new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }),
  'AI 计算失败',
)

const MODEL_LOADED = 0.2
const SESSION_STALL_MS = 30_000

let threadsBroken = false

/** 用户点了「停止」：结束 Worker，正在跑和排队的 AI 请求都以它失败。 */
export class AiCanceledError extends Error {
  constructor() {
    super('已停止')
    this.name = 'AiCanceledError'
  }
}

export function cancelAiJobs(): void {
  aiWorker.reset(new AiCanceledError())
}

class SessionStallError extends Error {
  constructor() {
    super('AI 模型加载卡住，改用单线程重试')
    this.name = 'SessionStallError'
  }
}

function attempt(
  payload: Record<string, unknown>,
  transfer: Transferable[],
  threads: boolean,
  onProgress?: (fraction: number) => void,
): Promise<WorkerMessage> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return aiWorker
    .call({ ...payload, threads }, transfer, (fraction) => {
      if (threads && fraction >= MODEL_LOADED && fraction < MODEL_LOADED + 0.001 && timer === undefined) {
        timer = setTimeout(() => aiWorker.reset(new SessionStallError()), SESSION_STALL_MS)
      } else if (fraction > MODEL_LOADED + 0.001) {
        clearTimeout(timer)
      }
      onProgress?.(fraction)
    })
    .finally(() => clearTimeout(timer))
}

export interface AiCall {
  payload: Record<string, unknown>
  transfer: Transferable[]
}

/**
 * 调用 AI Worker。build 每次尝试都会调用一次，要返回新的像素副本（会被转移给 Worker）；
 * 多线程卡住时用它重新拼一份请求，改单线程重跑。
 */
export async function callAi(
  build: () => AiCall,
  onProgress?: (fraction: number) => void,
): Promise<WorkerMessage> {
  if (!threadsBroken) {
    const first = build()
    try {
      return await attempt(first.payload, first.transfer, true, onProgress)
    } catch (error) {
      if (!(error instanceof SessionStallError)) {
        throw error
      }
      threadsBroken = true
      onProgress?.(0)
    }
  }
  const retry = build()
  return attempt(retry.payload, retry.transfer, false, onProgress)
}
