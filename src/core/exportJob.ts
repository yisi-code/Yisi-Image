import type { ExportFormatOption } from './exportFormats'
import { findQualityForTarget, usesTargetSize } from './exportOptions'
import type { ExportOptions } from './exportOptions'
import { CANVAS_SAFE_SIDE } from './layout'
import { encodePngStrips } from './pngStream'
import type { PngSink, PngStripOptions } from './pngStream'
import { canvasToBlob } from './render'
import type { OutputRegion } from './render'

/** 导出对话框里的一项：拼接时是整张拼接图，单图编辑时是列表里的一张。 */
export interface ExportItem {
  id: string
  /** 原文件名，单图导出时换扩展名后作为文件名；拼接导出用时间戳命名 */
  name: string
  width: number
  height: number
  /** 原文件字节数；拼接结果没有原文件，为 0 */
  originalSize: number
  /** 这一项里 AI 清晰化保留的最高倍数（没有时为 1）；导出尺寸低于它时提示放大 */
  detailScale: number
  /** 这一项自己的底色（单图编辑每张图各自设）；没有时用导出对话框的背景 */
  background?: string
  /** 按缩放比例画出导出画布；background 为 null 时保留透明；给 region 时只画输出图里的这一块 */
  render: (scale: number, background: string | null, region?: OutputRegion) => HTMLCanvasElement
}

export interface ExportSummary {
  /** 成功保存的张数 */
  count: number
  /** 保存失败或超出尺寸上限而跳过的文件名 */
  failed: string[]
  /** 批量导出时用户点了「停止」 */
  canceled: boolean
  format: ExportFormatOption
  location: 'file' | 'folder' | 'download'
  totalBefore: number
  totalAfter: number
  /** 单张导出时的输出尺寸；批量时为最后一张，仅供提示 */
  width: number
  height: number
  transparencyDropped: boolean
  /** 目标大小模式下最低质量仍超出目标的张数 */
  unmetTarget: number
}

export interface EncodedImage {
  blob: Blob
  /** 实际使用的质量（0–1）；PNG 为 null */
  quality: number | null
  /** 目标大小模式下是否压到了目标以内；其它模式恒为 true */
  fits: boolean
}

/** 按导出设置编码：目标大小模式自动找质量，否则用滑块质量（PNG 不传质量）。 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: ExportFormatOption,
  options: ExportOptions,
): Promise<EncodedImage> {
  if (usesTargetSize(options)) {
    const result = await findQualityForTarget(
      (quality) => canvasToBlob(canvas, format.mime, quality),
      options.targetKb * 1024,
    )
    return { blob: result.blob, quality: result.quality, fits: result.fits }
  }
  const quality = format.supportsQuality ? options.quality / 100 : undefined
  const blob = await canvasToBlob(canvas, format.mime, quality)
  return { blob, quality: quality ?? null, fits: true }
}

/** 分块导出时一块画布最多这么多像素（约 64 MB 的 RGBA），宽度不超过画布安全档 */
const STRIP_MAX_PIXELS = 16_000_000
const STRIP_MAX_BAND = 4096

/** 每条行带的高度：整行宽 × 带高不超过 STRIP_MAX_PIXELS，至少 1 行。 */
export function stripBandHeight(width: number): number {
  return Math.max(1, Math.min(STRIP_MAX_BAND, Math.floor(STRIP_MAX_PIXELS / Math.max(1, width))))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

/**
 * 超出画布上限的图按行带分块画出、编码成 PNG 写到 sink。
 * 一条行带比画布安全宽度还宽时，再横向分几块画，用 getImageData 拼成整行。
 */
export async function encodeItemAsPngStrips(
  item: ExportItem,
  output: { scale: number; width: number; height: number },
  background: string | null,
  sink: PngSink,
  options: PngStripOptions = {},
): Promise<void> {
  const { width, height, scale } = output
  await encodePngStrips(
    {
      width,
      height,
      bandHeight: stripBandHeight(width),
      async readBand(y, rows) {
        const band = new Uint8ClampedArray(width * rows * 4)
        for (let x = 0; x < width; x += CANVAS_SAFE_SIDE) {
          const tileWidth = Math.min(CANVAS_SAFE_SIDE, width - x)
          const canvas = item.render(scale, background, { x, y, width: tileWidth, height: rows })
          try {
            const context = canvas.getContext('2d')
            if (!context) {
              throw new Error('当前浏览器不支持 Canvas 2D')
            }
            const pixels = context.getImageData(0, 0, tileWidth, rows).data
            for (let r = 0; r < rows; r += 1) {
              band.set(
                pixels.subarray(r * tileWidth * 4, (r + 1) * tileWidth * 4),
                (r * width + x) * 4,
              )
            }
          } finally {
            releaseCanvas(canvas)
          }
        }
        // 让出一帧，进度和「停止」按钮才能刷新。
        await nextFrame()
        return band
      },
    },
    sink,
    options,
  )
}

/** 及早释放大画布占用的显存 / 内存。 */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
}
