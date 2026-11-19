import { normalizeFloatingPosition } from './floating'
import type { FloatingPosition } from './floating'
import { DEFAULT_GAP, clampGap } from './layout'

export type ThumbnailOrientation = 'auto' | 'horizontal' | 'vertical'
export type ThumbnailSize = 'small' | 'medium' | 'large'
export type ThumbnailFit = 'contain' | 'cover' | 'fill'

/** 预览区浮动工具栏的显示状态；position 为 null 表示从未拖动，使用默认位置。 */
export interface ToolbarState {
  collapsed: boolean
  position: FloatingPosition | null
}

export interface ToolSettings {
  thumbnailOrientation: ThumbnailOrientation
  thumbnailSize: ThumbnailSize
  thumbnailFit: ThumbnailFit
  /** 拼接间距，与底部控制条同步。 */
  gap: number
  annotationToolbar: ToolbarState
  zoomToolbar: ToolbarState
}

export type ToolbarKey = 'annotationToolbar' | 'zoomToolbar'

export interface SettingsOption<T extends string> {
  value: T
  label: string
  description: string
}

/** 浏览器开发模式（没有 EXE 启动器）下的存储键；EXE 首次读取时也从这里迁移旧设置。 */
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

export const DEFAULT_TOOLBAR_STATE: Readonly<ToolbarState> = Object.freeze({
  collapsed: false,
  position: null,
})

export const DEFAULT_SETTINGS: Readonly<ToolSettings> = Object.freeze({
  thumbnailOrientation: 'auto',
  thumbnailSize: 'medium',
  thumbnailFit: 'contain',
  gap: DEFAULT_GAP,
  annotationToolbar: DEFAULT_TOOLBAR_STATE,
  zoomToolbar: DEFAULT_TOOLBAR_STATE,
})

function isOrientation(value: unknown): value is ThumbnailOrientation {
  return value === 'auto' || value === 'horizontal' || value === 'vertical'
}

function isSize(value: unknown): value is ThumbnailSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isFit(value: unknown): value is ThumbnailFit {
  return value === 'contain' || value === 'cover' || value === 'fill'
}

function normalizeGap(value: unknown): number {
  return typeof value === 'number' ? clampGap(value) : DEFAULT_GAP
}

export function normalizeToolbarState(value: unknown): ToolbarState {
  const parsed = (value ?? {}) as Partial<Record<keyof ToolbarState, unknown>>
  return {
    collapsed: parsed.collapsed === true,
    position: normalizeFloatingPosition(parsed.position),
  }
}

/** 逐项校验，返回全新对象；空值得到一份新的默认设置。 */
export function normalizeSettings(value: unknown): ToolSettings {
  const parsed = (value ?? {}) as Partial<Record<keyof ToolSettings, unknown>>
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
    gap: normalizeGap(parsed.gap),
    annotationToolbar: normalizeToolbarState(parsed.annotationToolbar),
    zoomToolbar: normalizeToolbarState(parsed.zoomToolbar),
  }
}

/** 读取浏览器 localStorage 里的设置；没有或损坏时返回 null。 */
export function readBrowserSettings(): ToolSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) {
      return null
    }
    return normalizeSettings(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function writeBrowserSettings(settings: ToolSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 浏览器禁用本地存储时，设置只在本次打开期间生效。
  }
}

/** EXE 把旧设置迁移进配置文件后删除浏览器里的副本，避免以后误读过期数据。 */
export function clearBrowserSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
  } catch {
    // 忽略存储不可用。
  }
}
