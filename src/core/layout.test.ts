import { describe, expect, it } from 'vitest'
import {
  CANVAS_MAX_SIDE,
  CANVAS_SAFE_AREA,
  CANVAS_SAFE_SIDE,
  WEBP_MAX_SIDE,
  MAX_GAP,
  applyCanvasSize,
  calculateStitchLayout,
  clampDragDelta,
  clampGap,
  inspectOutputSize,
  moveLayer,
  paintOrder,
  snapMove,
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

describe('dragged images and layers', () => {
  it('adds offsets to the automatic slot without changing the canvas size', () => {
    const layout = calculateStitchLayout(
      [images[0], { ...images[1], offsetX: -50, offsetY: 30 }, images[2]],
      'vertical',
      10,
    )
    const plain = calculateStitchLayout(images, 'vertical', 10)
    expect(layout.width).toBe(plain.width)
    expect(layout.height).toBe(plain.height)
    expect(layout.items[1].x).toBe(plain.items[1].x - 50)
    expect(layout.items[1].y).toBe(plain.items[1].y + 30)
    expect(layout.items[2]).toEqual(plain.items[2])
  })

  it('paints by layer, unlayered images on top in queue order', () => {
    const order = paintOrder([
      { id: 'a' },
      { id: 'b', layer: 1 },
      { id: 'c', layer: 0 },
      { id: 'd' },
    ]).map((item) => item.id)
    expect(order).toEqual(['c', 'b', 'a', 'd'])
  })

  it('moves layers and refuses moves past the ends', () => {
    expect(moveLayer(['a', 'b', 'c'], 'a', 'up')).toEqual(['b', 'a', 'c'])
    expect(moveLayer(['a', 'b', 'c'], 'a', 'top')).toEqual(['b', 'c', 'a'])
    expect(moveLayer(['a', 'b', 'c'], 'c', 'bottom')).toEqual(['c', 'a', 'b'])
    expect(moveLayer(['a', 'b', 'c'], 'c', 'up')).toBeNull()
    expect(moveLayer(['a', 'b', 'c'], 'a', 'down')).toBeNull()
    expect(moveLayer(['a', 'b'], 'x', 'up')).toBeNull()
  })

  it('keeps at least a strip of the image inside the canvas', () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 }
    const bounds = { width: 1000, height: 800 }
    expect(clampDragDelta(rect, 50, -20, bounds)).toEqual({ dx: 50, dy: -20 })
    // 往左拖出去：右边至少留 24 px 在画布里
    expect(clampDragDelta(rect, -1000, 0, bounds)).toEqual({ dx: -276, dy: 0 })
    // 往下拖出去：上边留 24 px
    expect(clampDragDelta(rect, 0, 5000, bounds)).toEqual({ dx: 0, dy: 676 })
  })
})

describe('canvas size and snapping', () => {
  it('resizes the canvas and moves content by the anchor', () => {
    const base = calculateStitchLayout(images.slice(0, 2), 'vertical', 0)
    const centered = applyCanvasSize(base, { width: 1400, height: 2000, anchorX: 0.5, anchorY: 0.5 })
    expect(centered.width).toBe(1400)
    expect(centered.height).toBe(2000)
    expect(centered.items[0].x).toBe(base.items[0].x + 100)
    expect(centered.items[0].y).toBe(base.items[0].y + 300)
    const topLeft = applyCanvasSize(base, { width: 800, height: 800, anchorX: 0, anchorY: 0 })
    expect(topLeft.items[1]).toEqual(base.items[1])
    expect(applyCanvasSize(base, null)).toBe(base)
  })

  it('snaps edges to neighbours and canvas within the threshold', () => {
    const moving = { x: 0, y: 0, width: 100, height: 100 }
    const other = { x: 300, y: 50, width: 100, height: 100 }
    const bounds = { width: 1000, height: 1000 }
    // 右边离别人左边 6 px：贴上去
    expect(snapMove(moving, 194, 300, [other], bounds, 8)).toMatchObject({ dx: 200, guideX: 300 })
    // 上边离别人上边 5 px：对齐
    expect(snapMove(moving, 500, 45, [other], bounds, 8)).toMatchObject({ dy: 50, guideY: 50 })
    // 远了不吸
    expect(snapMove(moving, 150, 300, [other], bounds, 8)).toEqual({ dx: 150, dy: 300, guideX: null, guideY: null })
    // 靠近画布右边
    expect(snapMove(moving, 897, 400, [], bounds, 8).dx).toBe(900)
  })
})
