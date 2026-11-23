import { DEFAULT_BACKGROUND, TRANSPARENT_BACKGROUND } from './settings'
import type { StitchBackground } from './settings'

export type ExportFormat = 'png' | 'jpeg' | 'webp'

export interface ExportFormatOption {
  value: ExportFormat
  label: string
  longLabel: string
  mime: string
  extension: string
  supportsQuality: boolean
  /** 能否保留透明通道；JPEG 不能，透明背景导出时改用白底 */
  supportsAlpha: boolean
  description: string
}

export const EXPORT_QUALITY = 0.92

export const EXPORT_FORMATS: readonly ExportFormatOption[] = [
  {
    value: 'png',
    label: 'PNG',
    longLabel: 'PNG',
    mime: 'image/png',
    extension: 'png',
    supportsQuality: false,
    supportsAlpha: true,
    description: 'PNG 图片',
  },
  {
    value: 'jpeg',
    label: 'JPG',
    longLabel: 'JPEG',
    mime: 'image/jpeg',
    extension: 'jpg',
    supportsQuality: true,
    supportsAlpha: false,
    description: 'JPEG 图片',
  },
  {
    value: 'webp',
    label: 'WebP',
    longLabel: 'WebP',
    mime: 'image/webp',
    extension: 'webp',
    supportsQuality: true,
    supportsAlpha: true,
    description: 'WebP 图片',
  },
]

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'png'

export function getExportFormat(value: ExportFormat): ExportFormatOption {
  return EXPORT_FORMATS.find((format) => format.value === value) ?? EXPORT_FORMATS[0]
}

/** 透明背景遇到不支持透明的格式时会被改成白底。 */
export function isTransparencyDropped(
  background: StitchBackground,
  format: ExportFormatOption,
): boolean {
  return background === TRANSPARENT_BACKGROUND && !format.supportsAlpha
}

/** 导出画布的底色；null 表示不填充、保留透明。 */
export function getExportBackground(
  background: StitchBackground,
  format: ExportFormatOption,
): string | null {
  if (background !== TRANSPARENT_BACKGROUND) {
    return background
  }
  return format.supportsAlpha ? null : DEFAULT_BACKGROUND
}

export function getSaveTypes(format: ExportFormatOption): Array<{
  description: string
  accept: Record<string, string[]>
}> {
  const extensions =
    format.value === 'jpeg' ? ['.jpg', '.jpeg'] : [`.${format.extension}`]
  return [
    {
      description: format.description,
      accept: { [format.mime]: extensions },
    },
  ]
}

export function buildExportFileName(date: Date, format: ExportFormat): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('')
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
  return `拼接图片-${stamp}-${time}.${getExportFormat(format).extension}`
}

function supportsMime(mime: string): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  return canvas.toDataURL(mime).startsWith(`data:${mime}`)
}

/** 只展示当前浏览器实际能编码的格式，PNG 始终可用。 */
export function getSupportedExportFormats(): ExportFormatOption[] {
  return EXPORT_FORMATS.filter(
    (format) => format.value === 'png' || supportsMime(format.mime),
  )
}
