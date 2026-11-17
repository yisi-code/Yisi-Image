import { describe, expect, it } from 'vitest'
import { calculateStitchLayout } from './layout'
import {
  clampPreviewOffset,
  getFocusOffset,
  getImageFillZoom,
  getMaxPreviewZoom,
  getPreviewFit,
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

  it('limits panning so the content cannot leave the viewport', () => {
    expect(clampPreviewOffset({ x: 900, y: -900 }, 1000, 800, 400, 400)).toEqual({
      x: 300,
      y: -200,
    })
  })
})
