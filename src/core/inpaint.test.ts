import { describe, expect, it } from 'vitest'
import { inpaint, inpaintBoth, inpaintDetailed } from './inpaint'

/** 浅色背景上每 12 px 一根 4 px 宽的深色竖栏杆。 */
function railing(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const bar = x % 12 < 4
      rgba[i] = bar ? 40 : 210
      rgba[i + 1] = bar ? 50 : 220
      rgba[i + 2] = bar ? 60 : 235
      rgba[i + 3] = 255
    }
  }
  return rgba
}

/** 在中间盖一块「塑料袋」，返回被遮挡的图与遮罩。 */
function occlude(truth: Uint8ClampedArray, width: number, x0: number, y0: number, size: number) {
  const rgba = new Uint8ClampedArray(truth)
  const mask = new Uint8Array(truth.length / 4)
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) {
      const p = y * width + x
      mask[p] = 1
      rgba[p * 4] = 250
      rgba[p * 4 + 1] = 30
      rgba[p * 4 + 2] = 160
    }
  }
  return { rgba, mask }
}

function holeError(result: Uint8ClampedArray, truth: Uint8ClampedArray, mask: Uint8Array): number {
  let sum = 0
  let count = 0
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) {
      continue
    }
    for (let c = 0; c < 3; c += 1) {
      sum += Math.abs(result[p * 4 + c] - truth[p * 4 + c])
    }
    count += 3
  }
  return sum / count
}

describe('inpaint', () => {
  const width = 120
  const height = 96
  const truth = railing(width, height)
  const { rgba, mask } = occlude(truth, width, 44, 30, 28)

  it('补出被遮挡的栏杆，误差远小于用平均色抹平', () => {
    const result = inpaint({ width, height, rgba, mask, seed: 7 })
    // 只用背景与栏杆的平均色填洞（相当于模糊抹平）的误差作为对照。
    const flat = new Uint8ClampedArray(rgba)
    for (let p = 0; p < mask.length; p += 1) {
      if (mask[p]) {
        flat[p * 4] = (40 * 4 + 210 * 8) / 12
        flat[p * 4 + 1] = (50 * 4 + 220 * 8) / 12
        flat[p * 4 + 2] = (60 * 4 + 235 * 8) / 12
      }
    }
    const error = holeError(result, truth, mask)
    const flatError = holeError(flat, truth, mask)
    expect(error).toBeLessThan(flatError * 0.5)
    expect(error).toBeLessThan(30)
  })

  it('遮罩外的像素保持不变', () => {
    const result = inpaint({ width, height, rgba, mask, seed: 7 })
    for (let p = 0; p < mask.length; p += 1) {
      if (!mask[p]) {
        expect(result[p * 4]).toBe(rgba[p * 4])
        expect(result[p * 4 + 2]).toBe(rgba[p * 4 + 2])
      }
    }
  })

  it('同一种子结果相同；没有遮罩时原样返回', () => {
    const a = inpaint({ width, height, rgba, mask, seed: 3 })
    const b = inpaint({ width, height, rgba, mask, seed: 3 })
    expect(Array.from(a)).toEqual(Array.from(b))
    const untouched = inpaint({ width, height, rgba, mask: new Uint8Array(mask.length) })
    expect(Array.from(untouched)).toEqual(Array.from(rgba))
  })

  it('auto 两种策略都算，取更连贯（差异更小）的那个', () => {
    const structure = inpaintDetailed({ width, height, rgba, mask, seed: 5, strategy: 'structure' })
    const smooth = inpaintDetailed({ width, height, rgba, mask, seed: 5, strategy: 'smooth' })
    const auto = inpaintDetailed({ width, height, rgba, mask, seed: 5 })
    const better = structure.energy <= smooth.energy ? structure : smooth
    expect(auto.strategy).toBe(better.strategy)
    expect(auto.energy).toBeCloseTo(Math.min(structure.energy, smooth.energy), 6)
    expect(Array.from(auto.rgba)).toEqual(Array.from(better.rgba))
  })

  it('结构优先：洞比栏杆间距宽好几倍，也能按间距把栏杆完整平移进来', () => {
    const wide = 160
    const tall = 100
    const wideTruth = railing(wide, tall)
    const hole = occlude(wideTruth, wide, 56, 28, 44)
    const result = inpaintDetailed({ width: wide, height: tall, ...hole, seed: 2, strategy: 'structure' })
    expect(result.strategy).toBe('structure')
    expect(holeError(result.rgba, wideTruth, hole.mask)).toBeLessThan(3)
  })

  it('整张图都要补、无处可借时，结构优先放弃，只返回平滑优先', () => {
    const all = new Uint8Array(width * height).fill(1)
    const { best, alternate } = inpaintBoth({ width, height, rgba, mask: all, seed: 1 })
    expect(best.strategy).toBe('smooth')
    expect(alternate).toBeNull()
  })

  it('报告进度并以 1 结束', () => {
    const progress: number[] = []
    inpaint({ width, height, rgba, mask, seed: 1, onProgress: (value) => progress.push(value) })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toBeCloseTo(1, 6)
  })
})
