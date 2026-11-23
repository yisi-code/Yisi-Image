import type { SharpenSettings } from './sharpen'
import { WorkerClient } from './workerClient'

/**
 * 清晰化入口：把原图画到画布取出像素，交给 Worker 算，算完画回一张同尺寸的新画布。
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
