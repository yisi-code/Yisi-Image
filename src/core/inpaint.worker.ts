import { inpaintBoth } from './inpaint'

/** 在 Worker 里跑经典修瑕算法，页面不卡；两种补法的结果与进度按请求 id 回传。 */
interface InpaintRequest {
  id: number
  width: number
  height: number
  rgba: Uint8ClampedArray
  mask: Uint8Array
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InpaintRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

scope.onmessage = (event) => {
  const { id, width, height, rgba, mask } = event.data
  try {
    const { best, alternate } = inpaintBoth({
      width,
      height,
      rgba,
      mask,
      seed: 1,
      onProgress: (fraction) => scope.postMessage({ id, type: 'progress', fraction }),
    })
    scope.postMessage(
      {
        id,
        type: 'done',
        best: { rgba: best.rgba, strategy: best.strategy },
        alternate: alternate ? { rgba: alternate.rgba, strategy: alternate.strategy } : null,
      },
      alternate ? [best.rgba.buffer, alternate.rgba.buffer] : [best.rgba.buffer],
    )
  } catch (error) {
    scope.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
