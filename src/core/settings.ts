export type ThumbnailOrientation = 'auto' | 'horizontal' | 'vertical'
export type ThumbnailSize = 'small' | 'medium' | 'large'
export type ThumbnailFit = 'contain' | 'cover' | 'fill'

export interface ToolSettings {
  thumbnailOrientation: ThumbnailOrientation
  thumbnailSize: ThumbnailSize
  thumbnailFit: ThumbnailFit
}

export interface SettingsOption<T extends string> {
  value: T
  label: string
  description: string
}

export const SETTINGS_STORAGE_KEY = 'yisi-image-tool.settings.v1'

export const THUMBNAIL_ORIENTATION_OPTIONS: SettingsOption<ThumbnailOrientation>[] = [
  {
    value: 'auto',
    label: '跟随拼接方向',
    description: '纵向拼接时竖排，横向拼接时横排',
  },
  {
    value: 'horizontal',
    label: '横向排列',
    description: '缩略图始终在预览上方横排',
  },
  {
    value: 'vertical',
    label: '纵向排列',
    description: '缩略图始终在预览右侧竖排',
  },
]

export const THUMBNAIL_SIZE_OPTIONS: SettingsOption<ThumbnailSize>[] = [
  { value: 'small', label: '小', description: '76 × 46 px' },
  { value: 'medium', label: '中', description: '92 × 56 px' },
  { value: 'large', label: '大', description: '112 × 64 px' },
]

export const THUMBNAIL_FIT_OPTIONS: SettingsOption<ThumbnailFit>[] = [
  {
    value: 'contain',
    label: '完整显示长边',
    description: '不裁剪画面，短边留白',
  },
  {
    value: 'cover',
    label: '完整显示短边',
    description: '短边铺满，居中裁剪长边',
  },
  {
    value: 'fill',
    label: '拉伸填满',
    description: '填满缩略图，不保持原比例',
  },
]

export const THUMBNAIL_SIZE_PX: Record<
  ThumbnailSize,
  { width: number; height: number }
> = {
  small: { width: 76, height: 46 },
  medium: { width: 92, height: 56 },
  large: { width: 112, height: 64 },
}

export const DEFAULT_SETTINGS: ToolSettings = {
  thumbnailOrientation: 'auto',
  thumbnailSize: 'medium',
  thumbnailFit: 'contain',
}

function isOrientation(value: unknown): value is ThumbnailOrientation {
  return value === 'auto' || value === 'horizontal' || value === 'vertical'
}

function isSize(value: unknown): value is ThumbnailSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isFit(value: unknown): value is ThumbnailFit {
  return value === 'contain' || value === 'cover' || value === 'fill'
}

export function normalizeSettings(value: unknown): ToolSettings {
  const parsed = (value ?? {}) as Partial<ToolSettings>
  return {
    thumbnailOrientation: isOrientation(parsed.thumbnailOrientation)
      ? parsed.thumbnailOrientation
      : DEFAULT_SETTINGS.thumbnailOrientation,
    thumbnailSize: isSize(parsed.thumbnailSize)
      ? parsed.thumbnailSize
      : DEFAULT_SETTINGS.thumbnailSize,
    thumbnailFit: isFit(parsed.thumbnailFit)
      ? parsed.thumbnailFit
      : DEFAULT_SETTINGS.thumbnailFit,
  }
}

export function loadSettings(): ToolSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_SETTINGS }
    }
    return normalizeSettings(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: ToolSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 浏览器禁用本地存储时，设置只在本次打开期间生效。
  }
}
