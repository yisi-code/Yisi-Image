import { describe, expect, it } from 'vitest'
import {
  MAX_EXPORT_AREA,
  MAX_EXPORT_SIDE,
  MAX_GAP,
  calculateStitchLayout,
  clampGap,
  inspectOutputSize,
} from './layout'

const images = [
  { id: 'a', width: 1200, height: 800 },
  { id: 'b', width: 800, height: 600 },
  { id: 'c', width: 1600, height: 1200 },
]

describe('clampGap', () => {
  it('keeps values inside the supported range', () => {
    expect(clampGap(24)).toBe(24)
    expect(clampGap(-10)).toBe(0)
    expect(clampGap(MAX_GAP + 20)).toBe(MAX_GAP)
    expect(clampGap(12.6)).toBe(13)
  })

  it('falls back to the default for invalid input', () => {
    expect(clampGap(Number.NaN)).toBe(24)
  })
})

describe('calculateStitchLayout', () => {
  it('returns an empty layout without images', () => {
    expect(calculateStitchLayout([], 'vertical', 20)).toEqual({
      direction: 'vertical',
      gap: 20,
      width: 0,
      height: 0,
      items: [],
    })
  })

  it('stacks images vertically and centers narrower images', () => {
    const layout = calculateStitchLayout(images, 'vertical', 20)

    expect(layout.width).toBe(1600)
    expect(layout.height).toBe(800 + 600 + 1200 + 40)
    expect(layout.items).toEqual([
      { id: 'a', x: 200, y: 0, width: 1200, height: 800 },
      { id: 'b', x: 400, y: 820, width: 800, height: 600 },
      { id: 'c', x: 0, y: 1440, width: 1600, height: 1200 },
    ])
  })

  it('places images side by side and centers shorter images', () => {
    const layout = calculateStitchLayout(
      [
        { id: 'left', width: 1200, height: 800 },
        { id: 'right', width: 800, height: 1000 },
      ],
      'horizontal',
      12,
    )

    expect(layout.width).toBe(2012)
    expect(layout.height).toBe(1000)
    expect(layout.items).toEqual([
      { id: 'left', x: 0, y: 100, width: 1200, height: 800 },
      { id: 'right', x: 1212, y: 0, width: 800, height: 1000 },
    ])
  })

  it('uses the clamped gap in both layout and output size', () => {
    const layout = calculateStitchLayout(images.slice(0, 2), 'vertical', -8)

    expect(layout.gap).toBe(0)
    expect(layout.height).toBe(1400)
    expect(layout.items[1]?.y).toBe(800)
  })
})

describe('inspectOutputSize', () => {
  it('rejects empty output and oversized sides', () => {
    expect(inspectOutputSize(0, 0).ok).toBe(false)
    expect(inspectOutputSize(MAX_EXPORT_SIDE, 1000).ok).toBe(true)
    expect(inspectOutputSize(MAX_EXPORT_SIDE + 1, 1000).ok).toBe(false)
  })

  it('rejects output above the safe pixel area', () => {
    expect(inspectOutputSize(10_000, MAX_EXPORT_AREA / 10_000).ok).toBe(true)
    expect(inspectOutputSize(10_001, MAX_EXPORT_AREA / 10_000).ok).toBe(false)
  })

  it('marks large but exportable output', () => {
    const check = inspectOutputSize(9000, 9000)
    expect(check.ok).toBe(true)
    expect(check.isLarge).toBe(true)
  })
})
