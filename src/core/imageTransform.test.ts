import { describe, expect, it } from 'vitest'
import {
  applyCrop,
  cropByHandle,
  displayToSource,
  frameFromTransform,
  frameLayout,
  frameTransform,
  identityTransform,
  moveCrop,
  normalizeTransform,
  resizeByHandle,
  resizeByInput,
  scalePercent,
  sourceToDisplay,
  uncroppedPreview,
} from './imageTransform'

const size = { width: 1000, height: 500 }

describe('imageTransform 坐标换算', () => {
  it('显示坐标与原图坐标往返一致（含裁剪与拉伸）', () => {
    const transform = { crop: { x: 100, y: 50, width: 400, height: 200 }, width: 800, height: 100 }
    const source = displayToSource(transform, { x: 400, y: 50 })
    expect(source).toEqual({ x: 300, y: 150 })
    expect(sourceToDisplay(transform, source)).toEqual({ x: 400, y: 50 })
  })

  it('原样时不保存变换，裁剪区域会被限制在原图内', () => {
    expect(normalizeTransform(size, identityTransform(size))).toBeNull()
    expect(
      normalizeTransform(size, { crop: { x: -20, y: 480, width: 50.4, height: 90 }, width: 3, height: 40 }),
    ).toEqual({ crop: { x: 0, y: 410, width: 50, height: 90 }, width: 8, height: 40 })
  })
})

describe('resizeByHandle', () => {
  it('保持比例：边只看自己的方向，角取变化大的方向', () => {
    expect(resizeByHandle({ width: 400, height: 200 }, 'e', 100, 0, true)).toEqual({ width: 500, height: 250 })
    expect(resizeByHandle({ width: 400, height: 200 }, 'n', 0, -50, true)).toEqual({ width: 500, height: 250 })
    expect(resizeByHandle({ width: 400, height: 200 }, 'sw', 40, 100, true)).toEqual({ width: 600, height: 300 })
  })

  it('不保持比例：宽高各改各的，不小于下限', () => {
    expect(resizeByHandle({ width: 400, height: 200 }, 'se', 100, -50, false)).toEqual({ width: 500, height: 150 })
    expect(resizeByHandle({ width: 400, height: 200 }, 'w', 1000, 0, false)).toEqual({ width: 8, height: 200 })
  })
})

describe('resizeByInput', () => {
  const transform = { crop: { x: 0, y: 0, width: 1000, height: 500 }, width: 500, height: 250 }

  it('保持比例时改一边另一边跟着变，百分比相对裁剪区域', () => {
    expect(resizeByInput(transform, { width: 800 }, true)).toEqual({ width: 800, height: 400 })
    expect(resizeByInput(transform, { height: 100 }, true)).toEqual({ width: 200, height: 100 })
    expect(resizeByInput(transform, { percent: 30 }, true)).toEqual({ width: 300, height: 150 })
    expect(scalePercent(transform)).toBe(50)
  })

  it('不保持比例时只改输入的那一边', () => {
    expect(resizeByInput(transform, { width: 800 }, false)).toEqual({ width: 800, height: 250 })
  })
})

describe('裁剪', () => {
  const start = { x: 100, y: 100, width: 400, height: 200 }

  it('拖边、拖角，限制在原图内', () => {
    expect(cropByHandle(start, 'e', 1000, 0, size, false)).toEqual({ x: 100, y: 100, width: 900, height: 200 })
    expect(cropByHandle(start, 'nw', -50, -200, size, false)).toEqual({ x: 50, y: 0, width: 450, height: 300 })
  })

  it('保持比例：按起始宽高比，超出原图时等比缩回', () => {
    expect(cropByHandle(start, 'se', 100, 0, size, true)).toEqual({ x: 100, y: 100, width: 500, height: 250 })
    const big = cropByHandle(start, 'e', 2000, 0, size, true)
    expect(big.width / big.height).toBeCloseTo(2, 1)
    expect(big.x + big.width).toBeLessThanOrEqual(1000)
    expect(big.y).toBeGreaterThanOrEqual(0)
    expect(big.y + big.height).toBeLessThanOrEqual(500)
  })

  it('整体平移不出界', () => {
    expect(moveCrop(start, 900, -500, size)).toEqual({ x: 600, y: 0, width: 400, height: 200 })
  })

  it('确定裁剪沿用原来的显示比例；进入裁剪时按同比例显示整张原图', () => {
    const transform = { crop: { x: 0, y: 0, width: 1000, height: 500 }, width: 500, height: 250 }
    expect(applyCrop(transform, { x: 200, y: 100, width: 400, height: 200 })).toEqual({
      crop: { x: 200, y: 100, width: 400, height: 200 },
      width: 200,
      height: 100,
    })
    const cropped = { crop: { x: 200, y: 100, width: 400, height: 200 }, width: 200, height: 100 }
    expect(uncroppedPreview(cropped, size)).toEqual({
      crop: { x: 0, y: 0, width: 1000, height: 500 },
      width: 500,
      height: 250,
    })
  })
})

describe('整张拼接图', () => {
  const layoutSize = { width: 1000, height: 2000 }

  it('不裁剪时跟着布局尺寸走，缩放倍数保持', () => {
    const frame = frameFromTransform(layoutSize, { crop: { x: 0, y: 0, width: 1000, height: 2000 }, width: 500, height: 1000 })
    expect(frame).toEqual({ crop: null, scaleX: 0.5, scaleY: 0.5 })
    expect(frameTransform({ width: 1000, height: 3000 }, frame)).toEqual({
      crop: { x: 0, y: 0, width: 1000, height: 3000 },
      width: 500,
      height: 1500,
    })
    expect(frameFromTransform(layoutSize, identityTransform(layoutSize))).toBeNull()
  })

  it('裁剪区域在布局变小时收回来；布局里的每张图按同样的裁剪缩放换算', () => {
    const frame = { crop: { x: 100, y: 1500, width: 800, height: 500 }, scaleX: 0.5, scaleY: 0.5 }
    expect(frameTransform({ width: 1000, height: 1800 }, frame)?.crop).toEqual({ x: 100, y: 1300, width: 800, height: 500 })
    const transform = frameTransform(layoutSize, frame)
    const layout = { width: 1000, height: 2000, items: [{ id: 'a', x: 0, y: 1000, width: 1000, height: 1000 }] }
    expect(frameLayout(layout, transform)).toEqual({
      width: 400,
      height: 250,
      items: [{ id: 'a', x: -50, y: -250, width: 500, height: 500 }],
    })
    expect(frameLayout(layout, null)).toBe(layout)
  })
})
