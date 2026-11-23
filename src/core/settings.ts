import { DEFAULT_BACKGROUND, normalizeBackground } from './background'
import type { StitchBackground } from './background'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions } from './exportOptions'
import type { ExportOptions } from './exportOptions'
import { normalizeFloatingPosition } from './floating'
import type { FloatingPosition } from './floating'
import { DEFAULT_GAP, clampGap } from './layout'
import type { AiModelId } from './modelApi'

export type ThumbnailOrientation = 'auto' | 'horizontal' | 'vertical'
export type ThumbnailSize = 'small' | 'medium' | 'large'
export type ThumbnailFit = 'contain' | 'cover' | 'fill'
/** 局部修瑕的补全方式：经典算法（默认，无需下载）或某个 AI 模型。 */
export type HealEngine = 'classic' | AiModelId
/** 工作区：多图拼接，或逐张编辑单张图片 */
export type WorkMode = 'stitch' | 'single'
export { DEFAULT_BACKGROUND, TRANSPARENT_BACKGROUND, normalizeBackground } from './background'
export type { StitchBackground } from './background'

/**
 * 预览区面板（标注栏、缩放栏、空白页尺寸面板、缩略图）的显示状态。
 * collapsed 为 true 时面板从画布隐去，只能从预览标题栏的「显示」开关恢复；
 * position 只有可拖动的工具栏使用，null 表示从未拖动、使用默认位置。
 */
export interface PanelState {
  collapsed: boolean
  position: FloatingPosition | null
}

export interface ToolSettings {
  thumbnailOrientation: ThumbnailOrientation
  thumbnailSize: ThumbnailSize
  thumbnailFit: ThumbnailFit
  /** 拼接间距，与底部控制条同步。 */
  gap: number
  /** 拼接背景，与底部控制条同步。 */
  background: StitchBackground
  annotationToolbar: PanelState
  zoomToolbar: PanelState
  blankPanel: PanelState
  thumbnailPanel: PanelState
  healEngine: HealEngine
  /** 上次使用的工作区，下次打开沿用 */
  workMode: WorkMode
  /** 导出对话框的格式与压缩设置，拼接与单图共用 */
  exportOptions: ExportOptions
}

export type PanelKey = 'annotationToolbar' | 'zoomToolbar' | 'blankPanel' | 'thumbnailPanel'

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

export interface HealEngineOption {
  value: HealEngine
  label: string
  /** 选项右上角的短标签：要不要下载、多大 */
  tag: string
  /** 一句话定位 */
  summary: string
  /** 与其他两种相比的长处 */
  strengths: string[]
  /** 与其他两种相比的短处与代价 */
  limits: string[]
}

/** 三种补全方式及区别；设置页选择时逐条列出，耗时为本机实测量级。 */
export const HEAL_ENGINE_OPTIONS: HealEngineOption[] = [
  {
    value: 'classic',
    label: '经典算法',
    tag: '无需下载',
    summary: '按画面里重复出现的间距整段平移补全',
    strengths: [
      '栏杆、格栅、砖墙等重复结构接得最准',
      '同时给出结构优先、平滑优先两种结果，可一键切换',
      '不用下载，浏览器版也能用',
    ],
    limits: ['不理解画面内容，被挡住的独特物体只能拼出近似', '常见 1–4 秒'],
  },
  {
    value: 'migan',
    label: 'AI · MI-GAN',
    tag: '约 41 MB',
    summary: '轻量 AI 模型，按画面内容补出合理的形状与明暗',
    strengths: ['花瓣、衣物、地面等不规则内容过渡自然', '速度快，常见 1–2 秒', 'MIT 许可'],
    limits: ['细密重复纹理不如经典算法规整，边缘偶尔发软', '需下载模型 26.8 MB + 运行库 14.2 MB'],
  },
  {
    value: 'lama',
    label: 'AI · LaMa',
    tag: '约 213 MB',
    summary: '大型 AI 模型，适合大块缺失与远景',
    strengths: ['大面积缺失、远景和重复纹理更连贯', 'Apache-2.0 许可'],
    limits: [
      '较慢：每次约 7 秒，首次加载模型另需约 6 秒，加载后约占 600 MB 内存',
      '固定按 512 × 512 计算，大区域细节偏软',
      '需下载模型 198.4 MB（运行库与 MI-GAN 共用）',
    ],
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

export const DEFAULT_PANEL_STATE: Readonly<PanelState> = Object.freeze({
  collapsed: false,
  position: null,
})

export const DEFAULT_SETTINGS: Readonly<ToolSettings> = Object.freeze({
  thumbnailOrientation: 'auto',
  thumbnailSize: 'medium',
  thumbnailFit: 'contain',
  gap: DEFAULT_GAP,
  background: DEFAULT_BACKGROUND,
  annotationToolbar: DEFAULT_PANEL_STATE,
  zoomToolbar: DEFAULT_PANEL_STATE,
  blankPanel: DEFAULT_PANEL_STATE,
  thumbnailPanel: DEFAULT_PANEL_STATE,
  healEngine: 'classic',
  workMode: 'stitch',
  exportOptions: DEFAULT_EXPORT_OPTIONS,
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

function isHealEngine(value: unknown): value is HealEngine {
  return value === 'classic' || value === 'migan' || value === 'lama'
}

function normalizeGap(value: unknown): number {
  return typeof value === 'number' ? clampGap(value) : DEFAULT_GAP
}

export function normalizePanelState(value: unknown): PanelState {
  const parsed = (value ?? {}) as Partial<Record<keyof PanelState, unknown>>
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
    background: normalizeBackground(parsed.background),
    annotationToolbar: normalizePanelState(parsed.annotationToolbar),
    zoomToolbar: normalizePanelState(parsed.zoomToolbar),
    blankPanel: normalizePanelState(parsed.blankPanel),
    thumbnailPanel: normalizePanelState(parsed.thumbnailPanel),
    healEngine: isHealEngine(parsed.healEngine) ? parsed.healEngine : DEFAULT_SETTINGS.healEngine,
    workMode: parsed.workMode === 'single' ? 'single' : 'stitch',
    exportOptions: normalizeExportOptions(parsed.exportOptions),
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
