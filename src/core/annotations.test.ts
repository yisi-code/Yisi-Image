import { describe, expect, it } from 'vitest'
import { cloneAnnotations, eraseAnnotationsAt } from './annotations'
import { createBlankPage, DEFAULT_BLANK_HEIGHT, DEFAULT_BLANK_WIDTH } from './image'
import type { StrokeAnnotation } from './types'

function stroke(points: StrokeAnnotation['points']): StrokeAnnotation {
  return {
    id: 'stroke-1',
    type: 'brush',
    points,
    color: '#d92d20',
    width: 10,
  }
}

describe('createBlankPage', () => {
  it('creates a white blank page with default size', () => {
    const page = createBlankPage('空白页 1')
    expect(page.kind).toBe('blank')
    expect(page.width).toBe(DEFAULT_BLANK_WIDTH)
    expect(page.height).toBe(DEFAULT_BLANK_HEIGHT)
    expect(page.backgroundColor).toBe('#ffffff')
    expect(page.annotations).toEqual([])
    expect(page.element).toBeUndefined()
  })

  it('keeps a custom size', () => {
    const page = createBlankPage('空白页 2', 900, 600)
    expect(page.width).toBe(900)
    expect(page.height).toBe(600)
  })
})

describe('annotation helpers', () => {
  it('erases strokes under the eraser point and keeps far strokes', () => {
    const first = stroke([
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ])
    const second = { ...stroke([{ x: 200, y: 200 }]), id: 'stroke-2' }
    const kept = eraseAnnotationsAt([first, second], { x: 50, y: 22 }, 10)
    expect(kept.map((annotation) => annotation.id)).toEqual(['stroke-2'])
  })

  it('clones stroke points without sharing the point objects', () => {
    const source = [stroke([{ x: 1, y: 2 }])]
    const cloned = cloneAnnotations(source)
    expect(cloned).not.toBe(source)
    expect(cloned[0]).not.toBe(source[0])
    if (cloned[0].type !== 'brush') {
      throw new Error('expected brush clone')
    }
    expect(cloned[0].points[0]).not.toBe(source[0].points[0])
    expect(cloned[0].points[0]).toEqual({ x: 1, y: 2 })
  })
})
