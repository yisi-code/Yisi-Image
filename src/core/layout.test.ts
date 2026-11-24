import { describe, expect, it } from 'vitest'
import {
  CANVAS_MAX_SIDE,
  CANVAS_SAFE_AREA,
  CANVAS_SAFE_SIDE,
  WEBP_MAX_SIDE,
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
  it('安全范围内整张画布编码', () => {
    expect(inspectOutputSize(0, 0).ok).toBe(false)
    expect(inspectOutputSize(CANVAS_SAFE_SIDE, 1000)).toMatchObject({ ok: true, mode: 'canvas' })
    expect(inspectOutputSize(10_000, CANVAS_SAFE_AREA / 10_000, 'jpeg')).toMatchObject({
      ok: true,
      mode: 'canvas',
    })
  })

  it('PNG 超出画布安全范围时分块编码，不设上限', () => {
    expect(inspectOutputSize(CANVAS_SAFE_SIDE + 1, 1000)).toMatchObject({ ok: true, mode: 'strips' })
    expect(inspectOutputSize(1554, 200_000, 'png')).toMatchObject({ ok: true, mode: 'strips' })
  })

  it('JPG 用画布硬上限，WebP 用格式上限，超出时提示改用 PNG', () => {
    expect(inspectOutputSize(20_000, 1000, 'jpeg')).toMatchObject({ ok: true, mode: 'canvas' })
    expect(inspectOutputSize(CANVAS_MAX_SIDE + 1, 1000, 'jpeg').ok).toBe(false)
    expect(inspectOutputSize(16_000, 17_000, 'jpeg').ok).toBe(false)
    expect(inspectOutputSize(WEBP_MAX_SIDE + 1, 1000, 'webp').reason).toContain('改用 PNG')
  })

  it('marks large but exportable output', () => {
    const check = inspectOutputSize(9000, 9000)
    expect(check.ok).toBe(true)
    expect(check.isLarge).toBe(true)
  })
})
