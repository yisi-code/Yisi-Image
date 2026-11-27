import type { AiSharpenLevel } from './aiUpscale'
import type { ContentTransform } from './imageTransform'
import type { SharpenEngine } from './settings'
import type { SharpenSettings } from './sharpen'

export type StitchDirection = 'vertical' | 'horizontal'
export type StitchImageKind = 'image' | 'blank'

export interface AnnotationPoint {
  x: number
  y: number
}

interface AnnotationBase {
  id: string
  color: string
  width: number
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text'
  x: number
  y: number
  text: string
  fontSize: number
}

/**
 * 修瑕结果：只有涂抹区域不透明（边缘羽化）的补丁画布，按图片原分辨率生成。
 * 画在原图之上，原图文件不变；撤销 / 重做时与标注一起整体替换，补丁本身只读。
 */
export interface HealPatch {
  x: number
  y: number
  width: number
  height: number
  canvas: HTMLCanvasElement
}

/** 修瑕补法：结构优先适合栏杆、窗格等直线重复结构；平滑优先适合天空、渐变、曲面；ai 为 AI 模型的结果。 */
export type HealFill = 'structure' | 'smooth' | 'ai'

export interface StrokeAnnotation extends AnnotationBase {
  type: 'brush' | 'heal'
  points: AnnotationPoint[]
  /** 修瑕计算完成后的补丁；计算中为空，此时预览只显示半透明涂抹范围 */
  patch?: HealPatch
  /** 当前补丁用的补法 */
  fill?: HealFill
  /** 另一种补法的补丁，界面上可一键换用 */
  alternatePatch?: HealPatch
}

export type StitchAnnotation = TextAnnotation | StrokeAnnotation
export type AnnotationTool = 'select' | 'text' | 'brush' | 'eraser' | 'heal' | 'cutout' | 'adjust'

export interface StitchImage {
  id: string
  kind: StitchImageKind
  file?: File
  name: string
  url: string
  width: number
  height: number
  size: number
  element?: HTMLImageElement
  backgroundColor?: string
  annotations: StitchAnnotation[]
  /** 清晰化结果：与原图同尺寸的画布；没有处理过时为空 */
  enhance?: ImageEnhance
  /**
   * 缩放与裁剪（「调整」工具）：取原图里 crop 这块，显示 / 导出成 width × height。
   * 没有时就是整张原图、原尺寸；width、height 仍是原图尺寸，标注与修瑕都在原图坐标里。空白页不用。
   */
  transform?: ContentTransform
  /**
   * 拼接时用「调整」工具拖出的位移（拼接布局像素，相对按方向自动排好的位置）；没有时在原位。
   * 画布大小不跟着变，拖出画布的部分被裁掉。单图编辑不用。
   */
  position?: { x: number; y: number }
  /** 拼接时的图层：越大越靠上；没有时按队列顺序画在设过图层的图片之上 */
  layer?: number
  /**
   * 抠图 / 去除背景的结果：原图尺寸的透明度遮罩，与清晰化结果一起决定画面（原图文件不变）。
   * 没有时整张不透明。
   */
  matte?: ImageMatte
  /** 单图编辑时这张图透明处填的底色（`transparent` 或 `#rrggbb`）；没有时保持透明 */
  editBackground?: string
}

/** 抠图 / 去除背景的遮罩：mask 的 alpha 通道就是保留程度（0 去掉，255 保留），尺寸等于原图。 */
export interface ImageMatte {
  /** 最近一次是怎么得到的：去除背景，或点选抠图 */
  source: 'remove-background' | 'cutout'
  mask: HTMLCanvasElement
}

/**
 * 对原图做的整体处理（目前只有清晰化）。结果画布替代原图参与预览、导出和修瑕取样，
 * 原图文件不变；对比视图里「原图」一侧仍画 element。结果画布可能比原图大（见 resolution）。
 */
export interface ImageEnhance {
  /** 用哪种方式清晰化的 */
  engine: SharpenEngine
  /** 经典锐化的参数（AI 时记下面板上的经典参数，切回经典时沿用） */
  sharpen: SharpenSettings
  /** AI 清晰化的等级；经典锐化时为空 */
  aiLevel?: AiSharpenLevel
  /** AI 清晰化用的模型编号；经典锐化时为空 */
  model?: string
  /**
   * 结果画布是原图的几倍：经典锐化恒为 1；AI 可保留 2 倍、4 倍细节，
   * 图片在画布上的大小不变，导出时把尺寸放大才用得上。
   */
  resolution: number
  canvas: HTMLCanvasElement
}

export interface LayoutItem {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** 图层（见 StitchImage.layer）；绘制与点选按 paintOrder 排序 */
  layer?: number
}

export interface StitchLayout {
  direction: StitchDirection
  gap: number
  width: number
  height: number
  items: LayoutItem[]
}

export interface ImportProgress {
  done: number
  total: number
}

export interface ImportReport {
  added: number
  skipped: string[]
  failed: string[]
  busy: boolean
}
