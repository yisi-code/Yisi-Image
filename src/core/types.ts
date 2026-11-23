import type { AiSharpenLevel } from './aiUpscale'
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
export type AnnotationTool = 'select' | 'text' | 'brush' | 'eraser' | 'heal'

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
}

/**
 * 对原图做的整体处理（目前只有清晰化）。结果画布替代原图参与预览、导出和修瑕取样，
 * 原图文件不变；对比视图里「原图」一侧仍画 element。
 */
export interface ImageEnhance {
  /** 用哪种方式清晰化的 */
  engine: SharpenEngine
  /** 经典锐化的参数（AI 时记下面板上的经典参数，切回经典时沿用） */
  sharpen: SharpenSettings
  /** AI 清晰化的等级；经典锐化时为空 */
  aiLevel?: AiSharpenLevel
  canvas: HTMLCanvasElement
}

export interface LayoutItem {
  id: string
  x: number
  y: number
  width: number
  height: number
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
