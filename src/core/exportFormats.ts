export type ExportFormat = 'png' | 'jpeg' | 'webp'

export interface ExportFormatOption {
  value: ExportFormat
  label: string
  longLabel: string
  mime: string
  extension: string
  supportsQuality: boolean
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
    description: 'PNG 图片',
  },
  {
    value: 'jpeg',
    label: 'JPG',
    longLabel: 'JPEG',
    mime: 'image/jpeg',
    extension: 'jpg',
    supportsQuality: true,
    description: 'JPEG 图片',
  },
  {
    value: 'webp',
    label: 'WebP',
    longLabel: 'WebP',
    mime: 'image/webp',
    extension: 'webp',
    supportsQuality: true,
    description: 'WebP 图片',
  },
]

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'png'

export function getExportFormat(value: ExportFormat): ExportFormatOption {
  return EXPORT_FORMATS.find((format) => format.value === value) ?? EXPORT_FORMATS[0]
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
