import { unsharpMask } from './sharpen'
import type { SharpenSettings } from './sharpen'

/** 在 Worker 里做清晰化，页面不卡；进度与结果按请求 id 回传。 */
interface SharpenRequest {
  id: number
  width: number
  height: number
  rgba: Uint8ClampedArray
  settings: SharpenSettings
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SharpenRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

scope.onmessage = (event) => {
  const { id, width, height, rgba, settings } = event.data
  try {
    const result = unsharpMask(rgba, width, height, settings, (fraction) =>
      scope.postMessage({ id, type: 'progress', fraction }),
    )
    scope.postMessage({ id, type: 'done', rgba: result }, [result.buffer])
  } catch (error) {
    scope.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
