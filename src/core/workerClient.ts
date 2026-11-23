/**
 * Web Worker 调用封装：按请求 id 回传进度与结果，修瑕与清晰化共用。
 * Worker 崩溃（onerror）时让所有等待中的请求失败，下次调用重新创建 Worker。
 */
export interface WorkerMessage {
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

export class WorkerClient {
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
