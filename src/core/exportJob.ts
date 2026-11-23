import type { ExportFormatOption } from './exportFormats'
import { findQualityForTarget, usesTargetSize } from './exportOptions'
import type { ExportOptions } from './exportOptions'
import { canvasToBlob } from './render'

/** 导出对话框里的一项：拼接时是整张拼接图，单图编辑时是列表里的一张。 */
export interface ExportItem {
  id: string
  /** 原文件名，单图导出时换扩展名后作为文件名；拼接导出用时间戳命名 */
  name: string
  width: number
  height: number
  /** 原文件字节数；拼接结果没有原文件，为 0 */
  originalSize: number
  /** 按缩放比例画出导出画布；background 为 null 时保留透明 */
  render: (scale: number, background: string | null) => HTMLCanvasElement
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

/** 及早释放大画布占用的显存 / 内存。 */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
}
