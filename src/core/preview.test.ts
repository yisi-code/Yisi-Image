import { describe, expect, it } from 'vitest'
import { calculateStitchLayout } from './layout'
import {
  clampPreviewOffset,
  getFocusOffset,
  getImageFillZoom,
  getMaxPreviewZoom,
  getPreviewFit,
  keepScaleAfterResize,
} from './preview'

describe('preview geometry', () => {
  it('keeps a single-image layout at fit scale', () => {
    const layout = calculateStitchLayout(
      [{ id: 'one', width: 1600, height: 1200 }],
      'vertical',
      0,
    )
    const fit = getPreviewFit(layout, 800, 400)

    expect(fit.width).toBeCloseTo(533.3333, 4)
    expect(getImageFillZoom(layout.items[0], 800, 400, fit.scale)).toBe(1)
  })

  it('allows one image to fill the viewport when many images are stacked', () => {
    const images = Array.from({ length: 10 }, (_, index) => ({
      id: `image-${index}`,
      width: 100,
      height: 100,
    }))
    const layout = calculateStitchLayout(images, 'vertical', 10)
    const maxZoom = getMaxPreviewZoom(layout, 900, 440)

    expect(maxZoom).toBeGreaterThan(10)
  })

  it('centers the selected image in the viewport', () => {
    const layout = {
      direction: 'vertical' as const,
      gap: 0,
      width: 1000,
      height: 1000,
      items: [
        { id: 'top', x: 0, y: 0, width: 1000, height: 500 },
        { id: 'bottom', x: 0, y: 500, width: 1000, height: 500 },
      ],
    }

    const offset = getFocusOffset(layout.items[1], layout, 0.4, 2)

    expect(offset).toEqual({ x: 0, y: -200 })
  })

  it('leaves a margin around the fitted content', () => {
    const layout = calculateStitchLayout([{ id: 'one', width: 1000, height: 1000 }], 'vertical', 0)
    expect(getPreviewFit(layout, 448, 848, 24).scale).toBeCloseTo(0.4, 6)
    expect(getPreviewFit(layout, 448, 848).scale).toBeCloseTo(0.448, 6)
  })

  it('keeps on-screen scale when a blank page widens a vertical stitch', () => {
    const result = keepScaleAfterResize({
      previousScale: 0.5,
      fitScale: 0.25,
      minZoom: 0.5,
      maxZoom: 8,
      offset: { x: 10, y: 0 },
      direction: 'vertical',
      previousSize: { width: 1600, height: 3000 },
      nextSize: { width: 2400, height: 3000 },
    })
    // 0.25 × 2 = 0.5：其他图片屏幕尺寸不变；只变宽不变高，平移不动。
    expect(result).toEqual({ zoom: 2, offset: { x: 10, y: 0 } })
  })

  it('pins earlier images when a blank page grows along the stitch direction', () => {
    const result = keepScaleAfterResize({
      previousScale: 0.5,
      fitScale: 0.4,
      minZoom: 0.5,
      maxZoom: 8,
      offset: { x: 0, y: -20 },
      direction: 'vertical',
      previousSize: { width: 1600, height: 3000 },
      nextSize: { width: 1600, height: 3400 },
    })
    // 变高 400 px × 0.5 / 2 = 100：补回居中带来的上移。
    expect(result.zoom).toBeCloseTo(1.25, 6)
    expect(result.offset).toEqual({ x: 0, y: 80 })
  })

  it('caps the kept zoom at the maximum', () => {
    const result = keepScaleAfterResize({
      previousScale: 1,
      fitScale: 0.05,
      minZoom: 0.5,
      maxZoom: 6,
      offset: { x: 0, y: 0 },
      direction: 'horizontal',
      previousSize: { width: 4000, height: 800 },
      nextSize: { width: 4000, height: 800 },
    })
    expect(result.zoom).toBe(6)
  })

  it('limits panning so the content cannot leave the viewport', () => {
    expect(clampPreviewOffset({ x: 900, y: -900 }, 1000, 800, 400, 400)).toEqual({
      x: 300,
      y: -200,
    })
  })
})
