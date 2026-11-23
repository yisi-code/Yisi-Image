import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHARPEN,
  boxSizesForGauss,
  isSharpenNoop,
  normalizeSharpen,
  unsharpMask,
} from './sharpen'

/** 生成 width × height 的灰度图：左半边 left，右半边 right。 */
function stepImage(width: number, height: number, left: number, right: number, alpha = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < width / 2 ? left : right
      const index = (y * width + x) * 4
      rgba[index] = value
      rgba[index + 1] = value
      rgba[index + 2] = value
      rgba[index + 3] = alpha
    }
  }
  return rgba
}

describe('boxSizesForGauss', () => {
  it('返回奇数盒宽，σ 越大盒越宽', () => {
    const small = boxSizesForGauss(1)
    const large = boxSizesForGauss(4)
    expect(small).toHaveLength(3)
    expect([...small, ...large].every((size) => size % 2 === 1)).toBe(true)
    expect(Math.max(...large)).toBeGreaterThan(Math.max(...small))
  })
})

describe('normalizeSharpen', () => {
  it('非法值回退默认，越界值收进范围', () => {
    expect(normalizeSharpen(null)).toEqual(DEFAULT_SHARPEN)
    expect(normalizeSharpen({ amount: 999, radius: 0.1, threshold: -5 })).toEqual({
      amount: 300,
      radius: 0.8,
      threshold: 0,
    })
    expect(normalizeSharpen({ amount: 80, radius: 1.26, threshold: 3 }).radius).toBe(1.3)
  })

  it('强度 0 视为不处理', () => {
    expect(isSharpenNoop({ ...DEFAULT_SHARPEN, amount: 0 })).toBe(true)
    expect(isSharpenNoop(DEFAULT_SHARPEN)).toBe(false)
  })
})

describe('unsharpMask', () => {
  it('纯色图不变', () => {
    const flat = stepImage(16, 8, 120, 120)
    expect(unsharpMask(flat, 16, 8, DEFAULT_SHARPEN)).toEqual(flat)
  })

  it('边缘两侧对比加强：暗侧更暗、亮侧更亮', () => {
    const width = 32
    const edge = stepImage(width, 4, 80, 160)
    const result = unsharpMask(edge, width, 4, { amount: 150, radius: 1.5, threshold: 0 })
    const darkSide = (1 * width + width / 2 - 1) * 4
    const brightSide = (1 * width + width / 2) * 4
    expect(result[darkSide]).toBeLessThan(80)
    expect(result[brightSide]).toBeGreaterThan(160)
    // 远离边缘的地方不动
    expect(result[(1 * width + 1) * 4]).toBe(80)
  })

  it('透明度原样保留，强度 0 时完全不变', () => {
    const edge = stepImage(16, 4, 30, 220, 77)
    const result = unsharpMask(edge, 16, 4, { amount: 200, radius: 2, threshold: 0 })
    for (let index = 3; index < result.length; index += 4) {
      expect(result[index]).toBe(77)
    }
    expect(unsharpMask(edge, 16, 4, { amount: 0, radius: 2, threshold: 0 })).toEqual(edge)
  })

  it('差值小于阈值的细微起伏不加强', () => {
    const soft = stepImage(32, 4, 100, 104)
    expect(unsharpMask(soft, 32, 4, { amount: 200, radius: 1.5, threshold: 10 })).toEqual(soft)
  })
})
