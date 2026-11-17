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

export interface StrokeAnnotation extends AnnotationBase {
  type: 'brush' | 'heal'
  points: AnnotationPoint[]
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
