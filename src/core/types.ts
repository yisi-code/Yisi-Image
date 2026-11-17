export type StitchDirection = 'vertical' | 'horizontal'

export interface StitchImage {
  id: string
  file: File
  name: string
  url: string
  width: number
  height: number
  size: number
  element: HTMLImageElement
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
