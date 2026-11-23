import type { StitchImage } from './types'

const SUPPORTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-ms-bmp',
])

const SUPPORTED_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i

export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp'

export const SUPPORTED_FORMAT_LABEL = 'JPG、PNG、WebP、GIF、AVIF、BMP'

export function createImageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const FORMAT_LABELS: Array<[RegExp, string]> = [
  [/png$/i, 'PNG'],
  [/jpe?g$/i, 'JPG'],
  [/webp$/i, 'WebP'],
  [/gif$/i, 'GIF'],
  [/avif$/i, 'AVIF'],
  [/bmp$/i, 'BMP'],
]

/** 按 MIME（没有时按扩展名）给出原图格式的短名；认不出时返回空串。 */
export function getFormatLabel(mime: string, fileName: string): string {
  const subtype = mime.toLowerCase().replace(/^image\/(x-ms-)?/, '')
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  for (const candidate of [subtype, extension]) {
    const match = FORMAT_LABELS.find(([pattern]) => pattern.test(candidate))
    if (match) {
      return match[1]
    }
  }
  return ''
}

export function isSupportedImage(file: File): boolean {
  return SUPPORTED_MIME.has(file.type.toLowerCase()) || SUPPORTED_EXTENSION.test(file.name)
}

export async function decodeImageFile(file: File): Promise<StitchImage> {
  const url = URL.createObjectURL(file)
  const element = new Image()
  element.decoding = 'async'
  element.alt = file.name

  try {
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve()
      element.onerror = () => reject(new Error('图片解码失败'))
      element.src = url
    })

    if (element.naturalWidth <= 0 || element.naturalHeight <= 0) {
      throw new Error('图片尺寸无效')
    }

    return {
      id: createImageId(),
      kind: 'image',
      file,
      name: file.name,
      url,
      width: element.naturalWidth,
      height: element.naturalHeight,
      size: file.size,
      element,
      annotations: [],
    }
  } catch (error) {
    element.onload = null
    element.onerror = null
    element.removeAttribute('src')
    URL.revokeObjectURL(url)
    throw error
  }
}

export const DEFAULT_BLANK_WIDTH = 1200
export const DEFAULT_BLANK_HEIGHT = 800

export function createBlankPage(
  name: string,
  width = DEFAULT_BLANK_WIDTH,
  height = DEFAULT_BLANK_HEIGHT,
): StitchImage {
  return {
    id: createImageId(),
    kind: 'blank',
    name,
    url: '',
    width,
    height,
    size: 0,
    backgroundColor: '#ffffff',
    annotations: [],
  }
}

/** 这张图当前的画面：清晰化过就用结果画布，否则用原图；空白页返回 null。 */
export function getImageSource(image: StitchImage): CanvasImageSource | null {
  return image.enhance?.canvas ?? image.element ?? null
}

export function releaseImage(image: StitchImage): void {
  if (image.enhance) {
    // 及早释放清晰化结果占用的内存。
    image.enhance.canvas.width = 0
    image.enhance.canvas.height = 0
    image.enhance = undefined
  }
  if (!image.element) {
    return
  }
  image.element.onload = null
  image.element.onerror = null
  image.element.removeAttribute('src')
  URL.revokeObjectURL(image.url)
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    const value = bytes / 1024
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatDimensions(width: number, height: number): string {
  return `${formatInteger(width)} × ${formatInteger(height)}`
}
